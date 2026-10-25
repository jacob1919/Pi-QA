// Render behavior tests: drive the extension through jiti — the same runtime
// pi uses to load extensions. Requires `npm install` first (devDependencies).
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti("../extensions/aggregate-context.ts");

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (line) => line.replace(ANSI, "");

// ---- registration ----
const registered = { shortcuts: [], commands: [] };
mod.default({
	registerShortcut: (key, opts) => registered.shortcuts.push({ key, opts }),
	registerCommand: (name, opts) => registered.commands.push({ name, opts }),
});
assert.equal(registered.shortcuts[0].key, "alt+a");
assert.ok(registered.commands.some((c) => c.name === "aggregate"));
console.log("registration ok: Alt+A shortcut + /aggregate command");

// ---- fake TUI + theme ----
// The fake theme emits real ANSI so wrap/truncate/pad run through the exact
// same pipeline as production: accent=magenta 35, success=green 32, dim=faint
// 2, border=gray 90, bold=1.
const ACCENT = "\x1b[35m", GREEN = "\x1b[32m", DIM = "\x1b[2m", BORDER = "\x1b[90m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const fakeTheme = {
	fg: (token, s) => (token === "accent" ? ACCENT : token === "success" ? GREEN : token === "dim" ? DIM : BORDER) + s + RESET,
	bold: (s) => BOLD + s + RESET,
	style: (s) => s,
	colors: {},
};
const fakeTui = { terminal: { rows: 24, columns: 100 }, renderCalls: 0, requestRender() { this.renderCalls++; } };

let captured = null;
const makeCtx = (branch, extra = {}) => ({
	mode: "tui",
	hasUI: true,
	sessionManager: { getBranch: () => branch },
	ui: {
		notify: (msg, type) => console.log(`[notify:${type}] ${msg}`),
		custom: async (factory, options) => { captured = { factory, options }; },
	},
	...extra,
});

const agg = registered.commands.find((c) => c.name === "aggregate");

// ---- mock branch: multiple assistant messages in one turn, only the last kept ----
// Mixed CJK + emoji on purpose: they exercise wide-character alignment.
const branch = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "Turn 1: please check the file" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Let me look first. Intermediate output, must be dropped." }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Calling a tool. Also intermediate." }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done: the file has **3 issues**. 中文宽字符对齐 🎉" }] } },
	{ type: "message", message: { role: "user", content: "Turn 2: fix them.\n    def f():\n        return 1" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "ignored" }, { type: "text", text: "All issues fixed." }] } },
	{ type: "compaction", data: {} },
	{ type: "message", message: { role: "system", content: "system ignored" } },
];

await agg.opts.handler("", makeCtx(branch));
assert.ok(captured, "ui.custom not invoked");
assert.equal(captured.options.overlay, true);
assert.equal(captured.options.overlayOptions.width, "92%");
assert.equal(captured.options.overlayOptions.maxHeight, "85%");

let closed = 0;
const component = captured.factory(fakeTui, fakeTheme, null, () => closed++);
const lines = component.render(100);

// ---- alignment: every rendered line has the same visible width ----
const widths = [...new Set(lines.map((l) => visibleWidth(l)))];
assert.deepEqual(widths, [100], `line widths differ: ${widths.join(",")}`);
console.log("alignment ok: all lines exactly 100 columns (CJK/emoji included)");

// ---- content: turn folding ----
const joined = lines.join("\n");
for (const s of ["Turn 1: please check the file", "Done: the file has", "Turn 2: fix them", "All issues fixed", "Context · 2 turns"])
	assert.ok(joined.includes(s), `missing: ${s}`);
for (const s of ["Let me look first", "Calling a tool", "system ignored", "User:", "Assistant:"])
	assert.ok(!joined.includes(s), `should not contain: ${s}`);
assert.ok(stripAnsi(lines[1]).includes("Context · 2 turns"), "title should show the turn count");
console.log("turn folding ok: intermediate outputs dropped, finals kept");

// ---- separators: green line between turns and between input/output ----
const contentOnly = lines.slice(3, -3);
const isGreenSeparator = (l) => {
	if (!l.includes(GREEN)) return false;
	const inner = stripAnsi(l).trim();
	return inner.startsWith("│") && inner.endsWith("│") && /^─+$/.test(inner.slice(1, -1).trim());
};
const seps = contentOnly.filter(isGreenSeparator);
assert.equal(seps.length, 3, `expected 3 separators (1 turn-gap + 2 input/output), got ${seps.length}`);
const hrNoise = contentOnly.map((l) => stripAnsi(l).replace(/─/g, "")).join("");
assert.ok(!/─{6,}/.test(hrNoise), "unexpected horizontal rule inside content");
console.log("separators ok: 1 turn-gap + 2 input/output, no stray rules");

// ---- compactness: no blank lines in the content area ----
assert.equal(contentOnly.filter((l) => visibleWidth(l) === 0).length, 0, "blank line in content area");

// ---- colors: user lines green+bold, assistant lines plain ----
const userLine = lines.find((l) => l.includes("Turn 1: please check the file"));
assert.ok(userLine.includes(GREEN) && userLine.includes(BOLD) && !userLine.includes(ACCENT), "user line styling");
const assistantLine = lines.find((l) => l.includes("All issues fixed"));
assert.ok(!assistantLine.includes(GREEN), "assistant line must not be green");

// ---- indentation: leading spaces of multi-line input survive ----
const indentLine = lines.find((l) => stripAnsi(l).includes("def f():"));
assert.ok(indentLine && /^\s+def f\(\):/.test(stripAnsi(indentLine).trim().replace(/^│\s/, "").replace(/\s│$/, "")), "indent lost");

