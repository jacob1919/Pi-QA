# pi-qa — Context Aggregation Extension for [Pi](https://pi.dev)

`extensions/aggregate-context.ts` opens a centered overlay window that aggregates every turn of the current session branch: your input plus the **final** assistant reply of each turn — the signal without the tool-call noise.

## Install

```bash
pi install npm:pi-qa
```

Or load it straight from a checkout while developing:

```bash
pi --extension ./extensions/aggregate-context.ts
```

## Usage

- **Shortcut:** `Alt+A`
- **Command:** `/aggregate`

## Aggregation rules

- Source is `ctx.sessionManager.getBranch()` — the active branch, without abandoned branches.
- One turn = everything between two consecutive user messages.
- Each turn keeps only its leading user input and its last assistant text; intermediate assistant messages (short notes before tool calls, etc.) are dropped.
- Tool calls, thinking blocks, system messages, tool results, branch summaries and compaction summaries do not participate.

## Display

- Compact layout: no role labels, no blank lines between blocks.
- User input in bold green; a green separator line between turns and between a turn's input and its output.
- Assistant output rendered as Markdown, same as in the session view.
- Centered overlay window: width 92% (capped at 120 columns), height 85% — the session stays visible underneath. The box is measured line-by-line with `visibleWidth()` and truncated with `truncateToWidth()`, so borders stay strictly aligned even with CJK/emoji wide characters.
- Scrolling: `↑↓`/`j k` one line, `PgUp PgDn` one page, `g`/`Home` top, `G`/`End` bottom, mouse wheel 3 lines per notch. The bottom bar shows `visible-range/total (percent)`.
- Copy: `y` copies the full plain text (below).
- Height adapts to the terminal and is recomputed on resize; rendering is cached per width.
- Close: `Esc` / `q` / `Enter`.

## Copy (`y`) — why mouse selection doesn't work

The window is an overlay painted on top of the session, while terminal mouse selection is screen-level: dragging across the window border — or selecting session text exposed outside it — pulls in the underlying session text, so you never get a clean excerpt.

So `y` copies the complete aggregated plain text (no ANSI colors, no borders, no window-width wrapping; input and reply separated by a blank line, turns separated by `---`) through pi's `copyToClipboard`:

- Windows/macOS: system clipboard.
- Linux: wl-copy/xclip/xsel.
- **SSH sessions automatically fall back to OSC 52, delivering the text to your local machine's clipboard** (needs terminal support; mainstream terminals enable it by default).

The bottom bar confirms with `Copied N characters to clipboard`, or shows the failure reason.

## About the Alt+A shortcut

The first iteration used `Ctrl+Shift+A`, but legacy terminals encode it identically to `Ctrl+A`, so pi could not tell them apart and it never fired (only the kitty keyboard protocol distinguishes them). `Alt+A` maps to `ESC a` reliably in every mainstream terminal, including Windows Terminal, and does not collide with pi's built-in bindings.

**macOS note:** Terminal.app sends the character `å` for Option+A by default. Set *Settings → Profiles → Keyboard → Option key acts as* `Esc+` (iTerm2: "Esc+" option) so Option+A sends `ESC a`.

## Development

```bash
npm install   # devDependencies: the two @earendil-works packages + jiti
npm test      # runs both harnesses
```

`tests/render-harness.mjs` and `tests/scroll-harness.mjs` drive the extension through jiti — the same runtime pi uses to load extensions — and assert:

- Turn folding: intermediate assistant output dropped, finals kept.
- Compact rendering: no labels, zero blank lines in the content area; user lines green+bold, exactly one green separator per boundary.
- Strict border alignment under CJK/emoji wide characters; uniform line width on normal, wide (box centered) and tiny terminals.
- Scrolling (line/page/top/bottom/wheel), clamping, close keys, resize adaptation, empty-session and non-TUI guards.
- Copy via `y`: plain text with `---` turn separators, feedback display, no clipboard side effects in tests (the copy function is injectable).

To test against your locally installed pi instead of the npm devDependencies, create a junction/symlink named `node_modules` pointing at its `node_modules` (see `~/.pi/agent/install/releases/<version>/node_modules`).

## Publishing

This is a standard npm package following the [pi package conventions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs/packages.md):

- `extensions/` is auto-discovered by pi — no manifest needed.
- `"keywords": ["pi-package"]` makes it show up in the [pi.dev package gallery](https://pi.dev/packages).
- Host-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) are `peerDependencies: "*"` — pi supplies them at runtime; they are never bundled.

Release flow:

```bash
npm test
npm publish --access public
```

## License

[MIT](LICENSE)
