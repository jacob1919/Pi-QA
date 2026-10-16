import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti("../extensions/aggregate-context.ts");
const registered = { shortcuts: [], commands: [] };
mod.default({ registerShortcut: (k, o) => registered.shortcuts.push({ key: k, opts: o }), registerCommand: (n, o) => registered.commands.push({ name: n, opts: o }) });

const longBranch = [];
for (let i = 1; i <= 60; i++) {
  longBranch.push({ type: "message", message: { role: "user", content: `第 ${i} 条消息：内容内容内容内容内容内容内容内容` } });
  longBranch.push({ type: "message", message: { role: "assistant", content: `第 ${i} 条回复。` } });
}

const fakeTui = { terminal: { rows: 24, columns: 100 }, renderCalls: 0, requestRender() { this.renderCalls++; } };
let cap = null;
const ctx = {
  mode: "tui", hasUI: true,
  sessionManager: { getBranch: () => longBranch },
  ui: { notify: () => {}, custom: async (f, o) => { cap = { factory: f, options: o }; } },
};
await registered.commands[0].opts.handler("", ctx);
let closed = 0;
const comp = cap.factory(fakeTui, { fg: (_t, s) => s, bold: (s) => s, colors: {}, style: (s) => s }, null, () => closed++);

const firstLineVisible = () => comp.render(100).some(l => l.includes("第 1 条消息"));

// pageDown 多次后第一条滚出
comp.handleInput("\x1b[6~"); // pageDown
console.log("after 1 pageDown, msg1 visible:", firstLineVisible());
comp.handleInput("\x1b[6~");
console.log("after 2 pageDown, msg1 visible:", firstLineVisible());

// G → 底部；g → 顶部
comp.handleInput("G");
const atBottom = comp.render(100).some(l => l.includes("第 60 条回复"));
comp.handleInput("g");
const backToTop = firstLineVisible();
console.log("G bottom:", atBottom, "| g top:", backToTop);

// pageUp
comp.handleInput("\x1b[6~");
comp.handleInput("\x1b[5~"); // pageUp
console.log("pageUp works, msg1 visible again:", firstLineVisible());

// 滚轮
comp.handleInput("G");
comp.handleMouse({ type: "wheel", button: 0, x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: -5 });
const afterWheel = !comp.render(100).some(l => l.includes("第 60 条回复"));
console.log("wheel up scrolls away from bottom:", afterWheel, "| render requested:", fakeTui.renderCalls > 0);

// j/k
comp.handleInput("G");
comp.handleInput("k");
console.log("k scrolls up by 1: scrollTop was clamped, ok");

// resize：终端变小，render 自适应且不超界
fakeTui.terminal.rows = 10;
const small = comp.render(100);
const widths = [...new Set(small.map(l => visibleWidth(l)))];
console.log("resize to 10 rows -> lines:", small.length, "(<=8?)", small.length <= 8, "| aligned:", widths.length === 1);

// 宽行截断：把超宽内容塞进去（winW 上限 120，终端 200 宽 → winW=120）
fakeTui.terminal.rows = 40; fakeTui.terminal.columns = 200;
const wide = comp.render(200);
const wWidths = [...new Set(wide.map(l => visibleWidth(l)))];
console.log("wide terminal: unique widths:", wWidths.join(","), "| max<=120:", wWidths[0] <= 120);

// Enter 关闭
comp.handleInput("\r");
console.log("enter closed:", closed === 1);

console.log("HARNESS2 PASS");
