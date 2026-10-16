/**
 * Context Aggregator — 聚合当前会话分支中每轮交互的用户输入与最终回复。
 *
 * 触发方式：
 *   - 快捷键 Alt+A
 *   - 命令 /aggregate
 *
 * 聚合规则：
 *   - 从 ctx.sessionManager.getBranch() 提取当前活跃分支（排除废弃分支）
 *   - 一轮交互 = 一条用户输入到下一条用户输入之间的全部消息
 *   - 每轮只保留：开头的用户输入 + 结尾（最后一条）的助手文本
 *   - 中间的助手输出（工具调用前的简短说明等）全部忽略
 *   - 工具调用、思考内容、系统消息、工具结果、分支/压缩摘要不参与
 *
 * 展示规则：
 *   - 紧凑排版：无角色标签、块间无空行
 *   - 用户输入整行绿色加粗；输入与输出之间、上一轮输出结尾与下一轮输入之间
 *     各一条绿色分割线，区分轮次与输入输出
 *   - 助手输出以 Markdown 渲染（与会话内一致）
 *   - 居中 overlay 窗口，键盘与滚轮滚动，Esc/q/Enter 关闭
 *
 * 复制：overlay 是绘制在会话之上的浮层，终端鼠标选择是屏幕级的，跨过窗口边界
 * 会把底下的会话文本一并选入。因此提供 y 键一键复制：完整纯文本（无 ANSI、
 * 无边框、无窗口宽度换行）经 copyToClipboard 写入剪贴板，SSH 会话自动 OSC 52
 * 送达本地剪贴板。
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

/** 窗口占终端高度的比例（与 overlayOptions.maxHeight 保持一致）。 */
const HEIGHT_RATIO = 0.85;
/** 窗口最大宽度（列）。 */
const MAX_WINDOW_WIDTH = 120;
/** 窗口内容区左右各留 1 列内边距，外加左右边框各 1 列。 */
const H_PADDING = 2;
const BORDERS = 2;
/** 顶部边框 + 标题栏 + 分隔线 + 分隔线 + 提示栏 + 底部边框。 */
const CHROME_LINES = 6;

type SessionMessage = { role?: string; content?: unknown };

/** 提取一条消息 content 里的纯文本（字符串或 text 块数组）。 */
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
	/** 本轮用户输入（null = 会话开头没有用户输入就出现助手消息）。 */
	user: string | null;
	/** 本轮最后一条助手文本（中间的助手输出被覆盖丢弃）。 */
	assistant: string | null;
}

/** 把分支消息折叠为轮次：每轮只留开头输入与结尾回复。 */
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
			current.assistant = text; // 不断覆盖，只留最后一条
		}
	}
	if (current) turns.push(current);

	return turns;
}

/** 构建供复制的纯文本：轮内输入/输出之间与轮次之间以空行分隔，内容为原文。 */
function buildPlainText(turns: Turn[]): string {
	const parts: string[] = [];
	for (const turn of turns) {
		if (turn.user) parts.push(turn.user);
		if (turn.assistant) parts.push(turn.assistant);
	}
	return parts.join("\n\n");
}

