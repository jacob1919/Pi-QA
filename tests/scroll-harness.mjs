// Scrolling behavior tests: keyboard scrolling, mouse wheel, clamping,
// resize adaptation and wide-terminal padding. Requires `npm install` first.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti("../extensions/aggregate-context.ts");
const registered = { shortcuts: [], commands: [] };
mod.default({
	registerShortcut: (key, opts) => registered.shortcuts.push({ key, opts }),
	registerCommand: (name, opts) => registered.commands.push({ name, opts }),
});

// 60 turns -> far more content lines than the viewport can show.
const longBranch = [];
for (let i = 1; i <= 60; i++) {
	longBranch.push({ type: "message", message: { role: "user", content: `Message ${i}: content content content content content` } });
	longBranch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}.` }] } });
}

const fakeTui = { terminal: { rows: 24, columns: 100 }, renderCalls: 0, requestRender() { this.renderCalls++; } };
let captured = null;
const ctx = {
	mode: "tui", hasUI: true,
	sessionManager: { getBranch: () => longBranch },
	ui: { notify: () => {}, custom: async (f, o) => { captured = { factory: f, options: o }; } },
};
await registered.commands[0].opts.handler("", ctx);

let closed = 0;
const comp = captured.factory(fakeTui, { fg: (_t, s) => s, bold: (s) => s, colors: {}, style: (s) => s }, null, () => closed++);

// Content lines = rendered window minus 6 chrome lines (border/title/rule top, rule/hint/border bottom).
const contentLines = () => comp.render(100).slice(3, -3);
const content = () => contentLines().join("\n");
const firstMsgVisible = () => content().includes("Message 1:");

// ---- pageDown scrolls a full viewport, twice ----
assert.ok(firstMsgVisible(), "first message must start visible");
comp.handleInput("\x1b[6~"); // pageDown
assert.ok(!firstMsgVisible(), "one pageDown must scroll past the first message");
comp.handleInput("\x1b[6~");
assert.ok(!firstMsgVisible());
console.log("pageDown ok");

// ---- G to the bottom, g back to the top ----
comp.handleInput("G");
assert.ok(content().includes("Reply 60."), "G must reach the last turn");
comp.handleInput("g");
assert.ok(firstMsgVisible(), "g must return to the top");
console.log("G/g ok");

// ---- pageUp ----
comp.handleInput("\x1b[6~");
comp.handleInput("\x1b[5~"); // pageUp
assert.ok(firstMsgVisible(), "pageUp must scroll back to the first message");
console.log("pageUp ok");

// ---- j/k scroll by exactly one line ----
comp.handleInput("G");
const before = contentLines();
comp.handleInput("k");
const after = contentLines();
assert.equal(after[1], before[0], "k must shift the window up by exactly one line");
comp.handleInput("j");
assert.deepEqual(comp.render(100).slice(3, -3), before, "j must scroll back down by one line");
console.log("j/k ok");

// ---- clamping at both ends ----
comp.handleInput("g");
comp.handleInput("k"); // above the top
assert.ok(firstMsgVisible(), "must stay clamped at the top");
comp.handleInput("G");
comp.handleInput("j"); // below the bottom
assert.ok(content().includes("Reply 60."), "must stay clamped at the bottom");
console.log("clamping ok");

// ---- mouse wheel: 3 lines per notch, requests a render ----
comp.handleInput("G");
const rendersBeforeWheel = fakeTui.renderCalls;
comp.handleMouse({ type: "wheel", button: 0, x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: -5 });
assert.ok(!content().includes("Reply 60."), "wheel up must scroll away from the bottom");
assert.ok(fakeTui.renderCalls > rendersBeforeWheel, "wheel must request a render");
console.log("mouse wheel ok");

// ---- resize to a short terminal: adapts, stays aligned, never overflows ----
fakeTui.terminal.rows = 10;
const small = comp.render(100);
assert.ok(small.length <= 8, `10-row terminal allows at most 8 lines, got ${small.length}`);
const smallWidths = [...new Set(small.map((l) => visibleWidth(l)))];
assert.equal(smallWidths.length, 1, "resized lines must stay aligned");
console.log("resize ok");

// ---- wide terminal: box padded/centered to the declared overlay width ----
fakeTui.terminal.rows = 40;
fakeTui.terminal.columns = 200;
const wide = comp.render(184); // floor(200 * 92 / 100)
const wideWidths = [...new Set(wide.map((l) => visibleWidth(l)))];
assert.deepEqual(wideWidths, [184], `wide lines must fill 184 columns, got ${wideWidths.join(",")}`);
console.log("wide terminal ok");

// ---- Enter closes ----
comp.handleInput("\r");
assert.equal(closed, 1, "Enter must close the window");
console.log("Enter close ok");

console.log("\nALL SCROLL TESTS PASSED");