// ---- hint bar: English key legend ----
assert.ok(stripAnsi(lines[lines.length - 2]).includes("y copy"), "hint bar key legend");

// ---- consecutive turns without output still get a separator ----
const noOutputBranch = [
	{ type: "message", message: { role: "user", content: "Question A (interrupted, no reply)" } },
	{ type: "message", message: { role: "user", content: "Question B" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answer B." }] } },
];
await agg.opts.handler("", makeCtx(noOutputBranch));
const compNo = captured.factory(fakeTui, fakeTheme, null, () => {});
const linesNo = compNo.render(100);
const jNo = linesNo.join("\n");
assert.ok(jNo.includes("Question A (interrupted, no reply)") && jNo.includes("Question B"));
assert.equal(linesNo.slice(3, -3).filter(isGreenSeparator).length, 2, "A/B separator + B input/output separator");
console.log("output-less turns ok: inputs separated, not merged");

// ---- long session: bounded height, scroll keys, close keys ----
const longBranch = [];
for (let i = 1; i <= 60; i++) {
	longBranch.push({ type: "message", message: { role: "user", content: `Turn ${i} input: content content content content content` } });
	longBranch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Intermediate note." }] } });
	longBranch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Turn ${i} final reply.` }] } });
}
let copiedArg = null;
// The copy spy must be injected before construction (copyFn is snapshotted there).
mod.__injectCopyFnForTest(async (text) => { copiedArg = text; });
await agg.opts.handler("", makeCtx(longBranch));
const comp2 = captured.factory(fakeTui, fakeTheme, null, () => closed++);
const l2 = comp2.render(100);
assert.ok(l2.length <= 20, `window exceeds 85% of 24 rows: ${l2.length}`);
const j2 = l2.join("\n");
assert.ok(!j2.includes("Intermediate note"), "intermediates must be dropped");
assert.ok(j2.includes("Turn 1 final reply"), "first turn visible at top");

comp2.handleInput("\x1b[6~"); // pageDown
comp2.handleInput("G");
assert.ok(comp2.render(100).some((l) => l.includes("Turn 60 final reply")), "G must reach the bottom");
comp2.handleInput("g");
assert.ok(comp2.render(100).some((l) => l.includes("Turn 1 final reply")), "g must return to the top");
comp2.handleInput("\x1b"); // Esc
comp2.handleInput("q");
assert.equal(closed, 2, "Esc and q must close");
console.log("scrolling + close keys ok");

// ---- empty branch: warning, no window ----
let notified = null;
await agg.opts.handler("", {
	...makeCtx([]),
	ui: { notify: (m, t) => { notified = { m, t }; }, custom: async () => { throw new Error("window must not open"); } },
});
assert.ok(notified && notified.t === "warning" && notified.m.includes("Nothing to aggregate"));
console.log("empty branch ok: warns instead of opening a window");

// ---- non-TUI mode: refuses with a warning ----
let modeNotified = null;
await agg.opts.handler("", {
	...makeCtx(branch, { mode: "print" }),
	ui: { notify: (m, t) => { modeNotified = { m, t }; }, custom: async () => { throw new Error("window must not open"); } },
});
assert.ok(modeNotified && modeNotified.t === "warning" && modeNotified.m.includes("TUI"));
console.log("non-TUI guard ok");

// ---- copy: y copies full plain text with --- turn separators ----
comp2.handleInput("y");
await new Promise((r) => setTimeout(r, 20));
assert.ok(copiedArg !== null, "copy not triggered");
assert.ok(copiedArg.includes("Turn 1 input") && copiedArg.includes("Turn 60 final reply"));
assert.ok(!copiedArg.includes("Intermediate note"));
assert.ok(!/\x1b\[|^[│╭╰├]/m.test(copiedArg), "copy must be free of ANSI and borders");
assert.ok(/\n\n---\n\n/.test(copiedArg), "turns must be separated by ---");
const lFeedback = comp2.render(100);
assert.ok(lFeedback.some((l) => stripAnsi(l).includes("Copied") && stripAnsi(l).includes("characters")), "copy feedback shown");
comp2.handleInput("\x1b");
assert.equal(closed, 3, "Esc still closes after copying");
console.log("copy ok: plain text, --- separators, feedback, no key conflicts");

// ---- wide terminal: the 120-col box is centered inside the declared overlay width ----
// A 200-column terminal gives the component floor(200*92/100)=184 columns; the
// box caps at 120 and must be padded to 184 with the border starting at column 32.
fakeTui.terminal.rows = 40;
fakeTui.terminal.columns = 200;
const wide = comp2.render(184);
const wWidths = [...new Set(wide.map((l) => visibleWidth(l)))];
assert.deepEqual(wWidths, [184], `wide lines must fill the declared width: ${wWidths.join(",")}`);
const lead = stripAnsi(wide[0]).indexOf("╭");
assert.equal(lead, 32, `box must start at column 32, got ${lead}`);
console.log("wide terminal ok: 120-col box centered inside the 184-col overlay");

// ---- tiny terminal: window never exceeds the overlay height cap ----
fakeTui.terminal.rows = 9;
fakeTui.terminal.columns = 100;
const tiny = comp2.render(92);
assert.ok(tiny.length <= 7, `9-row terminal caps the overlay at 7 lines, got ${tiny.length}`);
assert.ok(stripAnsi(tiny[tiny.length - 1]).includes("╰"), "bottom border must survive on tiny terminals");
console.log("tiny terminal ok: fits inside the 85% overlay cap");

console.log("\nwindow preview (first 10 lines, ANSI stripped):");
lines.slice(0, 10).forEach((l) => console.log(stripAnsi(l)));
console.log("\nALL RENDER TESTS PASSED");
