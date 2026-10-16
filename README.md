# pi-QA — 上下文聚合扩展

## 扩展功能：`extensions/aggregate-context.ts`

弹出居中窗口，聚合当前会话分支中每轮交互的用户输入与最终回复。

### 安装（已生效）

已同步到用户扩展目录，每次运行 `pi` 自动加载：

```
~/.pi/agent/extensions/aggregate-context.ts
```

开发时可直接加载：`pi --extension ./extensions/aggregate-context.ts`

### 使用方式

- **快捷键**：`Alt+A`
- **命令**：`/aggregate`

### 聚合规则

- 数据源为 `ctx.sessionManager.getBranch()` —— 当前活跃分支，不含废弃分支
- 一轮交互 = 一条用户输入到下一条用户输入之间的全部消息
- 每轮只保留：开头的用户输入 + 结尾（最后一条）的助手文本；中间的助手输出（工具调用前的简短说明等）全部丢弃
- 工具调用、思考内容、系统消息、工具结果、分支摘要、压缩摘要不参与

### 展示规则

- 紧凑排版：无角色标签、块间无空行
- 用户输入整行绿色加粗，其后一条绿色分割线，再接助手输出（Markdown 渲染，与会话内一致）
- 仅当本轮同时有输入和输出时才插入分割线
- 居中 overlay 窗口：宽 92%（上限 120 列）、高 85%，会话内容保持可见
- 边框对齐：逐行 `visibleWidth()` 度量、`truncateToWidth()` 截断，中文/emoji 宽字符下严格对齐
- 滚动：`↑↓`/`j k` 单行，`PgUp PgDn` 翻页，`g`/`Home` 顶部，`G`/`End` 底部，鼠标滚轮 3 行/格；底栏显示 `当前行范围/总行数 (百分比)`
- 复制：`y` 一键复制完整纯文本到剪贴板（见下）
- 高度自适应：视口按终端行数比例计算，resize 自动重算；渲染按宽度缓存
- 关闭：`Esc` / `q` / `Enter`

### 关于复制（为什么鼠标选择不好用）

窗口是绘制在会话之上的 overlay 浮层，而终端的鼠标选择是屏幕级的：拖选跨过窗口边界、或选中窗口外露出的会话区域时，底下的会话文本会被一并选入，无法拿到完整无差的段落。

因此用 `y` 键：完整聚合纯文本（无 ANSI 颜色码、无边框、无窗口宽度换行截断；轮内输入/输出之间与轮间以空行分隔，内容为原文）经 pi 的 `copyToClipboard` 写入剪贴板：

- Windows/macOS 写系统剪贴板
- Linux 走 wl-copy/xclip/xsel
- **SSH 远程会话自动 OSC 52，把文本送到你本地电脑的剪贴板**（需终端支持，主流终端默认开启）
- 复制后底栏显示 `已复制 N 字符`，失败时显示原因

### 关于快捷键

曾用 `Ctrl+Shift+A`，但传统终端把它编码为与 `Ctrl+A` 相同的字节，pi 无法区分导致不触发（仅 kitty 协议等可区分）。改用 `Alt+A`：所有主流终端（含 Windows Terminal）都能可靠发送 `ESC a`，且不与 pi 内置键绑定冲突。

### 测试

`tests/render-harness.mjs` 与 `tests/scroll-harness.mjs` 用 jiti（pi 加载扩展的同一运行时）驱动扩展，断言：

- 轮次折叠：中间助手输出被丢弃，只留开头输入与结尾回复
- 紧凑：无标签、内容区零空行；输入绿色加粗、仅每轮一条绿色分割线
- 用户行带 success 色码加粗，助手行不带；分割线绿色且不与其他横线混淆
- 全部渲染行可见宽度一致（宽字符对齐）、行数不超终端高度比例
- 滚动（逐行/翻页/顶底/滚轮）、关闭键、resize、空上下文提示

```bash
# node_modules 是指向本机 pi 安装目录的 junction（见下方说明），
# 克隆后需要先创建才能跑测试
node tests/render-harness.mjs
node tests/scroll-harness.mjs
```

克隆本仓库后，测试依赖 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui`（运行 pi 时本机已有）。在仓库根创建指向其 node_modules 的链接即可：

```bash
# Windows（管理员 cmd）
mklink /J node_modules "%USERPROFILE%\.pi\agent\install\releases\<版本>\node_modules"
# Linux/macOS
ln -s ~/.pi/agent/install/releases/<版本>/node_modules node_modules
```