/** 聚合窗口：紧凑行流 + 自管滚动 + 严格边框对齐 + 一键复制。 */
class AggregateWindow implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly title: string;
	private readonly turns: Turn[];
	/** 每轮的助手 Markdown 渲染器（构造时创建一次）。 */
	private readonly renderers: Markdown[];
	private scrollTop = 0;

	/** 复制函数（构造时快照，测试可注入）；底部提示的复制反馈与定时恢复。 */
	private readonly copyFn: (text: string) => Promise<void>;
	private feedback: string | null = null;
	private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

	/** 渲染缓存：按宽度缓存行数组，invalidate 时失效。 */
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
		this.title = turns.length > 0 ? ` 上下文聚合 · ${turns.length} 轮 ` : " 上下文聚合 ";
		const mdTheme = getMarkdownTheme();
		this.renderers = turns.map((turn) => new Markdown(turn.assistant ?? "", 0, 0, mdTheme));
	}

	render(width: number): string[] {
		const winW = Math.min(width, MAX_WINDOW_WIDTH);
		const contentW = Math.max(10, winW - BORDERS - H_PADDING);

		const lines = this.renderedLines(contentW);

		// 视口高度：按终端高度的比例，扣除窗口装饰行。
		const totalH = Math.max(8, Math.floor(this.tui.terminal.rows * HEIGHT_RATIO));
		const viewportH = Math.max(2, totalH - CHROME_LINES);
		const maxScroll = Math.max(0, lines.length - viewportH);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScroll);

		const visible = lines.slice(this.scrollTop, this.scrollTop + viewportH);

		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) =>
			border("│") + " " + this.padToWidth(truncateToWidth(content, contentW, ""), contentW) + " " + border("│");

		const out: string[] = [border(`╭${"─".repeat(winW - BORDERS)}╮`)];
		out.push(row(this.theme.fg("accent", this.theme.bold(this.title))));
		out.push(border(`├${"─".repeat(winW - BORDERS)}┤`));

		for (const line of visible) out.push(row(line));

		out.push(border(`├${"─".repeat(winW - BORDERS)}┤`));
		out.push(row(this.hintLine(lines.length, viewportH, contentW)));
		out.push(border(`╰${"─".repeat(winW - BORDERS)}╯`));
		return out;
	}

	/** 构建紧凑行流：用户行（强调色）在前，最终回复 Markdown 行紧随，无任何空行。 */
	private renderedLines(contentW: number): string[] {
		if (this.cachedLines && this.cacheWidth === contentW) return this.cachedLines;

		const lines: string[] = [];
		for (let i = 0; i < this.turns.length; i++) {
			const turn = this.turns[i]!;

			// 轮次之间的绿色分割线：上一轮有输出时，在其结尾与本轮输入之间加线
			if (i > 0 && this.turns[i - 1]!.assistant) {
				lines.push(this.theme.fg("success", "─".repeat(contentW)));
			}

			if (turn.user) {
				for (const paragraph of turn.user.split("\n")) {
					// 保留行首缩进（代码片段等），仅去尾空白；纯空白行跳过
					const trimmed = paragraph.trimEnd();
					if (!trimmed.trim()) continue;
					for (const wrapped of wrapTextWithAnsi(trimmed, contentW)) {
						lines.push(this.theme.fg("success", this.theme.bold(wrapped)));
					}
				}
			}

			if (turn.assistant) {
				// 输入与输出之间的绿色分割线（仅当本轮同时有输入和输出）
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

	/** 底部提示：按键说明 + 滚动位置指示；复制后短暂显示复制结果反馈。 */
	private hintLine(totalLines: number, viewportH: number, contentW: number): string {
		if (this.feedback) {
			return this.theme.fg("accent", this.feedback);
		}
		const keys = this.theme.fg("dim", "↑↓ 滚动 · PgUp/PgDn 翻页 · g/G 顶/底 · y 复制 · q/Esc 关闭");
		if (totalLines <= viewportH) return keys;

		const first = this.scrollTop + 1;
		const last = Math.min(totalLines, this.scrollTop + viewportH);
		const pct = Math.round((last / totalLines) * 100);
		const indicator = this.theme.fg("dim", ` ${first}-${last}/${totalLines} (${pct}%)`);
		const gap = Math.max(1, contentW - visibleWidth(keys) - visibleWidth(indicator));
		return keys + " ".repeat(gap) + indicator;
	}

	/** 用可见宽度右补空格（截断由 truncateToWidth 负责）。 */
	private padToWidth(text: string, width: number): string {
		const pad = width - visibleWidth(text);
		return pad > 0 ? text + " ".repeat(pad) : text;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q" || data === "Q") {
			this.done();
			return;
		}

		if (data === "y") {
			this.copyAll();
			return;
		}

		const viewportH = this.currentViewportHeight();
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

	/** 一键复制全部聚合内容为纯文本。 */
	private copyAll(): void {
		if (this.feedbackTimer) return; // 上一次复制还在反馈中，忽略连按
		const text = buildPlainText(this.turns);
		this.copyFn(text)
			.then(() => this.showFeedback(`已复制 ${text.length} 字符到剪贴板`))
			.catch((err: unknown) =>
				this.showFeedback(
					`复制失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 80),
				));
	}

	private showFeedback(message: string): void {
		this.feedback = message;
		this.tui.requestRender();
		this.feedbackTimer = setTimeout(() => {
			this.feedbackTimer = null;
			this.feedback = null;
			this.tui.requestRender();
		}, 2000);
	}

	private currentViewportHeight(): number {
		const totalH = Math.max(8, Math.floor(this.tui.terminal.rows * HEIGHT_RATIO));
		return Math.max(2, totalH - CHROME_LINES);
	}

	private contentLineCount(): number {
		// 优先复用 render 已缓存的行数（宽度一致，滚动范围与显示完全同步）
		if (this.cachedLines) return this.cachedLines.length;
		// 无缓存时按 overlay 实际宽度（92%）推算
		const winW = Math.min(Math.floor(this.tui.terminal.columns * 0.92) + 1, MAX_WINDOW_WIDTH);
		return this.renderedLines(Math.max(10, winW - BORDERS - H_PADDING)).length;
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	private scrollTo(position: number): void {
		const maxScroll = Math.max(0, this.contentLineCount() - this.currentViewportHeight());
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
		if (this.feedbackTimer) {
			clearTimeout(this.feedbackTimer);
			this.feedbackTimer = null;
		}
	}
}

/** 当前复制实现（默认系统剪贴板；测试可注入替换）。 */
let activeCopyFn: (text: string) => Promise<void> = copyToClipboard;

/** 测试注入点：替换复制实现，避免测试写入真实剪贴板。 */
export function __injectCopyFnForTest(fn: (text: string) => Promise<void>): void {
	activeCopyFn = fn;
}

/** 共用入口：构建轮次并弹出窗口。 */
async function showAggregateWindow(ctx: ExtensionContext): Promise<void> {
	const turns = buildTurns(ctx);

	if (turns.length === 0) {
		if (ctx.hasUI) {
			ctx.ui.notify("当前上下文中没有可聚合的用户输入或助手输出", "warning");
		}
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new AggregateWindow(tui, theme, turns, () => done(undefined)),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				maxHeight: `${Math.round(HEIGHT_RATIO * 100)}%`,
			},
		},
	);
}

export default function (pi: ExtensionAPI): void {
	// Alt+A：所有主流终端都能可靠发送 ESC a（Ctrl+Shift+A 在传统终端编码下
	// 与 Ctrl+A 不可区分，无法触发），且不与 pi 内置键绑定冲突。
	pi.registerShortcut(Key.alt("a"), {
		description: "聚合当前上下文每轮交互的输入与最终回复",
		handler: (ctx) => showAggregateWindow(ctx),
	});

	pi.registerCommand("aggregate", {
		description: "聚合当前上下文每轮交互的输入与最终回复（快捷键 Alt+A）",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("聚合窗口需要交互式终端模式（TUI）", "warning");
				return;
			}
			await showAggregateWindow(ctx);
		},
	});
}
