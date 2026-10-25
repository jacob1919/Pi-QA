/**
 * Context Aggregator — collapses every turn of the current session branch into
 * one overlay window: your input plus the final assistant reply of each turn.
 *
 * Trigger:
 *   - Shortcut: Alt+A
 *   - Command:  /aggregate
 *
 * Aggregation rules:
 *   - Source is ctx.sessionManager.getBranch() — the active branch, without
 *     abandoned branches.
 *   - One turn = everything between two consecutive user messages.
 *   - Only the leading user input and the last assistant text of a turn are
 *     kept; intermediate assistant messages (e.g. short notes before tool
 *     calls) are dropped.
 *   - Tool calls, thinking blocks, system messages, tool results, branch
 *     summaries and compaction summaries do not participate.
 *
 * Display rules:
 *   - Compact layout: no role labels, no blank lines between blocks.
 *   - User input in bold green; green separator lines between turns and
 *     between a turn's input and its output.
 *   - Assistant output rendered as Markdown (same as in the session view).
 *   - Centered overlay window, keyboard + mouse-wheel scrolling, q/Esc closes.
 *
 * Copy: the overlay floats above the session, while terminal mouse selection
 * is screen-level — dragging across the window border also selects the session
 * text underneath. So `y` copies the full plain text (no ANSI, no borders, no
 * window-width wrapping) through copyToClipboard; SSH sessions automatically
 * fall back to OSC 52 so the text lands on the local clipboard.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

/**
 * Window sizing. WIDTH_PCT/HEIGHT_PCT must stay in sync with the overlay
 * options in showAggregateWindow(); the same integer math pi-tui applies to
 * percentage sizes (floor(n * pct / 100)) is used for every derived size so
 * the component can never disagree with the overlay.
 */
const WIDTH_PCT = 92;
const HEIGHT_PCT = 85;
/** Maximum window width in columns. */
const MAX_WINDOW_WIDTH = 120;
/** One column of inner padding on each side, plus the left/right borders. */
const H_PADDING = 2;
const BORDERS = 2;
/** Top border + title bar + rule + [content] + rule + hint bar + bottom border. */
const CHROME_LINES = 6;

type SessionMessage = { role?: string; content?: unknown };

/** Extract the plain text of a message content (string or text-block array). */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.length > 0) parts.push(text);
		}
	}
	return parts.join("\n");
}

interface Turn {
	/** The user input of this turn (null = assistant output before any input). */
	user: string | null;
	/** The last assistant text of this turn (intermediate messages overwrite it). */
	assistant: string | null;
}

/** Collapse the branch into turns: leading input + final reply per turn. */
function buildTurns(ctx: ExtensionContext): Turn[] {
	const entries = ctx.sessionManager.getBranch();
	const turns: Turn[] = [];
	let current: Turn | null = null;

	for (const entry of entries) {
		if (!entry || (entry as { type?: string }).type !== "message") continue;
		const message = (entry as { message?: SessionMessage }).message;
		if (!message || typeof message.role !== "string") continue;

		const text = extractText(message.content).trim();
		if (!text) continue;

		if (message.role === "user") {
			if (current) turns.push(current);
			current = { user: text, assistant: null };
		} else if (message.role === "assistant") {
			if (!current) current = { user: null, assistant: null };
			current.assistant = text; // keep overwriting, only the last one survives
		}
	}
	if (current) turns.push(current);

	return turns;
}

/**
 * Build the plain-text payload for copying: input and final reply separated by
 * a blank line, turns separated by `---` so turn boundaries stay visible once
 * colors and separator lines are stripped.
 */
function buildPlainText(turns: Turn[]): string {
	const blocks = turns.map((turn) =>
		[turn.user, turn.assistant].filter((part) => part !== null && part.length > 0).join("\n\n"),
	);
	return blocks.join("\n\n---\n\n");
}

/** The aggregate window: compact line stream + self-managed scrolling + strict
 * border alignment + one-key copy. */
