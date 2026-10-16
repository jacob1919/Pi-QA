// 渲染行为测试：用 jiti（pi 加载扩展的同一运行时）驱动扩展。
// 依赖仓库根的 node_modules junction（指向 pi 安装目录）。
import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";
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

// ---- 注册断言 ----
console.log("shortcuts:", registered.shortcuts.map((s) => s.key));
console.log("commands:", registered.commands.map((c) => c.name));
if (registered.shortcuts[0].key !== "alt+a") throw new Error("shortcut should be alt+a");
if (registered.commands.some((c) => c.name === "聚合")) throw new Error("/聚合 should be removed");
if (!registered.commands.some((c) => c.name === "aggregate")) throw new Error("/aggregate missing");

// ---- mock 分支：一轮内多条助手消息，只应保留最后一条 ----
const branch = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "第一轮：帮我检查文件" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "让我先看看。这是中间输出，应该被丢弃。" }] } },   // 丢弃
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "正在调用工具。也是中间输出。" }] } },           // 丢弃
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "检查完成：文件有 **3 处** 问题。" }] } },      // 保留（最后一条）
	{ type: "message", message: { role: "user", content: "第二轮：修复它们。中文宽字符对齐测试 🎉\n    def f():\n        return 1" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "ignored" }, { type: "text", text: "已修复全部问题。" }] } },
	{ type: "compaction", data: {} },                                                                                  // 忽略
	{ type: "message", message: { role: "system", content: "system ignored" } },                                       // 忽略
];

const fakeTui = { terminal: { rows: 24, columns: 100 }, renderCalls: 0, requestRender() { this.renderCalls++; } };

// fake theme：输出真 ANSI（渲染管线按真实路径处理 wrap/truncate/pad），
// accent=洋红35, success=绿32, dim=暗淡2, border=灰90, bold=加粗1。
const ACCENT = "\x1b[35m", GREEN = "\x1b[32m", DIM = "\x1b[2m", BORDER = "\x1b[90m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const fakeTheme = {
	fg: (token, s) => (token === "accent" ? ACCENT : token === "success" ? GREEN : token === "dim" ? DIM : BORDER) + s + RESET,
	bold: (s) => BOLD + s + RESET,
	style: (s) => s,
	colors: {},
};

let captured = null;
const ctx = {
	mode: "tui",
	hasUI: true,
	sessionManager: { getBranch: () => branch },
	ui: {
		notify: (msg, type) => console.log(`[notify:${type}] ${msg}`),
		custom: async (factory, options) => { captured = { factory, options }; },
	},
};

const agg = registered.commands.find((c) => c.name === "aggregate");
await agg.opts.handler("", ctx);
if (!captured) throw new Error("custom not invoked");

let closed = 0;
const component = captured.factory(fakeTui, fakeTheme, null, () => closed++);
const lines = component.render(100);
console.log("rendered lines:", lines.length);

// ---- 对齐断言（真 ANSI 会被 visibleWidth 正确忽略） ----
const widths = [...new Set(lines.map((l) => visibleWidth(l)))];
console.log("line widths:", widths.join(","));
if (widths.length !== 1) { lines.forEach((l, i) => console.log(i, visibleWidth(l))); process.exit(1); }

// ---- 内容断言 ----
const joined = lines.join("\n");
const mustHave = ["第一轮：帮我检查文件", "检查完成：文件有", "第二轮：修复它们", "已修复全部问题"];
const mustMiss = ["让我先看看", "正在调用工具", "system ignored", "用户：", "助手："];
for (const s of mustHave) if (!joined.includes(s)) { console.error("MISSING:", s); process.exit(1); }
for (const s of mustMiss) if (joined.includes(s)) { console.error("SHOULD NOT CONTAIN:", s); process.exit(1); }
console.log("turn folding correct: intermediate outputs dropped, finals kept");

// 分割线断言：输入输出之间应有绿色分割线，但内容区不应有其他长横线
const contentOnly = lines.slice(3, -3);
const contentJoined = contentOnly.join("\n");
const stripAnsi = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
const sepLines = contentOnly.filter((l) => {
	if (!l.includes(GREEN)) return false;
	const inner = stripAnsi(l).trim();
	return inner.startsWith("│") && inner.endsWith("│") && /^─+$/.test(inner.slice(1, -1).trim());
});
console.log("green separator lines:", sepLines.length, "(expect 3: 1 turn-gap + 2 input/output)");
if (sepLines.length !== 3) process.exit(1);
if (/─{6,}/.test(contentOnly.map((l) => stripAnsi(l).replace(/[─]/g, "")).join(""))) { console.error("unexpected hr"); process.exit(1); }
console.log("separators ok, no stray hr");

