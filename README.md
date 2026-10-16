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
- 高度自适应：视口按终端行数比例计算，resize 自动重算；渲染按宽度缓存
- 关闭：`Esc` / `q` / `Enter`

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
# 依赖解析依赖仓库根的 node_modules junction（指向 pi 安装目录的 node_modules）
node tests/render-harness.mjs
node tests/scroll-harness.mjs
```