class AggregateWindow implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly title: string;
	private readonly turns: Turn[];
	/** One Markdown renderer per turn (created once, cached internally). */
	private readonly renderers: Markdown[];
	private scrollTop = 0;

	/** Copy function (snapshotted at construction, injectable for tests). */
	private readonly copyFn: (text: string) => Promise<void>;
	private feedback: string | null = null;
	private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	/** Render cache keyed by content width; invalidated by invalidate(). */
	private cacheWidth = -1;
	private cachedLines: string[] | null = null;

	constructor(
		tui: TUI,
		theme: Theme,
		turns: Turn[],
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.copyFn = activeCopyFn;
		this.turns = turns;
		this.title = turns.length > 0 ? ` Context · ${turns.length} turns ` : " Context ";
		const mdTheme = getMarkdownTheme();
		this.renderers = turns.map((turn) => new Markdown(turn.assistant ?? "", 0, 0, mdTheme));
	}

	render(width: number): string[] {
		const winW = Math.min(width, MAX_WINDOW_WIDTH);
		const contentW = Math.max(10, winW - BORDERS - H_PADDING);

		const lines = this.renderedLines(contentW);

		const viewportH = this.viewportHeight();
		const maxScroll = Math.max(0, lines.length - viewportH);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScroll);

		const visible = lines.slice(this.scrollTop, this.scrollTop + viewportH);

		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) =>
			border("│") + " " + this.padToWidth(truncateToWidth(content, contentW, ""), contentW) + " " + border("│");

		const box: string[] = [border(`╭${"─".repeat(winW - BORDERS)}╮`)];
		box.push(row(this.theme.fg("accent", this.theme.bold(this.title))));
		box.push(border(`├${"─".repeat(winW - BORDERS)}┤`));

		for (const line of visible) box.push(row(line));

		box.push(border(`├${"─".repeat(winW - BORDERS)}┤`));
		box.push(row(this.hintLine(lines.length, viewportH, contentW)));
		box.push(border(`╰${"─".repeat(winW - BORDERS)}╯`));

		// The overlay declares width = WIDTH_PCT% of the terminal while this
		// window caps at MAX_WINDOW_WIDTH. pi-tui positions overlay lines by
		// the declared width and never pads on the left, so a narrower box
		// would sit left of center on wide terminals. Center the box within
		// the declared width so the overlay's own centering math holds.
		const leftPad = Math.floor((width - winW) / 2);
		if (leftPad <= 0) return box;
		const start = " ".repeat(leftPad);
		const end = " ".repeat(width - winW - leftPad);
		return box.map((line) => start + line + end);
	}

	/** Build the compact line stream: user line (highlighted) first, final
	 * reply Markdown lines right after, no blank lines anywhere. */
	private renderedLines(contentW: number): string[] {
		if (this.cachedLines && this.cacheWidth === contentW) return this.cachedLines;

		const lines: string[] = [];
		for (let i = 0; i < this.turns.length; i++) {
			const turn = this.turns[i]!;

			// Green separator between turns — unconditional, so two inputs of
			// consecutive output-less turns (e.g. interrupted twice) cannot
			// visually merge into one.
			if (i > 0) {
				lines.push(this.theme.fg("success", "─".repeat(contentW)));
			}

			if (turn.user) {
				for (const paragraph of turn.user.split("\n")) {
					// Keep leading indentation (code snippets etc.), trim only
					// the end; skip lines that are entirely whitespace.
					const trimmed = paragraph.trimEnd();
					if (!trimmed.trim()) continue;
					for (const wrapped of wrapTextWithAnsi(trimmed, contentW)) {
						lines.push(this.theme.fg("success", this.theme.bold(wrapped)));
					}
				}
			}

			if (turn.assistant) {
				// Green separator between a turn's input and its output (only
				// when the turn actually has both).
				if (turn.user) {
					lines.push(this.theme.fg("success", "─".repeat(contentW)));
				}
				for (const line of this.renderers[i]!.render(contentW)) {
					if (line.length === 0) continue;
					lines.push(line);
				}
			}
		}

		this.cacheWidth = contentW;
		this.cachedLines = lines;
		return lines;
	}

	/** Bottom hint: key legend + scroll position; briefly replaced by copy
	 * feedback after `y`. */
	private hintLine(totalLines: number, viewportH: number, contentW: number): string {
		if (this.feedback) {
			return this.theme.fg("accent", this.feedback);
		}
		const keys = this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · g/G top/bottom · y copy · q/Esc close");
		if (totalLines <= viewportH) return keys;

		const first = this.scrollTop + 1;
		const last = Math.min(totalLines, this.scrollTop + viewportH);
		const pct = Math.round((last / totalLines) * 100);
		const indicator = this.theme.fg("dim", ` ${first}-${last}/${totalLines} (${pct}%)`);
		const gap = Math.max(1, contentW - visibleWidth(keys) - visibleWidth(indicator));
		return keys + " ".repeat(gap) + indicator;
	}

	/** Right-pad to a visible width (truncation is truncateToWidth's job). */
	private padToWidth(text: string, width: number): string {
		const pad = width - visibleWidth(text);
		return pad > 0 ? text + " ".repeat(pad) : text;
	}

	/**
	 * Viewport height in content lines. Derived with the same integer math the
	 * overlay applies to its maxHeight percentage, so the rendered window can
	 * never exceed the overlay cap — otherwise the bottom border and hint bar
	 * get clipped on short terminals.
	 */
	private viewportHeight(): number {
		const overlayMax = Math.floor((this.tui.terminal.rows * HEIGHT_PCT) / 100);
		return Math.max(1, overlayMax - CHROME_LINES);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q" || data === "Q") {
			this.done();
			return;
		}

		if (data === "y" || data === "Y") {
			this.copyAll();
			return;
		}

		const viewportH = this.viewportHeight();
		if (matchesKey(data, "up") || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, "down") || data === "j") this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-viewportH);
		else if (matchesKey(data, "pageDown")) this.scrollBy(viewportH);
		else if (matchesKey(data, "home") || data === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(Number.MAX_SAFE_INTEGER);
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.wheelDelta === undefined) return undefined;
		this.scrollBy(event.wheelDelta * 3);
		return { handled: true };
	}

	/** Copy the full aggregated plain text. */
	private copyAll(): void {
		if (this.feedbackTimer) return; // previous copy feedback still active, ignore repeats
		const text = buildPlainText(this.turns);
		this.copyFn(text)
			.then(() => this.showFeedback(`Copied ${text.length} characters to clipboard`))
			.catch((err: unknown) =>
				this.showFeedback(
					`Copy failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 80),
				));
	}

	private showFeedback(message: string): void {
		if (this.disposed) return; // window closed while the copy promise was in flight
		this.feedback = message;
		this.tui.requestRender();
		this.feedbackTimer = setTimeout(() => {
			this.feedbackTimer = null;
			this.feedback = null;
			this.tui.requestRender();
		}, 2000);
	}

	private contentLineCount(): number {
		// Prefer the cache from the last render: same width, so scroll bounds
		// match what is on screen exactly.
		if (this.cachedLines) return this.cachedLines.length;
		// No cache yet (scrolled before the first render): estimate at the
		// overlay's actual width, using the same math pi-tui applies to
		// percentage sizes.
		const winW = Math.min(Math.floor((this.tui.terminal.columns * WIDTH_PCT) / 100), MAX_WINDOW_WIDTH);
		return this.renderedLines(Math.max(10, winW - BORDERS - H_PADDING)).length;
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	private scrollTo(position: number): void {
		const maxScroll = Math.max(0, this.contentLineCount() - this.viewportHeight());
		const next = Math.min(Math.max(0, position), maxScroll);
		if (next !== this.scrollTop) {
			this.scrollTop = next;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.cachedLines = null;
		this.cacheWidth = -1;
		for (const renderer of this.renderers) renderer.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.feedbackTimer) {
			clearTimeout(this.feedbackTimer);
			this.feedbackTimer = null;
		}
	}
}

/** Current copy implementation (system clipboard by default; tests can swap it). */
let activeCopyFn: (text: string) => Promise<void> = copyToClipboard;

/** Test injection point: replace the copy implementation so tests do not
 * touch the real clipboard. */
export function __injectCopyFnForTest(fn: (text: string) => Promise<void>): void {
	activeCopyFn = fn;
}

/** Shared entry point: build turns and pop up the window. */
async function showAggregateWindow(ctx: ExtensionContext): Promise<void> {
	const turns = buildTurns(ctx);

	if (turns.length === 0) {
		if (ctx.hasUI) {
			ctx.ui.notify("Nothing to aggregate: no user input or assistant output in this branch", "warning");
		}
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new AggregateWindow(tui, theme, turns, () => done(undefined)),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: `${WIDTH_PCT}%`,
				maxHeight: `${HEIGHT_PCT}%`,
			},
		},
	);
}

export default function (pi: ExtensionAPI): void {
	// Alt+A: every mainstream terminal sends a distinct ESC a for it (older
	// terminals encode Ctrl+Shift+A identically to Ctrl+A, making it unusable)
	// and it does not collide with pi's built-in bindings.
	pi.registerShortcut(Key.alt("a"), {
		description: "Aggregate the input and final reply of every turn in this session",
		handler: (ctx) => showAggregateWindow(ctx),
	});

	pi.registerCommand("aggregate", {
		description: "Aggregate the input and final reply of every turn in this session (shortcut: Alt+A)",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("The aggregate window requires interactive TUI mode", "warning");
				return;
			}
			await showAggregateWindow(ctx);
		},
	});
}