// 空行断言：内容区不应有空行（去掉 ANSI 后）
const blank = contentOnly.filter((l) => visibleWidth(l) === 0);
console.log("blank lines in content:", blank.length, "(expect 0)");

// 用户行绿色断言：用户输入行应带 success 色码而非 accent
const userLine = lines.find((l) => l.includes("第一轮：帮我检查文件"));
console.log("user line green:", userLine.includes(GREEN), "| not purple:", !userLine.includes(ACCENT), "| bold:", userLine.includes(BOLD));
const assistantLine = lines.find((l) => l.includes("已修复全部问题"));
console.log("assistant line plain (no green):", !assistantLine.includes(GREEN));

// 缩进保留断言：多行输入的代码缩进应保留
const stripAnsiInline = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
const indentLine = lines.find((l) => stripAnsiInline(l).includes("def f():"));
console.log("indent preserved:", !!indentLine && /^\s+def f\(\):/.test(stripAnsiInline(indentLine).trim().replace(/^│\s/, "").replace(/\s│$/, "")));

// ---- 窗口预览（去 ANSI 展示） ----
console.log("--- preview ---");
lines.slice(0, 10).forEach((l) => console.log(stripAnsi(l)));

// ---- 滚动/关闭（长内容） ----
const longBranch = [];
for (let i = 1; i <= 60; i++) {
	longBranch.push({ type: "message", message: { role: "user", content: `第 ${i} 轮输入：内容内容内容内容内容内容内容内容` } });
	longBranch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "中间说明。" }] } });
	longBranch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `第 ${i} 轮最终回复。` }] } });
}
let cap2 = null;
let copiedArg = null;
// 注入复制 spy 必须在组件构造之前（copyFn 在构造时快照）
mod.__injectCopyFnForTest(async (text) => { copiedArg = text; });
const ctx2 = { ...ctx, sessionManager: { getBranch: () => longBranch }, ui: { notify: () => {}, custom: async (f, o) => { cap2 = { factory: f }; } } };
await agg.opts.handler("", ctx2);
const comp2 = cap2.factory(fakeTui, fakeTheme, null, () => closed++);
const l2 = comp2.render(100);
console.log("\nlong content lines:", l2.length, "(bounded:", l2.length <= 20, ")");
const j2 = l2.join("\n");
console.log("intermediate dropped in long run:", !j2.includes("中间说明"));
console.log("finals present:", j2.includes("第 1 轮最终回复"));

comp2.handleInput("\x1b[6~"); // pageDown
comp2.handleInput("G");
const l3 = comp2.render(100);
console.log("G reaches last turn:", l3.some((l) => l.includes("第 60 轮最终回复")));
comp2.handleInput("g");
console.log("g back to top:", comp2.render(100).some((l) => l.includes("第 1 轮最终回复")));
comp2.handleInput("\x1b"); // esc
console.log("esc closes:", closed === 1);
comp2.handleInput("q");
console.log("q closes:", closed === 2);

// ---- 空分支 ----
let notified = null;
await agg.opts.handler("", { ...ctx, sessionManager: { getBranch: () => [] }, ui: { notify: (m, t) => { notified = { m, t }; }, custom: async () => { throw new Error("no window"); } } });
console.log("empty branch notified:", JSON.stringify(notified));

// ---- 复制功能：y 键一键复制纯文本（注入 spy，不写真实剪贴板） ----
comp2.handleInput("y");
await new Promise((r) => setTimeout(r, 20));
console.log("copy triggered:", copiedArg !== null);
if (copiedArg === null) process.exit(1);
console.log("copy content has user text:", copiedArg.includes("第 1 轮输入"));
console.log("copy content has finals:", copiedArg.includes("第 60 轮最终回复"));
console.log("copy excludes intermediates:", !copiedArg.includes("中间说明"));
console.log("copy has no ANSI/border:", !/\x1b\[|^[│╭╰├]/m.test(copiedArg));
console.log("turns separated by blank line:", /\n\n/.test(copiedArg));
// 复制反馈显示在提示行
const lFeedback = comp2.render(100);
console.log("feedback shown:", lFeedback.some((l) => stripAnsi(l).includes("已复制")));
// esc 仍可关闭（y 不冲突；此前 esc/q 已各关闭一次，这次应为第 3 次）
comp2.handleInput("\x1b");
console.log("esc still closes after copy:", closed === 3);

console.log("\nALL RENDER TESTS DONE");
