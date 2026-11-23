# 1:1 Parity Audit: Right Panels, Modals, Command Palette & Overlays

> **Audit date:** 2026-11-22
> **Reference (T3 Conn):** `/Users/nckrtl/apps/conn/apps/web/src/` & `/Users/nckrtl/apps/conn/packages/shared/src/keybindings.ts`
> **Target (`conn-gpui`):** `/Users/nckrtl/apps/conn-gpui/crates/conn-app/src/` & `/Users/nckrtl/apps/conn-gpui/crates/conn-state/src/`
> **Scope authority:** `/Users/nckrtl/apps/conn-gpui/docs/scope.md` (locked v1 cutlist #1–#33)

## Legend

- `[x]` **Exact parity** (`TS file:line` -> `Rust file:line`)
- `[~]` **Partial / visual or behavioral drift** (`TS file:line` -> `Rust file:line` — exact diff)
- `[ ]` **Missing** (`TS file:line` — exact behavior, icon, tokens, props to port)
- `[-]` **Intentionally out of scope** (`docs/scope.md` item & reason)

## Executive Summary

| Surface | `[x]` Exact | `[~]` Drift | `[ ]` Missing | `[-]` Out of Scope | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 1. Right Panel Shell & Tabs | 11 | 7 | 8 | 2 | Core 44px chrome, tabs, add menu, resize, maximize match; missing per-thread persistence, DnD reorder, context menu, overflow arrows, empty launcher, PiP handoff |
| 2. Files Panel | 9 | 4 | 13 | 0 | Tree + code viewer match well; missing server search, breadcrumb dropdowns, split explorer, OpenInPicker, rich previews (MD/Mermaid/CSV/Image/Video/Audio/PDF), inline edit/review comments, horizontal scroll |
| 3. Diff & Git Panel | 8 | 5 | 9 | 0 | Diff engine & toolbar strong; file tree on wrong side + single-file only, reversed base->head arrow, missing collapse-all, hide tests, review comments, horizontal scroll, and entire `GitActionsControl` |
| 4. Terminal Panel / Drawer | 6 | 3 | 3 | 2 | Solid `alacritty_terminal` PTY + selection/clipboard; spawns local shell instead of `conn-server` `terminal.*` RPC, floating action bar overlaps content, missing "Add to chat" & link clicks |
| 5. Browser / Preview & Annotations | 8 | 5 | 10 | 2 | CEF offscreen, Vault logins, annotations + Operator dictation, docked Laravel summary; missing More (`⋮`) menu (DevTools/Zoom/Appearance/Clear), Device Viewport toolbar, Screenshot/Record, Element picker, full 8-panel Laravel Toolbar flyouts, Test Logins |
| 6. API Panel | 10 | 1 | 2 | 0 | Near-complete parity; missing `BrowserLaravelToolbar` below response (explicitly in scope #19) and `baseUrl` seeding |
| 7. Database Panel | 11 | 2 | 2 | 0 | Near-complete parity; missing SQL syntax highlighting in editor, pending Laravel Toolbar query handoff (`openDatabaseQuery`), and grouped Vault/Env labels in connection menu |
| 8. MCP Inspector Panel | 13 | 1 | 0 | 0 | Near-1:1 parity across Tools/Resources/Prompts/Log/Server + agent `mcp_connect`/`mcp_call` |
| 9. Tasks Panel (Orbit Board) | 8 | 2 | 0 | 0 | Native Orbit board + charts + detail; `open_pull_request` opens browser instead of inline PR panel, `open_agent_conversation` stubbed |
| 10. Pull Request & Linked Items | 17 | 4 | 6 | 2 | Very rich PR & Linked Items port; missing `PullRequestCheckoutMenu`, continuous multi-file Code tab + inline PR review annotations + split diff/whitespace/hide-tests, `Shift` speed actions, PR stack menu |
| 11. Device Panel | 13 | 3 | 3 | 3 | Live H264 stream, 3-step setup wizard, rail, tools drawer, annotations; missing Float PiP, Android Fold/Duo controls, AX element overlay frames; note `hosts.rs` currently includes out-of-scope EAS/Simlock forms |
| 12. Settings Modal | 10 | 4 | 25 | 19 | Only 5 pages (`General`, `Appearance`, `Connections`, `Scheduled tasks`, `Keyboard`); missing `Chat`, `Diffs & PRs`, `Threads`, `Browser`, `Passwords` (Vault+Test logins), `Devices`, `Projects`, `Providers` (subset), `Source control`, `Worktrees` (subset), `Maintenance`, `About`, plus many toggles on `General`/`Appearance` |
| 13. Command Palette & Search | 6 | 4 | 15 | 4 | `⌘K` works with fuzzy scoring + `>`; missing `⌘P` File Picker, `⌘⇧F` Project Content Search, `⌘F` Thread Find Bar, Settings search in palette, submenu stack (`New thread in...`, `Add project`, `New project`, `Change theme/appearance`), message content search |
| 14. Modals, Toasts & Shortcuts | 3 | 2 | 12 | 3 | Missing global Toast system (`toastManager`), `ConfirmDialogHost`, `WorkspaceDialog`, `ThreadDetailsPanel`, `ExpandedImageDialog`, `HtmlRenderDialog`, `ThreadPreviewMiniPlayer`, `PullRequestThreadDialog`, `QuitHoldOverlay`, and ~35 in-scope keyboard shortcuts |

---

## 1. Right Panel Shell & Tabs

**TS Sources:** `components/chat/ChatRightPanel.tsx`, `components/RightPanelTabs.tsx`, `components/RightPanelSheet.tsx`, `components/chat/RightPanelSurfaceContent.tsx`, `components/chat/PanelLayoutControls.tsx`, `components/preview/PreviewPanelShell.tsx`, `components/preview/RightPanelResizeHandle.tsx`, `components/chat/useRightPanelActions.ts`, `components/ui/panel-tab-close-button.tsx`
**Rust Sources:** `crates/conn-state/src/layout.rs`, `crates/conn-app/src/panels/{mod.rs,header.rs}`, `crates/conn-app/src/app.rs`

### Shell Layout, Header Chrome & Resize
- `[x]` **44px transparent right-panel header height & edge insets** (`RightPanelTabs.tsx:1487`, `PreviewPanelShell.tsx:58-68` -> `panels/header.rs:23-29,289-302`: `HEADER_HEIGHT_PX = 44.0`, `pl-2` = 8px, `pr` = 11px).
- `[x]` **Concentric card framing (`14px` `--shell-corner`, `4px` inset, `0.5px` inner border, two-tone `1px` seam divider)** (`ChatRightPanel.tsx:82-120`, `PreviewPanelShell.tsx:48-77` -> `app.rs:3219-3298`).
- `[x]` **Interactive seam resize handle (`RightPanelResizeHandle`) with `600px` default & double-click reset** (`RightPanelResizeHandle.tsx:24-88`, `ChatRightPanel.tsx:66-75` -> `app.rs:568-616,3205-3217`, `conn-state/src/layout.rs:17-19`).
- `[x]` **Maximize / Restore panel toggle (`Maximize2` / `Minimize2`) hiding chat column while preserving sidebar** (`RightPanelTabs.tsx:1619-1632`, `ChatRightPanel.tsx:47-65` -> `panels/header.rs:374-386`, `app.rs:2446-2454,3219-3252`).
- `[x]` **Tab geometry (`h-7` = 28px, `max-w-40` = 160px, `rounded-lg` = 8px, active `bg-(--shell-highlight)` fill)** (`RightPanelTabs.tsx:969-992` -> `panels/header.rs:199-242`).
- `[x]` **Leading icon -> hover `X` close swap (`PanelTabCloseButton`) & middle-click closes tab** (`panel-tab-close-button.tsx:1-58`, `RightPanelTabs.tsx:940-965` -> `panels/header.rs:208-237,275-282`).
- `[x]` **Add-panel (`+`) dropdown menu with `dropdown-glass` styling, section dividers, and right-aligned `MenuShortcut` letters** (`RightPanelTabs.tsx:480-610,1495-1565` -> `panels/header.rs:422-575`).
- `[x]` **Single-key shortcuts while `+` menu is open (`B, R, Q, I, K, T, F, D, P, L, M`) + `Escape` dismiss** (`RightPanelTabs.tsx:491-565` -> `app.rs:2368-2394`).
- `[x]` **Separate file tabs per opened file path (deduped by path, ordered beside other surfaces)** (`RightPanelTabs.tsx:148-175` -> `conn-state/src/layout.rs:48-115`, `app.rs:1805-1840`).
- `[x]` **Agent-opened surfaces (`panel_open`, `database_query`, `mcp_connect`, `mcp_call`) auto-reveal right panel and activate target tab** (`docs/scope.md` #25, `useRightPanelActions.ts:120-165` -> `app.rs:2515-2610`).
- `[x]` **Header `PanelRight` toggle button (`⌘⌥B`) in chat topbar** (`PanelLayoutControls.tsx:110-130` -> `header/mod.rs`, `app.rs:29,2440-2445`).

### Drift (`[~]`)
- `[~]` **Per-thread right panel state persistence** (`RightPanelTabs.tsx:102-135`, `useRightPanelStore.byThreadKey` -> `app.rs:79-83`): Conn stores open tabs, active surface, visibility, width, and maximized state **per thread** so switching threads restores each thread's open surfaces/files; `conn-gpui` keeps a single global `right_panel_open_tabs` / `right_panel_tab` / `right_panel_maximized` on `ConnApp`.
- `[~]` **Closing the last tab vs `RightPanelEmptyState` launcher** (`RightPanelTabs.tsx:333-475,1635` -> `app.rs:1841-1849`): Conn keeps the right panel open on an `"Open a surface"` vertical launcher (keyboard arrows + Enter + single-key shortcuts `B, R, Q, I, T, F, D, P, L, M`) when `activeSurfaceId === null` or when opening an empty panel; `conn-gpui` collapses the right panel whenever the last tab closes and has no empty-state launcher.
- `[~]` **Dynamic tab titles, favicons, PR state glyphs, dirty dots, and audio mute indicator** (`RightPanelTabs.tsx:660-765,831-893` -> `panels/header.rs:73-139`): Conn shows live browser page title + `<img favicon>`, PR `#number` with state-colored PR icon, Device target/custom name with Apple/Android glyph, `pending` dirty dot for unsaved file edits, and clickable browser audio indicator (`Volume2`/`VolumeOff`); `conn-gpui` only customizes `File` tabs (basename + file icon) and renders static `"Browser"`, `"Pull request"`, `"Device"` labels and icons.
- `[~]` **Dead "Dock panel to bottom" button in right panel header** (`PanelLayoutControls.tsx:87-108` -> `panels/header.rs:363-373`, `app.rs:2455-2457`): `panels/header.rs` renders `panel-bottom.svg` ("Dock panel to bottom"), whose handler in `app.rs:2455` only logs `eprintln!("right panel: dock to bottom is not implemented yet")`. In Conn, that icon lives in the chat header (`PanelLayoutControls`) to toggle the bottom terminal drawer (deferred in `docs/scope.md` #16), not in the right panel header.
- `[~]` **Stray right chevron on `Browser` in `+` add menu** (`RightPanelTabs.tsx:576-601,1517-1551` -> `panels/header.rs:520-527`): `conn-gpui` draws a trailing `chevron-right` on `Browser` as if it opened a multi-profile submenu, but multi-profile tabs are `Drop` (#31) and no submenu exists.
- `[~]` **Multiple browser tabs (`browser:<tabId>`)** (`RightPanelTabs.tsx:180-210` -> `conn-state/src/layout.rs:21-38`): Conn allows opening multiple concurrent Browser tabs per thread (`+` -> Browser creates a new tab id); `conn-gpui` uses a singleton `RightPanelTab::Browser`.
- `[~]` **Right-panel surface keep-alive vs unmount on tab switch** (`RightPanelSurfaceContent.tsx:55-120` -> `panels/mod.rs:135-190`): Conn keeps `Terminal`, `Browser`, and `Device` mounted while hidden to preserve scroll/PTY/stream state; verify `conn-gpui` entities stay alive (they are owned `Entity<...>` on `RightPanel` so state survives, EXCEPT `DevicePanel::set_visible` stops streams when hidden and `BrowserPanel` loses scroll offset if re-instantiated).

### Missing (`[ ]`)
- `[ ]` **Drag-to-reorder right panel tabs** (`RightPanelTabs.tsx:895-920,1455-1485`): Horizontal `@dnd-kit/sortable` drag reordering of open tabs in the header strip with drop animation and persistence.
- `[ ]` **Tab right-click context menu** (`RightPanelTabs.tsx:1266-1348`): `Rename` (device tab), `Copy path` (file tab), `Mute tab` / `Unmute tab` (browser tab), `Close`, `Close others`, `Close to the right`, `Close all`.
- `[ ]` **Tab strip overflow scroll arrows (`<` / `>`) + wheel-to-horizontal-scroll + auto scroll active tab into view** (`RightPanelTabs.tsx:1134-1160,1371-1409,1570-1613`): `ChevronLeft` / `ChevronRight` scroll buttons when tabs overflow, mouse wheel vertical-to-horizontal scrolling on the tab strip, and scrolling newly activated tabs into view.
- `[ ]` **Tab hover tooltips & disabled-reason tooltips in `+` menu** (`RightPanelTabs.tsx:302-331,1039-1066`): Full title/URL/path tooltip on truncated tabs, `DeviceTabTooltip` (host + OS version), and explanatory tooltips on disabled items in the `+` menu (e.g., when no project/git repo).
- `[ ]` **Right panel keyboard shortcuts** (`useRightPanelActions.ts:330-341`, `keybindings.ts:157-166`): `⌘T` (`rightPanel.new` — opens `+` menu when panel open), `⌘W` (`rightPanel.close` — closes active right panel tab instead of closing the macOS window when right panel has tabs!), `⌘D` (`diff.toggle`), `⌘⇧J` (`preview.toggle`), `⌘J` (`terminal.toggle`), `⌘⇧T` (`view.reopenClosed`).
- `[ ]` **Narrow-viewport `RightPanelSheet` overlay** (`RightPanelSheet.tsx:1-95`): When the window width is too narrow for side-by-side chat + right panel, Conn renders the right panel as an inset sheet overlay rather than crushing chat/panel widths.
- `[ ]` **Floating mini-player handoff on closing active Browser/Device tab** (`useRightPanelActions.ts:169-185`): Option / auto-handoff to `ThreadPreviewMiniPlayer` when closing a running Browser/Device surface if `browserAutoShowFloatingPreview` or active recording.
- `[ ]` **Reopen closed tab history (`view.reopenClosed`, `⌘⇧T`)** (`components/ReopenClosedViewShortcut.tsx`, `useRightPanelActions.ts:190-220`): Stack of closed right-panel tabs/files per thread restored via `⌘⇧T`.

### Out of Scope (`[-]`)
- `[-]` **Side chat right-panel tab (`Side chat`, shortcut `S`)** (`RightPanelTabs.tsx:454-466`) — `docs/scope.md` #29 (`Drop`: "Multi-window covers side-by-side threads cleanly").
- `[-]` **Browser multi-profile submenu in `+` menu (`Profile` picker)** (`RightPanelTabs.tsx:576-601,1517-1551`) — `docs/scope.md` #31 (`Drop`: "One shared browser session/profile").

---

## 2. Files Panel

**TS Sources:** `components/files/FileBrowserPanel.tsx`, `components/files/FilePreviewPanel.tsx`, `components/files/FileExplorerPane.tsx`, `components/files/FileBreadcrumbs.tsx`, `components/files/ReadOnlySourcePreview.tsx`, `components/files/MediaPreview.tsx`
**Rust Sources:** `crates/conn-app/src/panels/files.rs`, `crates/conn-app/src/panels/tree.rs`, `crates/conn-app/src/file_icons.rs`

### Exact Parity (`[x]`)
- `[x]` **Soft pill search input (`Search files`) with leading search icon** (`FileBrowserPanel.tsx:470-496` -> `panels/files.rs:315-347`).
- `[x]` **Toolbar action group: Refresh + Expand/Collapse all folders (skipping ignored dirs)** (`FileBrowserPanel.tsx:498-534` -> `panels/files.rs:349-382`).
- `[x]` **Lazy directory loading via `projects.listEntries` RPC with sorted folders-first tree** (`FileBrowserPanel.tsx:125-167` -> `panels/files.rs:140-210`, `panels/tree.rs:45-165`).
- `[x]` **28px tree rows with `@pierre/trees` file/folder icons and dimmed gitignored styling** (`FileBrowserPanel.tsx:270-360` -> `panels/files.rs:402-468`, `file_icons.rs`).
- `[x]` **Opening a file launches a dedicated `RightPanelTab::File` tab using `projects.readFile`** (`FileBrowserPanel.tsx:310-335`, `FilePreviewPanel.tsx:310-390` -> `panels/files.rs:530-610`).
- `[x]` **Syntax-highlighted source preview (`syntect` mapped to active theme) with line numbers** (`ReadOnlySourcePreview.tsx` -> `panels/files.rs:640-755`, `panels/highlight.rs`).
- `[x]` **Word wrap toggle (`wrap-lines.svg`) in file preview subheader** (`FilePreviewPanel.tsx:1292-1305` -> `panels/files.rs:492-502`).
- `[x]` **Copy file contents button (`copy.svg`) in file preview subheader** (`FilePreviewPanel.tsx:1306-1317` -> `panels/files.rs:503-513`).
- `[x]` **Truncation notice banner for oversized files** (`FilePreviewPanel.tsx:1420-1435` -> `panels/files.rs:625-638`).

### Drift (`[~]`)
- `[~]` **Tree search scope & UX** (`FileBrowserPanel.tsx:101-105,168-173,295-300,537-545` -> `panels/tree.rs:172-182`, `panels/files.rs:315-398`): Conn calls server `projects.searchEntries` (200ms debounce) so searching finds files inside **unexpanded** nested directories, shows `"More matches available. Refine your search."`, clears on `Escape`, shows a spinner on loading directories, and renders a click-to-retry error banner. `conn-gpui` only filters already-loaded directories client-side, lacks Escape-to-clear, lacks per-folder spinner, and has no retry button on error.
- `[~]` **File preview breadcrumbs** (`FileBreadcrumbs.tsx:1-215`, `FilePreviewPanel.tsx:1255-1272` -> `panels/files.rs:766-790`): Conn renders interactive per-segment clickable breadcrumbs, a `FolderContentsMenu` chevron dropdown on each directory to jump to sibling files/subfolders, an `ArrowLeft` parent-folder button, and horizontal scroll fades. `conn-gpui` renders non-interactive static `dir / filename` text.
- `[~]` **Auto-refresh on workspace mutations** (`FileBrowserPanel.tsx:388-395`, `FilePreviewPanel.tsx:1170-1182` -> `panels/files.rs`): Conn automatically reloads the tree and active file preview whenever `workspaceMutationId` ticks (e.g. after agent file edits); `conn-gpui` only refreshes on manual Refresh button click.
- `[~]` **Subheader button tooltips & copy checkmark feedback** (`FilePreviewPanel.tsx:1292-1317` -> `panels/files.rs:349-382,492-515`): `files-refresh-btn`, `files-toggle-expand-btn`, `files-preview-wrap-btn`, and `files-preview-copy-btn` lack `.conn_tooltip(...)` and the Copy button does not morph to a `Check` icon for 1.2s after copying.

### Missing (`[ ]`)
- `[ ]` **Horizontal scrolling when word wrap is off** (`ReadOnlySourcePreview.tsx:45-90` vs `panels/files.rs:703-705`): `panels/files.rs` applies `.overflow_hidden().whitespace_nowrap()`, silently **clipping** lines wider than the viewport instead of allowing horizontal scroll.
- `[ ]` **Toggleable split `FileExplorerPane` inside file preview tabs** (`FilePreviewPanel.tsx:1323-1331,1541-1567`, `FileExplorerPane.tsx:1-145`): Toolbar `FolderTreeIcon` button toggling a resizable (`160px–560px`, persisted width & open state) right-side file tree pane while viewing any file.
- `[ ]` **`OpenInPicker` button in file preview subheader** (`FilePreviewPanel.tsx:1273-1285`): Open current file in preferred external editor (VS Code, Cursor, Zed, Xcode, etc.) or Reveal in Finder.
- `[ ]` **Rendered Markdown preview toggle (`Eye` / `Code2`) + interactive task-list checkboxes** (`FilePreviewPanel.tsx:919-968,1495-1506`): Preview `.md`/`.mdx` as formatted Markdown with clickable `- [ ]` checkbox toggling that writes back to disk.
- `[ ]` **Mermaid diagram preview toggle** (`FilePreviewPanel.tsx:1491-1494`): Render `.mmd`/`.mermaid` files as diagrams with source/preview toggle.
- `[ ]` **CSV / TSV `DelimitedTablePreview` toggle** (`FilePreviewPanel.tsx:1507-1513`): Tabular grid preview for `.csv`/`.tsv` files with source toggle.
- `[ ]` **HTML preview + "Open file in preview browser" (`Globe2`) button** (`FilePreviewPanel.tsx:1318-1322,1405-1415`): Live sandboxed preview toggle and one-click open in Browser panel.
- `[ ]` **Rich media & document previews (`Image`, `Video`, `Audio`, `PDF`, `Font`, `Office`, `Binary`, `LargeText > 1MB`)** (`FilePreviewPanel.tsx:1360-1490`): `PreviewImage` with zoom/pan + `MediaActions` (copy/save/open), HTML5 video/audio players, PDF viewer, font specimen preview, binary hex/metadata card, and large-file prompt.
- `[ ]` **Inline file editing with autosave (`EditableFileSurface`, `EditProvider`)** (`FilePreviewPanel.tsx:670-810`): Toggle edit mode or direct editing of text files with dirty dot on tab (`pending`) and debounced save via `projects.writeFile`.
- `[ ]` **Inline line-selection review comments -> composer** (`FilePreviewPanel.tsx:811-917`, `DiffCommentAnnotation.tsx`): Click/drag line numbers in file preview to attach a `path:start-end` review comment card directly to the thread composer draft.
- `[ ]` **Line reveal & highlight (`revealLine`)** (`FilePreviewPanel.tsx:433-594`): Opening `file.rs:42` from chat or search scrolls line 42 to center and applies a brief highlight flash.
- `[ ]` **Tree row right-click context menu** (`FileBrowserPanel.tsx:183-264`): `Open with…`, `Reveal in Finder`, `Copy relative path`, `Copy full path`, `Copy @mention`, `Add to chat`.
- `[ ]` **Drag file from tree onto composer to insert `@mention`** (`FileBrowserPanel.tsx:245-264`): Dragging a file row drops an `@path` mention into the active composer.

---

## 3. Diff & Git Panel

**TS Sources:** `components/DiffPanel.tsx`, `components/DiffPanelShell.tsx`, `components/diffs/{DiffFileTree.tsx,AnnotatableCodeView.tsx,DiffCommentAnnotation.tsx,StyledDiffCodeView.tsx}`, `components/GitActionsControl.tsx`
**Rust Sources:** `crates/conn-app/src/panels/diff.rs`, `crates/conn-app/src/panels/diff_parser.rs`

### Exact Parity (`[x]`)
- `[x]` **Diff scopes (`Changes`, `Uncommitted`, `Commits`, `Turn N`) backed by `review.getDiffPreview` / `git.status`** (`DiffPanel.tsx:420-520` -> `panels/diff.rs:140-360`).
- `[x]` **Base-ref selector with `Automatic` + branch refs** (`DiffPanel.tsx:956-1020` -> `panels/diff.rs:772-860`).
- `[x]` **Ignore whitespace toggle (`PilcrowIcon` / `pilcrow`)** (`DiffPanel.tsx:1163-1182` -> `panels/diff.rs:990-1016`).
- `[x]` **Unified (Stacked) and Side-by-side (Split) diff renderers with line numbers** (`DiffPanel.tsx:1320-1390` -> `panels/diff.rs:1330-1565`).
- `[x]` **Word wrap toggle (`wrap-lines.svg`) in diff toolbar** (`DiffPanel.tsx:1184-1202` -> `panels/diff.rs:1047-1070`).
- `[x]` **File tree visibility toggle (`file-tree.svg`) & resizable split handle** (`DiffPanel.tsx:1227-1244` -> `panels/diff.rs:1072-1095,1575-1600`).
- `[x]` **`+add / -del` stat badges in toolbar & per-file rows** (`DiffPanel.tsx:1100-1118` -> `panels/diff.rs:950-985,1220-1255`).
- `[x]` **Theme-derived `color_mix_srgb` line & gutter diff tints + `syntect` syntax highlighting** (`DiffPanel.tsx:1350-1385` -> `panels/diff.rs:1340-1425`).

### Drift (`[~]`)
- `[~]` **File tree placement, hierarchy & continuous multi-file diff** (`DiffPanel.tsx:1320-1468`, `DiffFileTree.tsx` -> `panels/diff.rs:1575-1600`): Conn renders **all changed files continuously** in one virtualized scroll view with collapsible per-file headers, and places the hierarchical folder `DiffFileTree` on the **RIGHT** side (default closed; clicking a file scrolls to it). `conn-gpui` puts a **flat** file list on the **LEFT** side (default open) and renders only **one selected file at a time**.
- `[~]` **Scope picker menu structure** (`DiffPanel.tsx:825-954` -> `panels/diff.rs:536-768`): Conn offers `Changes`, `Uncommitted`, `Latest turn`, a `Turn` submenu with timestamps, a `Commits` submenu with relative time + clickable commit SHA links to GitHub, plus `Tool call` diff mode (`diffSelection.kind === "tool-call"`). `conn-gpui` uses a single flat dropdown (`Changes (branch)`, `Uncommitted`, up to 12 commits without timestamps/links, `All turns` + `Turn N`), omitting `Latest turn` and `Tool call` diff inspection.
- `[~]` **Base-ref picker arrow direction & search** (`DiffPanel.tsx:956-1084` -> `panels/diff.rs:772-904`): Conn displays `head → [base combobox]` with a search input and a per-branch `Remote` switch toggle; `conn-gpui` displays `base → head` (**reversed arrow direction**) with an unsearchable flat list and no `Remote` toggle.
- `[~]` **Stacked vs Split layout switcher & persistence** (`DiffPanel.tsx:1143-1161` -> `panels/diff.rs:1018-1045`): Conn uses a 2-button segmented `ToggleGroup` (`Rows3Icon` Stacked + `Columns2Icon` Split) persisted to `settings.diffLayout`; `conn-gpui` uses a single ephemeral toggle icon button.
- `[~]` **Refresh & loading state** (`DiffPanelShell.tsx:92-116`, `DiffPanel.tsx:595-608` -> `panels/diff.rs:340-395`): Conn renders a `DiffPanelLoadingState` skeleton and auto-refreshes when the panel becomes visible or `workspaceMutationId` increments; `conn-gpui` shows a plain spinner and lacks automatic workspace-mutation refresh.

### Missing (`[ ]`)
- `[ ]` **Horizontal scrolling for unwrapped diff lines** (`panels/diff.rs:1433-1435,1517-1519`): Both Unified and Split modes use `.overflow_hidden().whitespace_nowrap()`, clipping long lines when word wrap is off instead of horizontal scrolling.
- `[ ]` **Per-file collapse/expand & toolbar Expand/Collapse all files (`ChevronsDownUp`/`ChevronsUpDown`)** (`DiffPanel.tsx:134-172,1120-1142`): Collapsing individual files, respecting `settings.diffFilesCollapsed`, and toggling all files at once.
- `[ ]` **Hide test files toggle (`FlaskConicalOffIcon`)** (`DiffPanel.tsx:1204-1225`): Toolbar toggle filtering out test files (`isTestChangedFile`) with persisted state and hidden-count indicator.
- `[ ]` **Inline diff review comment annotations -> composer** (`DiffPanel.tsx:1388-1451`, `AnnotatableCodeView.tsx`, `DiffCommentAnnotation.tsx`): Hover `+` / click-drag line gutter to leave line-range review notes that attach as structured review comments in the thread composer.
- `[ ]` **Diff file header actions & sticky headers** (`DiffPanel.tsx:1339-1450`): Sticky file header bar while scrolling, click filename to open in Files/Editor, `DiffFilePathCopyButton` (`Copy` -> `Check`), right-click file context menu, and `DiffFileStatus` truncation/error + retry button.
- `[ ]` **Expandable hidden context lines between hunks** (`DiffPanel.tsx:1380-1395`): Clickable hunk separator controls (`expand up` / `expand down` / `expand all`) loading full file lines via `review.getDiffFileContents`.
- `[ ]` **Diff colorblind scheme (`Red & green` vs `Blue & orange`)** (`SettingsPanels.tsx:1241-1292` -> `conn-theme`): Applying `settings.diffColorScheme` to diff backgrounds, gutters, and `+`/`-` stats.
- `[ ]` **Git Actions Control (`GitActionsControl.tsx`)** (`GitActionsControl.tsx:1-920`): Complete Git workflow control (hosted in `ThreadDetailsPanel` / header):
  - Split primary action button + dropdown: `Commit`, `Commit & push`, `Commit & create PR`, `Push`, `Pull`, `Create PR`, `Open PR`, `Publish repository` (GitHub only per `docs/scope.md` #23).
  - Commit modal with custom commit message textarea (or AI-generated if left blank), per-file checkboxes / stage selection, and "Default branch confirmation" dialog (`Commit on main` vs `Create new branch & commit`).
  - Behind/ahead count badges and live git status refresh.
- `[ ]` **Stage / Unstage / Revert individual files or hunks** (`GitActionsControl.tsx`): Interactive file inclusion in commit dialog and discard/revert confirmation flows.

---

## 4. Terminal Panel / Drawer

**TS Sources:** `components/chat/ChatTerminalDrawers.tsx`, `components/ThreadTerminalDrawer.tsx`
**Rust Sources:** `crates/conn-app/src/panels/terminal.rs`

### Exact Parity (`[x]`)
- `[x]` **Real VT100/xterm terminal emulation (`alacritty_terminal` 0.26) with resize/scrollback** (`ThreadTerminalDrawer.tsx:1-350` -> `panels/terminal.rs:1-255`).
- `[x]` **Active Conn theme color palette sync (16 ANSI + fg/bg/cursor)** (`ThreadTerminalDrawer.tsx:355-405` -> `panels/terminal.rs:580-660`).
- `[x]` **Mouse text selection (char, double-click word, triple-click line) & drag highlight** (`ThreadTerminalDrawer.tsx` -> `panels/terminal.rs:420-530`).
- `[x]` **Clipboard & selection shortcuts (`⌘C` copy, `⌘V` paste, `⌘A` select all)** (`ThreadTerminalDrawer.tsx:610-660` -> `panels/terminal.rs:535-578`).
- `[x]` **Full keyboard & IME text input handling** (`ThreadTerminalDrawer.tsx` -> `panels/terminal.rs:360-418`).
- `[x]` **Clear & Restart terminal controls + process exit status banner** (`ThreadTerminalDrawer.tsx:1832-1910` -> `panels/terminal.rs:680-780`).

### Drift (`[~]`)
- `[~]` **Local macOS login shell vs `conn-server` `terminal.*` RPCs** (`ThreadTerminalDrawer.tsx:200-350` -> `panels/terminal.rs:257-304`): `panels/terminal.rs` spawns a local `portable-pty` shell on the Mac regardless of which Orbit Node/Instance the thread runs on. Conn streams PTY I/O over `conn-server`'s `terminal.open` / `terminal.write` / `terminal.resize` / `terminal.clear` / `terminal.close` + `terminal.subscribe` RPCs so remote servers get their actual remote shell and shared sessions survive reload.
- `[~]` **Floating Clear/Restart buttons overlap terminal top-right** (`ThreadTerminalDrawer.tsx:1832-1910` -> `panels/terminal.rs:725-775`): Conn renders a dedicated non-overlapping 22px top header bar (`border-b`); `conn-gpui` floats Clear + Restart `absolute top-2 right-2` over terminal output, with no tooltips and no `⌘K` shortcut to clear scrollback.
- `[~]` **Terminal font family & size settings** (`ThreadTerminalDrawer.tsx:440-465` -> `panels/terminal.rs:60-85`): Conn binds font family, font size, and line height to `settings.fontFamilyTerminal` / `fontSizeTerminal` / `lineHeightTerminal`; `conn-gpui` hardcodes `MONO_FONT` and fixed font size.

### Missing (`[ ]`)
- `[ ]` **Add terminal selection to chat (`onAddTerminalContext`)** (`ThreadTerminalDrawer.tsx:408-434,1780-1820`): Floating pill / context-menu action `"Add to chat"` (and shortcut `⌘L` in terminal) capturing selected lines + line range into a structured composer terminal-context chip.
- `[ ]` **Terminal right-click context menu** (`ThreadTerminalDrawer.tsx:1740-1825`): `Add to chat`, `Copy`, `Paste`, `Select all`, `Clear`, `Jump to bottom`.
- `[ ]` **Clickable URLs & file paths (`onLinkActivate`)** (`ThreadTerminalDrawer.tsx:470-530`): `⌘`-click (or click) on URLs opens browser/external link; `⌘`-click on `path/to/file.rs:42` opens the file in Files panel at line 42.

### Out of Scope (`[-]`)
- `[-]` **Multi-tab terminal drawer, horizontal/vertical splits (`⌘D` / `⌘⇧D`), and bottom-dock layout (`ChatTerminalDrawers.tsx`)** (`ThreadTerminalDrawer.tsx:1300-1479,1832-1910`) — `docs/scope.md` #16 (`Subset`: "Defer multi-tab/split terminals & bottom-dock layout until actually missed").
- `[-]` **Terminal close confirmation dialog for multi-split tabs** (`ThreadTerminalDrawer.tsx:1500-1545`) — tied to deferred multi-tab/split layout (`docs/scope.md` #16).

---

## 5. Browser / Preview & Annotations

**TS Sources:** `components/preview/{PreviewPanel.tsx,PreviewChromeRow.tsx,PreviewEmptyState.tsx,PreviewMoreMenu.tsx,PreviewView.tsx,PreviewUnreachable.tsx}`, `browser/BrowserDeviceToolbar.tsx`, `annotations/{BrowserAnnotationControl.tsx,AnnotationQueuePopover.tsx}`, `laravelToolbar/{BrowserLaravelToolbar.tsx,ui/ToolbarBar.tsx,ui/panels.tsx,ui/requests.tsx,ui/orbit.tsx}`
**Rust Sources:** `crates/conn-app/src/panels/browser.rs`, `crates/conn-app/src/panels/annotations.rs`

### Exact Parity (`[x]`)
- `[x]` **Back / Forward / Reload toolbar group (`ToolbarGroup`)** (`PreviewChromeRow.tsx:130-175` -> `panels/browser.rs:2575-2638`).
- `[x]` **Soft pill URL address bar (`soft_input_group`)** (`PreviewChromeRow.tsx:179-244` -> `panels/browser.rs:2640-2668`).
- `[x]` **CEF-on-demand offscreen webview rendering (`conn-web`) with mouse, wheel, keyboard, and IME forwarding** (`PreviewView.tsx` -> `panels/browser.rs:450-1280`).
- `[x]` **Vault HTTPS credential autofill popover (`User`, `Password`, `OTP` + `Unlock Vault…`)** (`PreviewChromeRow.tsx:246-250`, `browser/CredentialFillPopover.tsx` -> `panels/browser.rs:1500-1720,2670-2735`).
- `[x]` **Browser annotation mode injection (`@t3tools/annotation-overlay` IIFE) with pin placement & Operator voice dictation** (`BrowserAnnotationControl.tsx`, `browserAnnotations.ts` -> `panels/browser.rs:1285-1495`, `panels/annotations.rs:1-420`).
- `[x]` **Annotations queue popover (Waiting / Working / Question / Done groups, `Send N to thread`, `Watch` toggle, `Clear done`, `Remove idle` with 2-click confirm)** (`AnnotationQueuePopover.tsx:1-340` -> `panels/annotations.rs:425-795`).
- `[x]` **Agent `preview_*` automation hooks (`open`, `navigate`, `snapshot`, `act`, `eval`, `screenshot`, `resize`, `set_appearance`, `dialog`)** (`PreviewView.tsx` -> `panels/browser.rs:900-1260`, `automation.rs`).
- `[x]` **Laravel Toolbar HTTP header capture & docked bottom summary strip** (`laravelToolbar/headers.ts` -> `panels/browser.rs:2047-2157`).

### Drift (`[~]`)
- `[~]` **URL bar ergonomics & search fallback** (`PreviewChromeRow.tsx:179-244,330-335` -> `panels/browser.rs:252-273,2640-2665`): Conn uses `Search` icon, placeholder `"Search or enter URL"`, `resolveAddressBarInput` (routes non-URLs to configured search engine), selects all on focus, `Escape` reverts & blurs, shows a hover-revealed `"Open in system browser"` (`ExternalLink`) button inside the pill, and paints a `2px` animated loading progress bar along the bottom edge of the chrome row. `conn-gpui` uses `globe.svg`, placeholder `"Enter URL..."`, prepends `http://` only (breaks search queries), lacks Esc revert, lacks external-browser button, and has no loading progress bar.
- `[~]` **Browser empty state** (`PreviewEmptyState.tsx:1-225` -> `panels/browser.rs:2393-2400,2528-2556`): Conn renders `"Recently used"` history cards (with per-card remove `X`), auto-discovered `"Local servers"` cards (active dev ports on the machine), and a centered `"No preview yet"` empty state; `conn-gpui` only displays plain text `"Press Enter in the URL bar to load a page."` on `about:blank`.
- `[~]` **Annotations control interaction & global shortcut** (`AnnotationQueuePopover.tsx:78-107`, `BrowserAnnotationControl.tsx:129-138` -> `panels/browser.rs:2675-2720`): Conn uses a single button (click toggles annotating, hover opens queue popover, `⌘⇧A` toggles annotating while preview focused); `conn-gpui` splits it into two click-only buttons (`Annotate` + `Queue`) and does not bind `⌘⇧A`.
- `[~]` **Laravel Toolbar depth (`ToolbarBar.tsx` 8 flyout panels)** (`laravelToolbar/ui/ToolbarBar.tsx:29-50,158-334` -> `panels/browser.rs:2047-2157`): Conn's bottom bar has 8 hover-to-preview / click-to-pin resizable flyout sheets (`Requests` history, `Request` headers/payload/session/route, `Timings` waterfall, `Memory`, `Database` queries with duplicate/slow amber badge + click-to-open in Database panel, `Models`, `Orbit` status/warnings, `Environment` Laravel/Symfony + PHP versions) with progressive backdrop blur. `conn-gpui` only shows a 28px single-line text summary (`Laravel · METHOD STATUS · URI · duration · N SQL · memory · 1/N · clear`) with no flyout inspector panels.
- `[~]` **Credential popover Test Logins integration** (`browser/CredentialFillPopover.tsx` -> `panels/browser.rs:1500-1650`): `panels/browser.rs` queries the local Mac Vault bridge for HTTPS logins, but does not merge `conn-server`'s saved **Test logins** (`credentials.list` / `save_test_login` / `request_credentials`).

### Missing (`[ ]`)
- `[ ]` **Preview More (`⋮`) menu (`PreviewMoreMenu.tsx`)** (`PreviewMoreMenu.tsx:1-310`): `Hard reload` (`⌘⇧R`), `Open DevTools` (attached/detached CEF DevTools), `Open in separate window` (native PiP), `Show/Hide device toolbar`, `Appearance` radio (`System` / `Light` / `Dark`), inline `Zoom` stepper (`-` / `100%` / `+` + Reset + `ZoomIndicator` pill in chrome row), `Clear cookies`, `Clear cache`.
- `[ ]` **Browser Device / Viewport Toolbar (`BrowserDeviceToolbar.tsx`)** (`BrowserDeviceToolbar.tsx:1-260`): Collapsible bar beneath chrome row with Responsive + device preset selector (iPhone SE/14 Pro Max, Pixel 7, iPad Air/Pro, etc.), editable `W × H` inputs, aspect-ratio lock toggle, Rotate orientation button, and Close button.
- `[ ]` **Screenshot & Video Recording button (`Camera`, `PreviewChromeRow.tsx:278-302`)**: Click saves screenshot with toast (`Copy image`, `Copy path`, `Reveal in Finder`); `Shift+Click` starts/stops screen recording with red recording timer badge + key/mouse press overlay options.
- `[ ]` **Float preview over chat (PiP) toggle (`PictureInPicture2`, `PreviewChromeRow.tsx:303-326`)**: Moves active browser tab into `ThreadPreviewMiniPlayer` floating over the chat pane.
- `[ ]` **Element Picker / Region / Drawing screenshot-to-composer (`MousePointerClick`, `PreviewChromeRow.tsx:251-276`)**: Pick a DOM element, drag a region, or freehand draw over the page to attach an annotated screenshot + selector context directly into the chat composer.
- `[ ]` **Unreachable / SSL / Navigation error page (`PreviewUnreachable.tsx`)** (`PreviewUnreachable.tsx:1-145`): Structured error card when a local server or host fails to connect, with `Retry`, URL details, and dev-server hint.
- `[ ]` **`AgentBrowserCursor` live overlay** (`browser/AgentBrowserCursor.tsx`): Visual cursor/ripple indicator showing where an AI agent clicks or types during `preview_act`.
- `[ ]` **Browser keyboard shortcuts** (`keybindings.ts:167-173`, `chatRouteCommands.ts:146-169`): `⌘L` (focus & select URL bar), `⌘R` (reload), `⌘⇧R` (hard reload), `⌘[`/`⌘]` (back/forward), `⌘+`/`⌘-`/`⌘0` (zoom in/out/reset), `⌘⇧A` (toggle annotations).
- `[ ]` **JS dialog prompt UI (`alert`/`confirm`/`prompt`)** (`PreviewView.tsx:410-465`): Interactive inline banner/dialog when a webpage triggers `window.alert`/`confirm`/`prompt` (currently only handled via automation `preview_dialog`).
- `[ ]` **Context menu on webview** (`PreviewView.tsx`): Native right-click menu (`Back`, `Forward`, `Reload`, `Copy link address`, `Inspect element` -> DevTools).

### Out of Scope (`[-]`)
- `[-]` **Multi-profile browser tabs & profile switcher pill** (`PreviewChromeRow.tsx:95-128`) — `docs/scope.md` #17 & #31 (`Drop`: "One shared browser session/profile").
- `[-]` **Chrome / Arc / Safari browser profile import wizard** (`settings/BrowserImportWizard.tsx`) — `docs/scope.md` #31 (`Drop`).

---

## 6. API Panel

**TS Sources:** `api/ApiPanel.tsx`, `api/ApiRequestEditor.tsx`, `api/ApiResponseView.tsx`, `api/ApiTabs.tsx`
**Rust Sources:** `crates/conn-app/src/panels/api.rs`

### Exact Parity (`[x]`)
- `[x]` **Requests selector dropdown (`Requests` / saved requests + `New request`, `Duplicate`, `Delete`)** (`ApiPanel.tsx:120-210` -> `panels/api.rs:250-390`).
- `[x]` **HTTP method dropdown (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`) with method-colored badge** (`ApiPanel.tsx:212-265` -> `panels/api.rs:395-470`).
- `[x]` **Soft pill URL input with `⌘↵` send shortcut** (`ApiPanel.tsx:266-310` -> `panels/api.rs:472-520,817-823`).
- `[x]` **Send / Cancel button with loading spinner** (`ApiPanel.tsx:295-312` -> `panels/api.rs:522-565`).
- `[x]` **Request editor tabs: `Headers` (with enabled checkboxes, key/value rows, hover remove `X`, `+ Add header`) and `Body` (textarea)** (`ApiRequestEditor.tsx:1-220` -> `panels/api.rs:570-685`).
- `[x]` **Response section tabs: `Response` (pretty-printed JSON/text) and `Headers` (table)** (`ApiResponseView.tsx:1-210` -> `panels/api.rs:690-775`).
- `[x]` **Response status badge (2xx success / 3xx info / 4xx warning / 5xx error), duration (`ms`), and byte size** (`ApiResponseView.tsx:65-115` -> `panels/api.rs:776-799`).
- `[x]` **Local HTTP execution via `conn_desktop::api_request` (no CORS limits)** (`ApiPanel.tsx` -> `panels/api.rs:145-210`).
- `[x]` **Per-project persisted request collection** (`apiStore.ts` -> `panels/api.rs:95-142`).
- `[x]` **No-project empty state copy (`"API requests are only available from a project thread."`)** (`ApiPanel.tsx:110-118` -> `panels/api.rs:804-810`).

### Drift (`[~]`)
- `[~]` **New request default `baseUrl` seeding** (`ApiPanel.tsx:155-168` -> `panels/api.rs:137`): Conn seeds new requests with the project's active dev server / `.env` `APP_URL` base URL; `panels/api.rs:137` passes `None`.

### Missing (`[ ]`)
- `[ ]` **`BrowserLaravelToolbar` docked below API response** (`ApiPanel.tsx:314-319`, `docs/scope.md` #19: *"Local HTTP runner + Laravel Toolbar header inspection"*): Parse `X-Laravel-Toolbar-*` / debug headers from API responses (`receiveToolbarData` + `fetchDetails`) and mount the full Laravel Toolbar below the response view.
- `[ ]` **Response syntax highlighting & Copy response / Raw-vs-Formatted toggle** (`ApiResponseView.tsx:118-175`): JSON syntax highlighting (`HighlightedTokens`) and floating Copy button on the response body.

---

## 7. Database Panel

**TS Sources:** `database/DatabasePanel.tsx`, `database/SqlEditor.tsx`, `database/databaseStore.ts`
**Rust Sources:** `crates/conn-app/src/panels/database/{mod.rs,views.rs,form.rs,store.rs}`

### Exact Parity (`[x]`)
- `[x]` **Connection selector dropdown (`dropdown-glass`) with `.env` auto-discovery, manual connections, and Vault databases + `Unlock Vault…` / `Retry Vault`** (`DatabasePanel.tsx:240-390` -> `panels/database/views.rs:29-212`).
- `[x]` **Connection actions (`Add connection…`, `Copy to a new connection…` for `.env`, `Edit connection…`, `Delete connection`)** (`DatabasePanel.tsx:340-395` -> `panels/database/views.rs:136-201`).
- `[x]` **Add/Edit connection form supporting Postgres / MySQL / SQLite driver segmented pill, Host/Port/Database/Username/Password (masked) or SQLite File path** (`DatabasePanel.tsx:410-595` -> `panels/database/form.rs:50-294`).
- `[x]` **Toolbar `"Read-only"` indicator + Refresh button (`Reload .env and tables`)** (`DatabasePanel.tsx:660-710` -> `panels/database/mod.rs:880-909`).
- `[x]` **Left `208px` (`w-52`) table list with soft pill filter input, loading spinner, and 28px selectable rows** (`DatabasePanel.tsx:730-780` -> `panels/database/mod.rs:987-1070`).
- `[x]` **SQL query editor with `⌘↵` / `Ctrl+Enter` capture-phase execution & Run button** (`DatabasePanel.tsx:781-817` -> `panels/database/mod.rs:1072-1140,1274-1290`).
- `[x]` **Result tabs (`Rows (N)` and `Structure (N)`) with `"First 500 rows · X ms"` summary** (`DatabasePanel.tsx:787-817` -> `panels/database/mod.rs:1128-1166`).
- `[x]` **`RowsGrid` scrollable mono table (`h-8` header, `max-w-72` cells, hover highlight, italic `NULL`)** (`DatabasePanel.tsx:120-190` -> `panels/database/views.rs:246-351`).
- `[x]` **`StructureList` column list with amber primary-key icon (`key.svg`) and type/nullable/default metadata** (`DatabasePanel.tsx:192-238` -> `panels/database/views.rs:354-404`).
- `[x]` **Top connection error alert (`warning_notice`) & no-connection empty state with `+ Add connection` CTA** (`DatabasePanel.tsx:715-728` -> `panels/database/mod.rs:911-940`, `views.rs:215-242`).
- `[x]` **Agent `database_query` tool integration (`panel_open` + populate SQL + execute + display rows)** (`DatabasePanel.tsx:615-650` -> `panels/database/mod.rs:420-490`, `app.rs`).

### Drift (`[~]`)
- `[~]` **SQL editor syntax highlighting** (`database/SqlEditor.tsx` -> `panels/database/mod.rs:1072-1093`): Conn renders SQL syntax highlighting inside `SqlEditor`; `conn-gpui` uses a plain monochrome `Textarea`.
- `[~]` **Connection menu source grouping labels** (`DatabasePanel.tsx:285-338` -> `panels/database/views.rs:68-108`): Conn groups connections under section headers (`From .env`, `Saved`, `Vault`) and marks SSH-tunneled targets; `conn-gpui` renders a single flat list of all connections above one divider.

### Missing (`[ ]`)
- `[ ]` **Pending query handoff from Laravel Toolbar (`openDatabaseQuery`)** (`BrowserLaravelToolbar.tsx:92`, `DatabasePanel.tsx:620-645`): Clicking a SQL query inside the Browser/API Laravel Toolbar switches to the Database panel, pre-fills the SQL editor, and runs the query.
- `[ ]` **Cell click/copy & full value popover for truncated cells** (`DatabasePanel.tsx:165-185`): Double-click or click-to-copy cell values (especially long JSON/text columns truncated at `max-w-72`).

---

## 8. MCP Inspector Panel

**TS Sources:** `mcp/McpPanel.tsx`, `mcp/McpCatalogViews.tsx`, `mcp/mcpServers.ts`, `mcp/mcpStore.ts`
**Rust Sources:** `crates/conn-app/src/panels/mcp/{mod.rs,catalog.rs,log.rs,server.rs,helpers.rs,widgets.rs}`

### Exact Parity (`[x]`)
- `[x]` **Server selector dropdown with `.mcp.json` discovery + manual servers + `New server`, `Duplicate`, `Delete`** (`McpPanel.tsx:210-335` -> `panels/mcp/mod.rs:420-585`).
- `[x]` **Transport selector (`stdio`, `HTTP`, `SSE`), command/URL input, Connect/Disconnect button + `⌘↵` shortcut, and Reload lists button** (`McpPanel.tsx:338-460` -> `panels/mcp/mod.rs:588-740`).
- `[x]` **5 top-level tabs (`Tools (N)`, `Resources (N)`, `Prompts (N)`, `Log (N)`, `Server`)** (`McpPanel.tsx:465-520` -> `panels/mcp/mod.rs:742-810`).
- `[x]` **208px (`w-52`) filterable item list for Tools, Resources (+ `Templates` section header), and Prompts** (`McpCatalogViews.tsx:109-179` -> `panels/mcp/catalog.rs:538-657`).
- `[x]` **Item detail `Overview` / `Playground` sub-tabs** (`McpCatalogViews.tsx:336-425` -> `panels/mcp/catalog.rs:659-763`).
- `[x]` **Tool annotation badges (`read-only`, `destructive`, `idempotent`, `open world`) and schema `FieldsList` docs** (`McpCatalogViews.tsx:303-330,711-722` -> `panels/mcp/catalog.rs:269-278,890-975`).
- `[x]` **JSON-Schema driven Playground forms (string, number/integer, boolean checkbox, enum dropdown, JSON textarea, URI template variables)** (`McpCatalogViews.tsx:183-300` -> `panels/mcp/catalog.rs:978-1190`).
- `[x]` **Playground `Call` / `Read` / `Get` button + `⌘↵` execution** (`McpCatalogViews.tsx:399-420` -> `panels/mcp/catalog.rs:85-219,774-840`).
- `[x]` **`Result` / `JSON` response tabs with error badge, duration (`ms`), Markdown/JSON rendering, image/binary blocks, Raw Markdown toggle (`Eye`/`Code2`), and Copy button** (`McpCatalogViews.tsx:442-689` -> `panels/mcp/catalog.rs:1200-1750`).
- `[x]` **`Log` tab with directional icons (`send`/`receive`/`stderr`/status), error badge, RPC id, timestamp, and click-to-expand pretty JSON** (`McpPanel.tsx:530-625` -> `panels/mcp/log.rs:17-165`).
- `[x]` **`Server` tab with connected server info, version, protocol badge, capability pills, instructions, Name, stdio folder, and Env/Headers key-value editor with checkboxes & hover remove** (`McpPanel.tsx:628-765` -> `panels/mcp/server.rs:79-344`).
- `[x]` **Agent `mcp_connect` and `mcp_call` tool integration** (`McpPanel.tsx` -> `panels/mcp/mod.rs:180-310`, `app.rs`).
- `[x]` **Empty states for disconnected / empty lists / no-project** (`McpCatalogViews.tsx:59-65` -> `panels/mcp/mod.rs`, `catalog.rs`).

### Drift (`[~]`)
- `[~]` **Audio content block in MCP tool results** (`McpCatalogViews.tsx:455-457` -> `panels/mcp/catalog.rs`): Conn renders an inline `<audio controls>` player for `type === "audio"` base64 blocks; `conn-gpui` renders metadata/JSON fallback because GPUI has no native `<audio>` element.

---

## 9. Tasks Panel (Orbit Board)

**TS Sources:** `orbit/tasks/{TasksPanel.tsx,TasksBoard.tsx,TasksInsights.tsx,TaskDetailView.tsx}`
**Rust Sources:** `crates/conn-app/src/panels/tasks/{mod.rs,board.rs,insights.rs,charts.rs,detail.rs,format.rs}`

### Exact Parity (`[x]`)
- `[x]` **Live Orbit Gateway client (`OrbitTasksClient`) + Reverb WebSocket follower (`private-orbit`) + 5-min insights poll + 1-min clock tick** (`TasksPanel.tsx` -> `panels/tasks/mod.rs:217-410`).
- `[x]` **Search tasks input with clear button** (`TasksBoard.tsx` -> `panels/tasks/mod.rs:218-227`, `board.rs`).
- `[x]` **Board settings popover (toggle visible lanes, toggle visible insight metrics, period selector) persisted to `tasks-board-settings.json`** (`TasksBoard.tsx` -> `panels/tasks/mod.rs:58-158,606-635`, `board.rs`).
- `[x]` **2-row insight metric tiles with GPUI sparklines and expandable interactive hover trend charts** (`TasksInsights.tsx` -> `panels/tasks/insights.rs`, `charts.rs`).
- `[x]` **Status lanes (`Queued`, `Working`, `Review`, `Done`, etc.) with task cards & live durations** (`TasksBoard.tsx` -> `panels/tasks/board.rs`).
- `[x]` **Full Task & Subtask detail navigation with Back-to-board breadcrumb & detail tabs** (`TaskDetailView.tsx` -> `panels/tasks/mod.rs:540-582`, `detail.rs`).
- `[x]` **Unavailable / Access required / Extension disabled / Empty / Error notice states with Retry** (`TasksPanel.tsx` -> `panels/tasks/mod.rs:652-747`).
- `[x]` **Fixture transport (`CONN_GPUI_TASKS_FIXTURE`) for deterministic screenshot verification** (`panels/tasks/mod.rs:162-171`).

### Drift (`[~]`)
- `[~]` **Opening a task's Pull Request opens external macOS browser instead of inline Pull Request panel** (`TasksPanel.tsx` -> `panels/tasks/mod.rs:584-592`): Comment in `tasks/mod.rs:585` says `"until the native PR panel is wired into RightPanel, open the task and open the PR URL externally on macOS"` — `PullRequestPanel` is now wired in `RightPanel`, so `TasksPanel` should emit an event to open the PR in `RightPanelTab::PullRequest`!
- `[~]` **Opening a task's Agent conversation is stubbed** (`TaskDetailView.tsx` -> `panels/tasks/mod.rs:594-604`): Shows a notice `"Agent conversation (...) requires cross-environment thread navigation, not yet wired in RightPanel."` instead of emitting a thread navigation event to `ConnApp`.

---

## 10. Pull Request & Linked Items Panels

**TS Sources:** `components/pullRequest/{PullRequestDetailPanel.tsx,PullRequestDetailLayout.tsx,PullRequestDetailActions.tsx,PullRequestActionsMenu.tsx,PullRequestSummaryTab.tsx,PullRequestTimelineTab.tsx,PullRequestCodeTab.tsx,PullRequestChecksPopover.tsx,PullRequestComposer.tsx,PullRequestReviewForm.tsx,PullRequestCommentForm.tsx,PullRequestReviewerPicker.tsx,PullRequestLabelPicker.tsx,PullRequestBaseBranch.tsx,PullRequestReactions.tsx,ThreadPullRequestsPanel.tsx,PullRequestListRow.tsx,PullRequestSpeedActions.tsx,PullRequestStackMenu.tsx,LinkPullRequestDialog.tsx}`
**Rust Sources:** `crates/conn-app/src/panels/pull_request/{mod.rs,header.rs,pickers.rs,tabs.rs,logic.rs}`, `crates/conn-app/src/panels/linked_items/{mod.rs,render.rs,logic.rs}`

### Exact Parity (`[x]`)
- `[x]` **PR Detail fixed title header with inline title editor (`Enter` save / `Cancel`) and hover pencil trigger** (`PullRequestTitleEditor.tsx` -> `panels/pull_request/header.rs:136-231`).
- `[x]` **Collapsible metadata header (`Show details` / `Hide details` + condensed single-line scroll bar)** (`PullRequestDetailPanel.tsx` -> `panels/pull_request/header.rs:298-326,1037-1102`).
- `[x]` **Primary header control state machine (`Ready for review`, `Merge` / `Squash` / `Rebase` with 2-click inline confirm, `Auto-merge` / armed badge, `Resolve conflicts` -> agent prompt, `Merged` / `Closed` badge)** (`PullRequestDetailActions.tsx:191-395` -> `panels/pull_request/header.rs:356-548`).
- `[x]` **PR overflow actions menu (`…`): Refresh, Explain this PR, Fix findings in this thread, Ready/Draft toggle, Merge now, Enable/Disable auto-merge, Merge method radio, Open on GitHub, Copy link, Copy PR number, Copy checkout command, Close/Reopen/Revert/Delete branch (with 2-click confirm)** (`PullRequestActionsMenu.tsx` -> `panels/pull_request/header.rs:554-1033`).
- `[x]` **Metadata rows: Repository link, `#number` link + state pill, Author avatar, Updated relative time, Head -> Base branch with copy + Base-branch freshness popover (`Update branch`)** (`PullRequestDetailPanel.tsx`, `PullRequestBaseBranch.tsx` -> `panels/pull_request/header.rs:1109-1500`, `pickers.rs`).
- `[x]` **Searchable Reviewer picker (`pullRequests.reviewerCandidates` / `requestReviewers`) & Label picker (`pullRequests.labelCandidates` / `setLabels`)** (`PullRequestReviewerPicker.tsx`, `PullRequestLabelPicker.tsx` -> `panels/pull_request/pickers.rs`).
- `[x]` **Tab bar (`Summary` / `Checks` / `Timeline` / `Code`, `h-12.25` = 49px, active bottom bar) with per-tab trailing controls** (`PullRequestDetailLayout.tsx` -> `panels/pull_request/tabs.rs:123-196`).
- `[x]` **Description (`Summary`) tab with Markdown rendering, hover Edit description textarea, and interactive emoji reactions (`pullRequests.setReaction`)** (`PullRequestSummaryTab.tsx`, `PullRequestReactions.tsx` -> `panels/pull_request/tabs.rs:602-727`).
- `[x]` **Checks tab with `Approve workflows to run` (2-click confirm), status summary, `Fix failing checks` prompt CTA, and per-check `Fix` button** (`PullRequestDetailActions.tsx:397-455` -> `panels/pull_request/tabs.rs:199-291,730-820`).
- `[x]` **Timeline tab with comments/commits/approvals counts, Filter menu (`Bot comments`, `Resolved or dismissed`), `Newest`/`Oldest` order pill, collapsible review threads, inline Reply form, Resolve/Unresolve toggle, and reactions** (`PullRequestTimelineTab.tsx` -> `panels/pull_request/tabs.rs:299-503,825-1900`).
- `[x]` **Floating bottom-right Comment / Review composer (`Comment` with `Close/Reopen with comment` + `Review` with `Comment` / `Approve` / `Request changes` verdicts)** (`PullRequestComposer.tsx`, `PullRequestCommentForm.tsx`, `PullRequestReviewForm.tsx` -> `panels/pull_request/tabs.rs:2378-2749`).
- `[x]` **Code tab `Files viewed` checkbox (`pullRequests.setFilesViewed`, including `Changed`/dismissed warning tooltip) + `X/Y viewed` counter** (`PullRequestCodeTab.tsx:259-306` -> `panels/pull_request/tabs.rs:546-561,2151-2188`).
- `[x]` **Linked Items panel: Issues section + Pull requests list with stack depth indentation (`20px`/level, vertical connector line), conflict overlay badge, Watch/Checks/Review glyphs** (`ThreadPullRequestsPanel.tsx`, `PullRequestListRow.tsx` -> `panels/linked_items/render.rs:209-901`).
- `[x]` **Linked Items clickable `+A -D` Change Breakdown popover (`Code`/`Tests`/`Mocks`/`Generated`/`Docs`)** (`PullRequestChangeBreakdownStat.tsx` -> `panels/linked_items/render.rs:650-688,1289-1412`).
- `[x]` **Linked Items row hover `…` & right-click menu (`Copy link`, `Open`, `Watch for changes`/`Stop watching`, `Unlink`/`Dismiss from thread`)** (`ThreadPullRequestsPanel.tsx:353-385` -> `panels/linked_items/render.rs:904-1031`).
- `[x]` **Linked Items modal `LinkPullRequestDialog` (URL or `#number` parsing + live preview + error + `Link` submit)** (`LinkPullRequestDialog.tsx` -> `panels/linked_items/render.rs:1038-1223`).
- `[x]` **Linked Items empty state, unavailable state with Retry, and bottom summary footer (`N open · synced Xm ago` + `+ Link pull request`)** (`ThreadPullRequestsPanel.tsx:513-570` -> `panels/linked_items/render.rs:69-201,299-328`).

### Drift (`[~]`)
- `[~]` **PR Code tab architecture (single file vs continuous multi-file + options)** (`PullRequestCodeTab.tsx:330-420` -> `panels/pull_request/tabs.rs:1985-2370`): Conn renders all PR files continuously (with commit filter selector, Stacked/Split toggle, Ignore whitespace toggle, Hide test files toggle, Expand/Collapse all, Shift-click range `Viewed`, and right-side `DiffFileTree`); `conn-gpui` shows a left flat file list rendering one file at a time in Unified mode only, and clips unwrapped lines via `.overflow_hidden().whitespace_nowrap()` (`tabs.rs:2318-2319`).
- `[~]` **PR Live refresh & editing comments** (`PullRequestTimelineTab.tsx` -> `panels/pull_request/tabs.rs`): Conn supports editing/deleting existing PR comments and editing pending review comments; `conn-gpui` supports editing PR title/body and replying, but not editing/deleting existing comments.
- `[~]` **PR Detail Checks popover in header/summary vs dedicated Checks tab** (`PullRequestChecksPopover.tsx` -> `panels/pull_request/tabs.rs:730`): `conn-gpui` puts Checks in a dedicated tab (very usable), whereas Conn also exposes a quick checks summary popover from the metadata header.
- `[~]` **Linked Items footer & empty state vs `ThreadPullRequestsPanel` Shift speed-actions** (`PullRequestSpeedActions.tsx` -> `panels/linked_items/render.rs`): Conn reveals quick `Shift`-held speed action buttons on PR rows (e.g., quick watch/open/copy); `conn-gpui` only has the `…` hover/right-click menu.

### Missing (`[ ]`)
- `[ ]` **`PullRequestCheckoutMenu` in PR header** (`PullRequestDetailActions.tsx:75-152`): `Check out ▾` button in PR header with `"In a separate worktree"` (new folder + thread) and `"In this repository"` (switches local branch) + checkout toast feedback.
- `[ ]` **Inline PR Code Review comments & pending review queue** (`PullRequestCodeTab.tsx:385-415`, `PullRequestReviewAnnotation.tsx`, `pullRequestReviewStore.ts`): Clicking line numbers in the PR Code tab to start a review thread, add pending review comments, show existing `ReviewThreadCard`s inline under diff lines, and submit all pending comments with the Review composer.
- `[ ]` **PR Stack header & stack operations menu (`PullRequestStackHeader`, `PullRequestStackMenu`, `PullRequestStackPopover`)** (`PullRequestStackHeader.tsx`, `PullRequestStackMenu.tsx`): Visual stack layer switcher and stack-wide actions (restack, merge stack) on stacked PRs.
- `[ ]` **PR Code tab commit filter (`All changes` vs individual commit)** (`PullRequestCodeTab.tsx:335-336`): Filter PR diff to a single commit from the timeline or dropdown.
- `[ ]` **Drag PR row from Linked Items into composer** (`ThreadPullRequestsPanel.tsx`): Dragging a linked PR inserts its URL/reference into the active composer.
- `[ ]` **Global Pull Requests overview page (`/_chat.pull-requests`, `PullRequestsPage.tsx`)** (`routes/_chat.pull-requests.tsx`, `CommandPalette.tsx:1551-1577`): Cross-repo PR inbox with filters, groups, and split detail view (`Open pull requests` command).

### Out of Scope (`[-]`)
- `[-]` **AI PR Review Guides tab (`PullRequestGuideTab.tsx`, `read_pull_request_guide`, `write_pull_request_guides`)** (`PullRequestDetailPanel.tsx`, `PullRequestGuideTab.tsx`) — `docs/scope.md` #23 (`Subset`: "Drop GitLab & AI PR Review Guides").
- `[-]` **GitLab host / MR terminology & multi-host routing (`gitlab` provider support)** (`PullRequestDetailPanel.tsx`, `sourceControlClients`) — `docs/scope.md` #23 (`Subset`: "GitHub only; drop GitLab").

---

## 11. Device Panel

**TS Sources:** `components/device/{DevicePanel.tsx,DeviceWorkspace.tsx,DeviceControlsRail.tsx,DeviceToolsPanel.tsx,DeviceSetup.tsx,DeviceStreamView.tsx,DeviceAnnotationOverlay.tsx,DeviceAndroidFoldControls.tsx,DeviceDuoControls.tsx,DeviceHostUpdates.tsx,DeviceLoadingView.tsx}`
**Rust Sources:** `crates/conn-app/src/panels/device/{mod.rs,ui.rs,workspace.rs,setup.rs,hosts.rs,stream.rs,h264.rs,logic.rs}`

### Exact Parity (`[x]`)
- `[x]` **Live `subscribeDeviceState` / `device.list` subscription + device picker grouped by host & platform (iOS / Android)** (`DevicePanel.tsx` -> `panels/device/mod.rs`).
- `[x]` **3-step `DeviceSetup` onboarding wizard (`1. Device hub`, `2. Simulators` check, `3. Agent access`)** (`DeviceSetup.tsx` -> `panels/device/setup.rs:73-662`).
- `[x]` **Live H.264 device screen video stream (`DeviceStreamView`) + touch/drag/keyboard input socket + `Input disconnected, reconnecting…` pill** (`DeviceStreamView.tsx` -> `panels/device/workspace.rs:227-415`, `stream.rs`, `h264.rs`).
- `[x]` **`DeviceLoadingView` connecting/error overlay with `Reconnect` CTA** (`DeviceLoadingView.tsx` -> `panels/device/workspace.rs:378-412`, `ui.rs`).
- `[x]` **Discovery warnings bar (`Retry`, `Details` monospace popover, `Dismiss`) & `DeviceHostUpdates` installing/starting/failed cards** (`DevicePanel.tsx`, `DeviceHostUpdates.tsx` -> `panels/device/ui.rs:679-850`).
- `[x]` **Floating right `DeviceControlsRail` pill: Home, Android Back/Recents, Rotate (iOS step / Android Portrait+Landscape menu), Appearance Light/Dark toggle, Text size menu, Device tools drawer toggle, Save screenshot, More (`Switch device`, `Close device panel`, `Power off device`)** (`DeviceControlsRail.tsx` -> `panels/device/workspace.rs:418-859`).
- `[x]` **Device Annotations controls in rail (`Annotate screen`, `Annotations queue` popover with waiting badge) + pin overlay & pin composer with Operator dictation** (`DeviceAnnotationOverlay.tsx` -> `panels/device/workspace.rs:302-343,860-1005`).
- `[x]` **Collapsible `288px` (`w-72`) `DeviceToolsPanel` drawer: Host diagnostics, Foreground app + Terminate/Relaunch, Open URL, Launch app** (`DeviceToolsPanel.tsx:95-166` -> `panels/device/workspace.rs:1048-1270`).
- `[x]` **`DeviceToolsPanel` Simulator/Emulator section: Appearance, Text size, iOS Liquid Glass (`Clear`/`Tinted`), iOS Color filter, Android Orientation, Reduce Motion, iOS Contrast/Transparency/Borders/VoiceOver, Android Network** (`DeviceToolsPanel.tsx:167-275` -> `panels/device/workspace.rs:1271-1650`).
- `[x]` **`DeviceToolsPanel` Location section (presets + lat/lon + iOS Clear)** (`DeviceToolsPanel.tsx:289-294` -> `panels/device/workspace.rs:1655-1820`).
- `[x]` **`DeviceToolsPanel` Permissions section (iOS/Android permission lists + Grant/Revoke/Reset)** (`DeviceToolsPanel.tsx:296-304` -> `panels/device/workspace.rs:1825-1990`).
- `[x]` **`DeviceToolsPanel` iOS Push notification sender & live Event Log viewer** (`DeviceToolsPanel.tsx:306-324` -> `panels/device/workspace.rs:1995-2235`).
- `[x]` **Local & SSH remote device host configuration (`SshHostForm` + `device.testHost` connectivity check)** (`DeviceSourcesSettings.tsx`, `DeviceHostEditor.tsx` -> `panels/device/hosts.rs:133-218`).

### Drift (`[~]`)
- `[~]` **Scope violation in `panels/device/hosts.rs` (EAS Cloud & Simlock forms present)** (`docs/scope.md` #24 -> `panels/device/hosts.rs:41-46,80-105,220-260`, `workspace.rs:430,804-808`): `docs/scope.md` #24 explicitly specifies `"Local + SSH only; drop EAS Cloud & Simlock"`, yet `conn-gpui` ported `EasHostForm`, `SimlockHostForm`, and `is_simlock` branches. Should be stripped/hidden to match locked scope.
- `[~]` **Disabled 3D view icon button permanently shown in rail** (`DeviceControlsRail.tsx` -> `panels/device/workspace.rs:1006-1030`): `conn-gpui` renders a permanently disabled `3D view` button alongside an always-pressed `Flat view` button because Three.js WebGL is browser-only; should hide the 3D/Flat toggle section cleanly instead of showing a dead button.
- `[~]` **Screenshot feedback banner vs Toast with actions** (`DeviceWorkspace.tsx` -> `panels/device/workspace.rs:176-187`): Conn shows a rich toast with `Copy image` / `Reveal in Finder`; `conn-gpui` shows a plain top text notice line.

### Missing (`[ ]`)
- `[ ]` **Accessibility element frames overlay (`axOverlay` toggle in `DeviceToolsPanel`)** (`DeviceToolsPanel.tsx:277-287`, `DeviceStreamView.tsx`): `panels/device/workspace.rs:76` stores `ax_overlay: bool` in `ToolsInputs`, but verify/implement actual bounding-box frame rendering over the live device stream when toggled on.
- `[ ]` **Float device preview over chat (PiP)** (`DeviceControlsRail.tsx`, `ThreadPreviewMiniPlayer.tsx:201-207`): Rail/More action to float the live device screen over chat.
- `[ ]` **Android Foldable / Hinge controls (`DeviceAndroidFoldControls.tsx`) & Duo Viewport (`DeviceDuoViewport.tsx`)** (`DeviceAndroidFoldControls.tsx`, `DeviceDuoControls.tsx`): Fold posture controls when running foldable Android AVDs and side-by-side two-device Duo view.

### Out of Scope (`[-]`)
- `[-]` **Expo / EAS Cloud device host configuration & sessions** (`EasDeviceHostEditor.tsx`) — `docs/scope.md` #24 (`Subset`: "Local + SSH only; drop EAS Cloud & Simlock").
- `[-]` **Simlock device host pool / lease UI** (`SimlockDeviceHostEditor.tsx`) — `docs/scope.md` #24 (`Subset`: "drop EAS Cloud & Simlock").
- `[-]` **Three.js 3D phone chassis viewport** (`DevicePhoneViewport.tsx`, `mountDeviceViewer.ts`) — WebGL Three.js browser-only effect; flat live stream is the native GPUI equivalent.

---

## 12. Settings Modal

**TS Sources:** `routes/_chat.settings.tsx`, `components/settings/{SettingsSidebarNav.tsx,SettingsPanels.tsx,AppearanceSettingsPanel.tsx,TypographySettings.tsx,ThemeSettings.tsx,OrbitSettings.tsx,ScheduledTasksSettings.tsx,BrowserSettings.tsx,PasswordsSettings.tsx,DeviceSourcesSettings.tsx,ProjectsSettings.tsx,ProviderSettingsPanel.tsx,SourceControlSettings.tsx,WorktreesSettings.tsx,StorageSettings.tsx,BackgroundActivitySettings.tsx,NotificationSettings.tsx,settingsSearch.ts}`
**Rust Sources:** `crates/conn-app/src/settings/{mod.rs,controls.rs,scheduled_tasks.rs}`

> **Scope Rule (`docs/scope.md` #13):** *"Flat Orbit-synced profile + minimal per-project overrides; drop Labs, Global/Env/Project `SettingsScopeContext`, custom keybindings editor, visual Theme Editor & Inspector spotlight."* Every item below is classified strictly against this rule.

### Modal Shell & Navigation
- `[x]` **Centered `AppRouteModal` shell (`1040×720` max, `18px` radius, `44px` transparent header, `Settings / <Page>` breadcrumb, circular close button, `Escape` & scrim click dismiss, `⌘,` shortcut)** (`_chat.settings.tsx:124-149`, `AppRouteModal.tsx` -> `settings/mod.rs:40-49,402-449,1822-1910`).
- `[x]` **Inset left nav rail (`shell_inner_fill`, `14px` corners, `1px` `shell_divider`) + raised `SettingsGroup` cards (`shell_settings_card`, `shell_divider_raised`)** (`SettingsSidebarNav.tsx:257-267`, `settingsLayout.tsx` -> `settings/mod.rs:451-627`, `settings/controls.rs`).
- `[x]` **Settings search input in nav rail with clear button** (`SettingsSidebarNav.tsx:271-323` -> `settings/mod.rs:503-548`).
- `[~]` **Settings search UX & shortcuts** (`SettingsSidebarNav.tsx:160-255,324-368` -> `settings/mod.rs:503-548,719-828`): Conn focuses search on `⌘F` or `/`, displays `<Kbd>/</Kbd>` hint, shows ranked clickable result rows inside the sidebar with arrow-key + Enter jump-and-highlight to the exact setting row; `conn-gpui` replaces the content pane with crude substring `.contains(needle)` blocks across only 4 categories and has no `/` or `⌘F` focus shortcut.
- `[~]` **Initial landing page & nav grouping** (`_chat.settings.tsx:182-184`, `settingsSearch.ts:139-182` -> `settings/mod.rs:54-68,286`): Conn redirects `/settings` -> `General` and groups nav sections (`Core`, `Agents`, `Code`, `Connections`, `Maintenance/About`); `conn-gpui` defaults to `Appearance` and lists only 5 flat pages (`General`, `Appearance`, `Connections`, `Scheduled tasks`, `Keyboard`).
- `[ ]` **Header `"Restore device defaults"` button + per-row `SettingResetButton` (`RotateCcw`)** (`_chat.settings.tsx:35-48,129-133`, `SettingsPanels.tsx:425-707`): Resets dirty device settings with confirmation listing changed labels; per-row reset arrow on modified settings.

### Page-by-Page Audit (In-Scope Pages & Controls)

#### General (`/settings/general`)
- `[~]` **General page content** (`SettingsPanels.tsx:786-1078` -> `settings/mod.rs:629-659`): Currently `conn-gpui`'s General page is two read-only informational rows (`Application: conn-gpui`, `Interface typography: 13px / 20px`) with **zero interactive settings**.
- `[ ]` **In-app notifications toggle (`inAppNotificationsEnabled`)** (`SettingsPanels.tsx:797-807`, `docs/scope.md` #33 `Subset`: simple on/off — note `docs/status.md:46` notes native macOS OS notifications are omitted per user preference, so keep simple in-app toast toggle).
- `[ ]` **Project order (`Last user message` / `Created at` / `Manual`)** (`SettingsPanels.tsx:846-885`).
- `[ ]` **Confirmations section: `Unpin confirmation`, `Archive confirmation`, `Delete confirmation`, `Quit shortcut` (`Direct` / `Hold` / `Double press`)** (`SettingsPanels.tsx:914-1031`).
- `[ ]` **Display -> `Time format` (`System default` / `12-hour` / `24-hour`)** (`SettingsPanels.tsx:1033-1075`).

#### Appearance (`/settings/appearance`)
- `[x]` **Theme list split into `From Orbit profile`, `Dark themes`, `Light themes` with 3-dot color swatch + `Active` checkmark** (`ThemeSettings.tsx` -> `settings/mod.rs:661-717,830-950`).
- `[x]` **Window `Reduce transparency` switch** (`settings/mod.rs:671-688` — native macOS equivalent/complement to glass opacity).
- `[ ]` **Color scheme selector (`System` / `Light` / `Dark`) + paired light/dark theme halves (`setThemeHalf`)** (`AppearanceSettingsPanel.tsx:149-161`, `ThemeSettings.tsx`): Automatic macOS system appearance switching with separate chosen Light and Dark themes.
- `[ ]` **Contrast slider (`appearanceContrast`, 5% steps) & Glass opacity slider (`glassOpacity`, 5% steps)** (`AppearanceSettingsPanel.tsx:166-258`).
- `[ ]` **Chat width (`Comfortable` / `Wide` / `Full`)** (`AppearanceSettingsPanel.tsx:260-291`).
- `[ ]` **Thread details items customization (`ThreadDetailsItemsRow`)** (`AppearanceSettingsPanel.tsx:292`).
- `[ ]` **Effort display (`Word` / `Bars`)** (`AppearanceSettingsPanel.tsx:293-325`).
- `[ ]` **Render math toggle (`mathRenderingEnabled`)** (`AppearanceSettingsPanel.tsx:326-350`).
- `[ ]` **Advanced interface toggles: `Panel animations` duration slider, `Composer context` persist toggle** (`AppearanceSettingsPanel.tsx:351-480`).
- `[ ]` **Typography section (`TypographySettings.tsx`): Interface/Prompt/Code/Terminal font family, size, line height, `Separate fonts`, `Word wrap` default, macOS `Font smoothing`** (`AppearanceSettingsPanel.tsx:483`, `settingsSearch.ts:415-458`).

#### Chat (`/settings/chat`)
- `[ ]` **Entire `Chat` settings page** (`SettingsPanels.tsx:1080-1239`):
  - `Rich text composer` toggle (`composerRichTextEnabled`)
  - `Send shortcut` (`Enter` / `⌘+Enter for multiline prompts` / `⌘+Enter always`)
  - `Show skills in slash menu` toggle (`showSkillsInSlashMenu`)
  - `Follow-up behavior` (`Queue` / `Steer`)

#### Diffs & Pull Requests (`/settings/diffs`)
- `[ ]` **Entire `Diffs & pull requests` settings page** (`SettingsPanels.tsx:1294-1435`):
  - `Diff layout` (`Stacked` / `Split`)
  - `Hide whitespace changes` default toggle (`diffIgnoreWhitespace`)
  - `Default diff file state` (`Expanded` / `Collapsed`)
  - `Diff colors` (`Red & green` / `Blue & orange`)
  - `Open pull requests and changes panels proactively` toggle (`proactivePanelsEnabled`)
  - `Open pull requests in Conn` link handler toggle (`pullRequestLinksOpenInApp`)

#### Threads (`/settings/threads`)
- `[ ]` **In-scope `Threads` settings page** (`SettingsPanels.tsx:1501-1901`, excluding Snooze & Usage-limit auto-resume which are `Drop` #3/#9):
  - `Add project starts in` base directory (`addProjectBaseDirectory`)
  - `Default model` & `Permissions` (`defaultRuntimeMode`) & `New threads` mode (`local` / `worktree`)
  - `Auto-settle merged threads`, `Auto-settle inactive threads` + `Days before auto-settle` + `Keep threads with a PR`
  - `Text generation model` picker + `Response streaming` (`Wait for full response` / `Show finished paragraphs`)

#### Browser (`/settings/browser`)
- `[ ]` **In-scope `Browser` settings page** (`settingsSearch.ts:922-927,998-1069`, excluding Browser Profiles which are `Drop` #31):
  - `Agent browser access` toggle (`enableAgentBrowserAccess`)
  - `Default browser viewport`, `Default browser zoom`, `Default browser appearance`
  - `Browser recording frame rate`, `Show key presses in recordings`, `Show mouse presses in recordings`
  - `Open links in` (`In-app browser` / `Default browser`), `Search engine` (`DuckDuckGo`/`Google`/`Bing`/`Brave`/`Kagi`/`Ecosia`/`Custom URL`)
  - `Auto-show floating preview` toggle
  - `Annotation dictation URL` & `Stop URL` (note Operator URL currently sits on Connections page in `conn-gpui`)

#### Passwords (`/settings/passwords`) — `docs/scope.md` #5 `Keep`
- `[ ]` **Entire `Passwords` settings page** (`PasswordsSettings.tsx`, `VaultwardenSettings.tsx`, `settingsSearch.ts:929-955`):
  - `Password manager` (Vaultwarden / Vault Mac bridge status, configure, lock/unlock)
  - `Test logins` CRUD list (`credentials.*` — add/edit/delete seed accounts with username/password/TOTP for agent browser sign-in)
  - `Block agent scripts after a fill` toggle (`credentialBlockScripts`)
  - `Fill on subdomains of a saved site` toggle (`credentialAllowSubdomains`)

#### Devices (`/settings/devices`) — `docs/scope.md` #24 `Subset`
- `[ ]` **In-scope `Devices` settings page** (`DeviceSourcesSettings.tsx`, `settingsSearch.ts:957-984`):
  - `Use devices` hub toggle + status & tool versions
  - `Agents can use devices` toggle
  - `Local simulators` availability check
  - `SSH remote device hosts` add/edit/test/remove (currently reachable only inside `DevicePanel` via `hosts.rs`, not from Settings!)

#### Scheduled Tasks (`/settings/scheduled-tasks`) — `docs/scope.md` #7 `Keep`
- `[x]` **Live `scheduledTasks.subscribe` list with schedule label, next/last run status, enable switch, Run now, Edit, Delete, and Webhook Copy / Rotate / Deliveries inspector** (`ScheduledTasksSettings.tsx` -> `settings/scheduled_tasks.rs:1-800+`).
- `[x]` **Create/Edit form supporting Fixed time + weekdays, Interval, Once, Webhook (HMAC signature header/prefix/secret, max age, replay/coalesce dedupe), project, workspace strategy, model, and runtime mode** (`ScheduledTasksSettings.tsx` -> `settings/scheduled_tasks.rs:240-443`).
- `[~]` **Webhook payload filters (`WebhookFiltersField`) & delete confirmation** (`ScheduledTasksSettings.tsx:171-262,738-750` -> `settings/scheduled_tasks.rs:530-557`): `ScheduledTasksView` deletes tasks immediately without a confirmation dialog and omits the `WebhookFiltersField` (`path` + `op` + `value` rules) in the webhook editor.

#### Projects (`/settings/projects` & per-project settings) — `docs/scope.md` #13 `Subset`
- `[ ]` **Minimal `Projects` settings page** (`ProjectsSettings.tsx`, `ProjectSettingsPanel.tsx`, `settingsSearch.ts:309-313,1175-1179`): Project name/icon/emoji, checkout path, Project Actions/Scripts (`setup`, `run`, `dev server`, `runOnWorktreeCreate`, `t3.json` import), and minimal per-project overrides (default model, default permissions, auto-pull).

#### Providers (`/settings/providers`) — `docs/scope.md` #4 `Subset`
- `[ ]` **Minimal `Providers` settings page** (`ProviderSettingsPanel.tsx`, `settingsSearch.ts:890-896,544-549`): Read-only CLI status/version check for `claude`, `codex`, `acp` (via `ai-router` / local CLI), custom binary path / env / model list, and `Compact idle threads` mode. *(OAuth sign-in wizards, multi-account load balancing, and usage providers are `Drop` #3.)*

#### Source Control & Worktrees (`/settings/source-control`, `/settings/worktrees`) — `docs/scope.md` #12 & #23 `Subset`
- `[ ]` **In-scope `Source control` settings page** (`SourceControlSettings.tsx`, `settingsSearch.ts:1071-1101`): GitHub account/token status (`gh` CLI / PAT), `Automatically pull`, `Remove agent credits when merging`, `Default merge method` (`Merge`/`Squash`/`Rebase`/`Last selected`). *(GitLab, Review Guides, and Custom Commit Writing Prompt are `Drop` #23/#32.)*
- `[ ]` **In-scope `Worktrees` settings page** (`WorktreesSettings.tsx`, `settingsSearch.ts:259-291,684-696`): `Start from remote` (`newWorktreesStartFromOrigin`), `Submodules` mode, `Worktree location`, and `Worktree cleanup` retention policy. *(Custom branch-naming template UI is `Drop` #12.)*

#### Connections & Orbit (`/settings/connections`) — `docs/scope.md` #1 `Orbit`
- `[x]` **Active server status card + Direct `conn-server` URL / pairing URL + bearer token connect form** (`ConnectionsSettings.tsx` -> `settings/mod.rs:952-1020,1652-1710`).
- `[x]` **Orbit Nodes list (`Connected`/`Connecting…`/`Connect`, `(This Mac)` tag) & Orbit Instances list (`Wake` / `Connect` + `Show/Hide stopped`)** (`OrbitSettings.tsx:394-419` -> `settings/mod.rs:1022-1207`).
- `[x]` **Orbit Gateway profile binding, Create new profile, Sync now, Sync toggles (`Workspaces`, `Appearance & themes`, `Desktop settings`), Resolve differences (`Use this device` / `Use the profile`), and `Restore previous settings` backup** (`OrbitSettings.tsx:124-391` -> `settings/mod.rs:1209-1565`).
- `[x]` **Operator local dictation status & API URL configuration** (`settings/mod.rs:1567-1650`, `docs/scope.md` #6 `Orbit`).

#### Maintenance & About (`/settings/maintenance`, `/settings/about`)
- `[ ]` **In-scope `Maintenance` settings page** (`SettingsPanels.tsx:1903-2011`, `StorageSettings.tsx`): `Provider update checks`, `Continue threads after restarts`, `Background activity` profile (`Balanced`/`Performance`/`Battery saver`), `Artifacts and logs` cleanup + `Delete now`. *(Resource Monitor & OpenTelemetry export are `Drop` #28.)*
- `[ ]` **`About` settings page** (`SettingsPanels.tsx:2013-2086`): App version, `Check for Updates` / release channel, CLI command install, and Open-source licenses.

#### Keyboard (`/settings/keybindings`) — `docs/scope.md` #13 `Subset`
- `[x]` **Read-only Keyboard shortcuts reference page** (`settings/mod.rs:1761-1820` — matches `docs/scope.md` #13 dropping the custom keybindings JSON editor).
- `[~]` **Shortcuts reference list completeness** (`settings/mod.rs:1784-1820`): Currently documents only 7 shortcuts; should reflect all implemented global, panel, browser, diff, and composer shortcuts.

### Out of Scope Settings (`[-]`)
- `[-]` **Global / Environment / Project `SettingsScopeContext` axis bar & `SettingInheritance` badges** (`_chat.settings.tsx:50-175`, `SettingsScopeContext.tsx`) — `docs/scope.md` #13 (`Subset`: flat Orbit-synced profile + minimal per-project overrides).
- `[-]` **Custom Keybindings JSON/capture editor** (`_chat.settings.keybindings.tsx`) — `docs/scope.md` #13 (`Subset`: drop custom keybindings editor).
- `[-]` **Visual Theme Editor, Inspector Spotlight & `conn_theme_set` / Theme Import** (`ThemeEditorPanel.tsx`, `ThemeImportDialog.tsx`) — `docs/scope.md` #2 & #30 (`Drop`).
- `[-]` **Labs / Beta settings page (`Boring sidebar`, `Guest links`, `Linked environments`, `Simlock`, `Legacy plan mode`, `Legacy context meter`)** (`_chat.settings.labs.tsx`, `settingsSearch.ts:503-534,795-805`) — `docs/scope.md` #13 (`Subset`: drop Labs).
- `[-]` **SnapShots settings page & shortcut recorder** (`_chat.settings.snap-shot.tsx`, `SnapShotSettings.tsx`) — `docs/scope.md` #26 (`Drop`).
- `[-]` **Sharing & Access / T3 Connect managed tunnel / Clerk Sign-In / Peer Links / QR Pairing / Load Balancing** (`_chat.settings.access.tsx`, `SettingsSidebarNav.tsx:444-451`, `settingsSearch.ts:1195-1289`) — `docs/scope.md` #1 (`Orbit`), #3 (`Drop`), #27 (`Drop`).
- `[-]` **Provider Accounts, OAuth Sign-In wizards, Usage Providers (`CLIProxyAPI`), Cursor Keychain Usage, Usage-limit auto-resume/snooze** (`UsageProviderSettings.tsx`, `SettingsPanels.tsx:1603-1636`, `settingsSearch.ts:898-913`) — `docs/scope.md` #3 (`Drop`).
- `[-]` **Diagnostics / Resource Monitor / OpenTelemetry Export (`OTLP`)** (`_chat.settings.diagnostics.tsx`, `ResourceTelemetryDiagnostics.tsx`, `TelemetryExportSettings.tsx`) — `docs/scope.md` #28 (`Drop`).
- `[-]` **Archived threads settings page & sidebar Snooze presets / Working shelf / Project grouping across environments** (`_chat.settings.archived.tsx`, `SettingsPanels.tsx:811-845,886-911,1597-1601`) — `docs/scope.md` #9 (`Subset`: drop Snooze, Archived, Working shelf, custom grouping).
- `[-]` **Browser Profiles & Default Browser Profile** (`settingsSearch.ts:986-996`) — `docs/scope.md` #31 (`Drop`).
- `[-]` **Custom Thread Title Instructions & Source Control Writing Style / Commit Prompt / Review Guides** (`ThreadTitleInstructionsSettings.tsx`, `SourceControlWritingSettings.tsx`, `settingsSearch.ts:737-742,1123-1173`) — `docs/scope.md` #23 & #32 (`Drop`).
- `[-]` **Worktree custom branch-naming template UI** (`settingsSearch.ts:1114-1120`) — `docs/scope.md` #12 (`Subset`: drop custom branch-naming template UI).
- `[-]` **1Password secret providers (`/settings/secrets`)** (`SecretsSettings.tsx`, `SecretProviderDialog.tsx`, `SecretSourceInput.tsx`) — Dropped (scope §2 #5): Conn keeps Vaultwarden only, so there is no Secrets page, no `op://` reference picker in the provider editor and no `server.checkSecretSource` `Check`.
- `[-]` **WSL Backend (Windows-only)** (`settingsSearch.ts:1212-1222`) — macOS-native client.
- `[-]` **Privacy policy / T3 anonymous telemetry opt-out** (`SettingsPanels.tsx:2053-2069`) — T3 hosted/upstream telemetry not applicable (`Drop` #28).
- `[-]` **Mobile app QR link (`MobileAppSettingsRow`)** (`SettingsPanels.tsx:2049`) — upstream T3 iOS/Android app promotion.
- `[-]` **Sidebar `Environment identification` Dev/Nightly artwork** (`AppearanceSettingsPanel.tsx:411-452`) — T3 release channel branding.
- `[-]` **Pull Request sharing / cross-environment PR routing** (`settingsSearch.ts:1283-1289`) — `docs/scope.md` #1 (`Orbit` manages nodes).
- `[-]` **Guest share links toggle** (`settingsSearch.ts:515-520`) — `docs/scope.md` #27 (`Drop`).

---

## 13. Command Palette & Search Overlays

**TS Sources:** `components/CommandPalette.tsx`, `CommandPaletteContent.tsx`, `CommandPalette.logic.ts`, `CommandPaletteResults.tsx`, `CommandPaletteAddProject.tsx`, `CommandPaletteProjectItems.tsx`, `CommandPaletteThemeItems.tsx`, `CommandPaletteThreadItems.tsx`, `components/files/ProjectFilePicker.tsx`, `components/search/ProjectContentSearchDialog.tsx`, `components/chat/ThreadFindBar.tsx`
**Rust Sources:** `crates/conn-app/src/palette/{mod.rs,filter.rs}`

### Exact Parity (`[x]`)
- `[x]` **Global `⌘K` toggle + floating glass card (`576px` wide, `12px` radius, `360px` max list height, dimmed scrim, click-outside & `Esc` dismiss)** (`CommandPalette.tsx:305-387` -> `palette/mod.rs:30-41,558-667`).
- `[x]` **Keyboard navigation (`↑` / `↓`, `Enter` confirm, `Esc` dismiss, auto scroll-into-view)** (`CommandPaletteContent.tsx` -> `palette/mod.rs:203-225,591-606`).
- `[x]` **Leading `>` actions-only filter mode + footer keycap hints (`↑↓ Navigate`, `↵ Select`, `Esc Close`, `> Actions`)** (`CommandPalette.logic.ts:571-588`, `CommandPaletteContent.tsx:66-95` -> `palette/mod.rs:494-555`, `palette/filter.rs:152-157`).
- `[x]` **Fuzzy subsequence ranking (Exact > Prefix > Word-boundary > Substring > Subsequence) with unit tests** (`CommandPalette.logic.ts:501-538` -> `palette/filter.rs:260-358`).
- `[x]` **Groups for `Threads`, `Projects`, `Nodes & Instances` (Orbit), `Themes` (with swatches + `Current` badge), and `Actions`** (`CommandPalette.tsx` -> `palette/mod.rs:56-127,340-490`, `palette/filter.rs:159-222`).
- `[x]` **Core built-in actions (`New thread`, `Toggle sidebar`, `Toggle right panel`, `Open Files/Diff/Terminal/Browser`, `Open Settings`)** (`CommandPalette.tsx` -> `palette/filter.rs:79-128`).

### Drift (`[~]`)
- `[~]` **Incomplete built-in `Open <Panel>` actions in `BUILTIN_ACTIONS`** (`palette/filter.rs:79-128`): Lists only `Files`, `Diff`, `Terminal`, `Browser`; omits `API`, `Database`, `MCP`, `Tasks`, `Pull request`, `Linked items`, `Device`!
- `[~]` **Empty-query default order & thread recency cap** (`CommandPalette.logic.ts:37,763-779` -> `palette/filter.rs:159-222`): Conn shows `Actions` first and `Recent Threads` (capped at `RECENT_THREAD_LIMIT = 12` with relative timestamps and `⌘1–⌘9` jump badges) when query is empty; `conn-gpui` dumps all threads, all projects, all nodes, and all themes above `Actions`.
- `[~]` **Wrap-around keyboard selection & hover-to-highlight** (`CommandPalette.tsx` -> `palette/mod.rs:203-219,334-338`): Conn wraps `↓` from last -> first and `↑` from first -> last, and moving the mouse highlights rows; `conn-gpui` clamps at `0..count-1` and keeps hover separate from `selected_index`.
- `[~]` **Match range highlighting & match hints** (`CommandPalette.logic.ts:501-538`, `ProjectFilePicker.tsx:23-44` -> `palette/mod.rs:340-489`): Conn bolds matched characters and shows a `matchHint` when matching on branch/project/body instead of title; `conn-gpui` renders plain unhighlighted text.

### Missing (`[ ]`)
- `[ ]` **`ProjectFilePicker` (`⌘P` — Go to file)** (`ProjectFilePicker.tsx:1-156`, `CommandPalette.tsx:372-373,1460-1471`): Dedicated palette mode searching project files via `projects.searchEntries`, showing `@pierre/trees` icons, highlighted fuzzy basename + path, and opening the chosen file in a `Files` tab. `Esc` returns to main command palette when opened from it.
- `[ ]` **`ProjectContentSearchDialog` (`⌘⇧F` — Search project contents)** (`ProjectContentSearchDialog.tsx:1-329`, `CommandPalette.tsx:374-375,1473-1484`): Dedicated tall palette mode (`h-105`) with `Aa` (Match case), `ab` (Whole word), `.*` (Regex) segmented toggles, match/file count status bar, sticky per-file headers, syntax-highlighted matching lines with line numbers, infinite load-more windowing, and `Enter`/click opening the file at `lineNumber`.
- `[ ]` **`ThreadFindBar` (`⌘F` — Find in current thread)** (`ThreadFindBar.tsx:1-129`, `CommandPalette.tsx:1301-1313`): Floating top-right glass pill bar over chat (`Find in thread`, `N/M` match counter, `Searching…` / `Search failed` + Retry, `ChevronUp` / `ChevronDown` prev/next, `Enter`/`Shift+Enter`, `Esc` close, highlighting matches in timeline).
- `[ ]` **Submenu stack (`Backspace` back, `viewStack`)** (`CommandPalette.logic.ts:246-281`, `CommandPaletteContent.tsx:83-88`): Navigating into nested palette views (`New thread in…`, `Add project`, `New project`, `Change theme`, `Change appearance`) with parent-query restoration on Back.
- `[ ]` **`Add project` interactive flow (filesystem path browser + Tab completion + GitHub clone)** (`CommandPalette.tsx:1180-1228,1500-1529,1763-2199`, `CommandPaletteAddProject.tsx`): Browse folders (`~/...`, `..`, Tab autocomplete, native folder picker) or clone a GitHub repo directly from `⌘K`.
- `[ ]` **`New project` creation flow (empty git repo + optional GitHub publish)** (`CommandPalette.tsx:1486-1498,1918-1948`).
- `[ ]` **Settings search directly inside `⌘K`** (`CommandPalette.tsx:1676-1694`): Typing any setting name/keyword (`"word wrap"`, `"glass"`, `"scheduled"`) shows `Settings · <Section>` rows that open Settings directly to that section.
- `[ ]` **Server thread-message content search (`In messages` group)** (`CommandPalette.logic.ts:557,657-660`): Async search matching inside past user/assistant messages with snippet preview.
- `[ ]` **Missing in-scope Command Palette actions** (`CommandPalette.tsx:1234-1671`):
  - `New thread in <active project>` (`⌘⇧N`) & `New thread in…` submenu & `New thread without a project` (`⌘⌥N`)
  - `Restart agent session` (stops active runtime + refreshes providers + toast)
  - `Copy thread` / `Copy PR link` (`⌘⇧C`)
  - `Link pull request to thread` & `Show linked pull requests`
  - `Open pull requests` (PR inbox)
  - `Pin / Unpin project` & `Project settings`
  - `Change appearance` (`System`/`Light`/`Dark`, `⌘⌥⇧A`) & `Change theme` submenu (`⌘⌥A`)
  - `Focus Next / Previous Workspace Area` (`F6` / `Shift+F6`)
  - `Copy prompt link` / `Copy prompt link with repo and model`
- `[ ]` **Inline Pin toggle button on Project rows in palette** (`CommandPalette.logic.ts:211-219`).
- `[ ]` **Restore composer focus on palette dismiss (`finalFocus`)** (`CommandPalette.tsx:358-367`).

### Out of Scope (`[-]`)
- `[-]` **`Share with guest` command** (`CommandPalette.tsx:1409-1421`) — `docs/scope.md` #27 (`Drop`).
- `[-]` **`Theme editor` command (`⌘⌥⇧T`)** (`CommandPalette.tsx:1549`) — `docs/scope.md` #30 (`Drop`).
- `[-]` **`Open usage` command (`⌘U`)** (`CommandPalette.tsx:1579-1589`) — `docs/scope.md` #3 (`Drop`: usage/billing pages dropped).
- `[-]` **`Open WSL folder` command & `Triage an issue` (upstream T3 Code bug reporter)** (`CommandPalette.tsx:1289-1299,1531-1544`) — Windows-only / upstream T3 bug-triage workflow.

---

## 14. Modals, Popovers, Toasts & Keyboard Shortcuts

**TS Sources:** `components/ui/toast.tsx`, `components/ConfirmDialogHost.tsx`, `components/chat/ChatOverlayHosts.tsx`, `components/sidebar/WorkspaceDialog.tsx`, `components/chat/ThreadDetailsPanel.tsx`, `components/chat/ExpandedImageDialog.tsx`, `components/chat/HtmlRenderDialog.tsx`, `components/preview/ThreadPreviewMiniPlayer.tsx`, `components/PullRequestThreadDialog.tsx`, `components/QuitHoldOverlay.tsx`, `packages/shared/src/keybindings.ts`, `components/chat/useChatShortcuts.ts`, `shortcuts/chatRouteCommands.ts`
**Rust Sources:** `crates/conn-app/src/{app.rs,menus.rs,palette/mod.rs,settings/mod.rs,panels/linked_items/render.rs}`

### Modals, Overlays & Popovers
- `[x]` **Settings modal overlay (`SettingsModal`)** (`_chat.settings.tsx` -> `settings/mod.rs`).
- `[x]` **Command Palette modal overlay (`CommandPalette`)** (`CommandPalette.tsx` -> `palette/mod.rs`).
- `[x]` **Link Pull Request modal (`LinkPullRequestDialog`)** (`LinkPullRequestDialog.tsx` -> `panels/linked_items/render.rs:1038-1223`).
- `[~]` **Inline 2-click confirmations (`useInlineActionConfirm`)** (`useInlineActionConfirm.ts` -> `panels/pull_request/header.rs:46-54`, `panels/annotations.rs`): Implemented inside PR actions and Annotation clear, but **missing** global confirmation modal host for destructive thread/settings/quit actions.
- `[~]` **New Workspace button (`rail-new-workspace`) without `WorkspaceDialog`** (`WorkspaceDialog.tsx:45-416` -> `sidebar/rail.rs:131`): `WorkspaceDialog` (name, 12-color grid, `Letter` / `Image` upload / icon picker grid, grouped-by-connection project checkboxes with `Select all`/`Clear` + `Add project`, `Delete`/`Cancel`/`Create`/`Save`) is completely missing in `conn-gpui`!
- `[ ]` **Global Toast notification system (`ToastProvider`, `toastManager`, `AnchoredToasts`)** (`components/ui/toast.tsx:1-809`):
  - Top-right `dropdown-glass` stacked toasts (`error`, `info`, `loading`, `success`, `warning`) with corner dismiss orb (`X`), hover-expand stack, swipe/timeout auto-dismiss (pausing when window unfocused via `ThreadToastVisibleAutoDismiss`), thread-scoped visibility filtering, `Copy error` button on error toasts, expandable detail disclosure (`Show details`), and primary/secondary/additional action buttons.
  - Anchored tooltip-style toasts (e.g. `"Copied"` next to a button).
- `[ ]` **`ConfirmDialogHost` reusable modal confirmation dialog** (`ConfirmDialogHost.tsx:1-93`): Promise/callback-driven destructive/default AlertDialog (`Title`, multiline `Description`, `Cancel` + `Confirm`) used by Delete thread, Restore defaults, Install update, Close terminal, etc.
- `[ ]` **`ThreadDetailsPanel` floating popover card (`SquareMenuIcon` in header)** (`ThreadDetailsPanel.tsx:1-311`, `PanelLayoutControls.tsx:53-79`): Collapsible floating card showing Workspace/Environment, `OpenInPicker`, `ProjectScriptsControl` (run/add/edit/delete project scripts), `BranchToolbar`, `GitActionsControl`, `ThreadServersPanel` (detected dev servers), `ThreadAutomationsPanel`, `ThreadRelationshipsPanel` (subagent lineage), and `ThreadDetailsContext` (context window), with right-click `"Choose what to show"` visibility menu.
- `[ ]` **`ExpandedImageDialog` lightbox modal** (`ExpandedImageDialog.tsx:1-340`): Full-viewport (`92vw`) dark media lightbox for chat images & videos with zoomable/pannable image (`ZoomableImage`), multi-media `←`/`→` carousel buttons & keyboard arrows, `MediaActions` (copy/save/open), and `Esc` / backdrop close restoring composer focus.
- `[ ]` **`HtmlRenderDialog` expanded modal** (`HtmlRenderDialog.tsx:1-83`): Full-viewport modal for expanding agent `html_render` cards with `50%–200%` zoom controls (`-` / `%` / `+`) and close button.
- `[ ]` **`ThreadPreviewMiniPlayer` floating PiP overlay** (`ThreadPreviewMiniPlayer.tsx:1-631`): Draggable, 8-handle resizable floating preview over the chat canvas for Browser or Device streams, with `"Open in panel"` (`PanelRightIcon`), native window pop-out (`PictureInPicture2`), and Close (`X`).
- `[ ]` **`PullRequestThreadDialog` checkout/prepare modal** (`ChatOverlayHosts.tsx:58-96`, `PullRequestThreadDialog.tsx`): Prepare a thread/worktree from a PR URL or number (`Check out PR`).
- `[ ]` **`RevertConfirmHost` (Edit-from-here rewind dialog)** (`ChatOverlayHosts.tsx:182-228`): Three-way dialog (`Cancel` / `Revert files too` destructive / `Revert and keep changes`) when editing/rewinding an earlier chat turn.
- `[ ]` **`BranchRestoreConfirmHost` dialog** (`ChatOverlayHosts.tsx:134-180`): Confirmation when switching branches with uncommitted changes.
- `[ ]` **`QuitHoldOverlay` (`⌘Q` protection HUD)** (`QuitHoldOverlay.tsx:1-70`): Centered pill HUD (`"Hold ⌘Q or press twice to quit"` / `"Press ⌘Q again to quit"`) honoring `settings.confirmQuit`.

### Out-of-Scope Modals (`[-]`)
- `[-]` **Guest Share Dialog (`guestShareDialogState.ts`)** (`docs/scope.md` #27 `Drop`).
- `[-]` **SnapShot Accessibility Data overlay & Setup Dialog** (`ExpandedImageDialog.tsx:215-221`, `SnapShotSetupDialog.tsx`) — `docs/scope.md` #26 (`Drop`).
- `[-]` **Theme Editor floating panel & Inspector spotlight (`ThemeEditorHost.tsx`)** — `docs/scope.md` #30 (`Drop`).

### Global & Surface Keyboard Shortcuts Audit (`packages/shared/src/keybindings.ts:147-239`)

| Shortcut | Command (Conn) | Scope | `conn-gpui` Status |
| --- | --- | --- | --- |
| `⌘K` | `commandPalette.toggle` | Keep | `[x]` (`palette/mod.rs:34`) |
| `⌘,` | Open Settings | Keep | `[x]` (`settings/mod.rs:44`) |
| `⌘B` | `sidebar.toggle` | Keep | `[x]` (`app.rs:28`) |
| `⌘⌥B` | `rightPanel.toggle` | Keep | `[x]` (`app.rs:29`) |
| `⌘N` | `chat.new` | Keep | `[x]` (`app.rs:30`) |
| `⌘Q` / `⌘M` | Quit / Minimize | Keep | `[x]` (`menus.rs:19,21`) — `⌘Q` lacks Hold/Double-press mode |
| `⌘W` | `rightPanel.close` (when `!terminalFocus`) / Close window | Keep | `[~]` (`menus.rs:20` always closes the entire window instead of closing the active right-panel tab first!) |
| `⌘P` | `filePicker.toggle` | Keep | `[ ]` Missing |
| `⌘⇧F` | `projectSearch.toggle` | Keep | `[ ]` Missing |
| `⌘F` | `chat.find` (`!terminalFocus && !previewFocus`) | Keep | `[ ]` Missing |
| `⌘D` | `diff.toggle` (`!terminalFocus`) | Keep | `[ ]` Missing |
| `⌘J` | `terminal.toggle` | Keep | `[ ]` Missing |
| `⌘⇧J` | `preview.toggle` | Keep | `[ ]` Missing |
| `⌘T` | `rightPanel.new` (`rightPanelOpen && !terminalFocus`) | Keep | `[ ]` Missing |
| `⌘⇧T` | `view.reopenClosed` | Keep | `[ ]` Missing |
| `⌘⇧B` | `threadPanel.toggle` (Thread Details card) | Keep | `[ ]` Missing |
| `⌘[` / `⌘]` | `navigation.back` / `navigation.forward` | Keep | `[ ]` Missing |
| `⌘⇧[` / `⌘⇧]` | `thread.previous` / `thread.next` | Keep | `[ ]` Missing |
| `⌘1`–`⌘9` | `thread.jump.1..9` / `modelPicker.jump.1..9` | Keep | `[ ]` Missing |
| `⌘⇧N` / `⌘⌥N` | `chat.newLocal` / `chat.newWithoutProject` | Keep | `[ ]` Missing |
| `⌘O` | `editor.openFavorite` | Keep | `[ ]` Missing |
| `⌘⇧C` | `thread.copyReference` | Keep | `[ ]` Missing |
| `⌘⇧K` | `pullRequest.copyNumber` | Keep | `[ ]` Missing |
| `⌘⇧S` / `⌘⇧P` | `thread.settle` / `thread.pin` | Keep | `[ ]` Missing |
| `⌘Z` | `thread.undo` (`!terminalFocus && !editableFocus`) | Keep | `[ ]` Missing |
| `⌘⌥A` / `⌘⌥⇧A` | `theme.select` / `appearance.cycle` | Keep | `[ ]` Missing |
| `⌘R` / `⌘L` / `⌘+` / `⌘-` / `⌘0` | `preview.*` (`previewFocus`) | Keep | `[ ]` Missing |
| `⌘⇧A` | Browser/Device annotation toggle (`previewFocus`) | Keep | `[ ]` Missing |
| `⌘⇧M` / `⌘⇧H` / `⌘⇧E` / `⌘⇧A` / `⌘⇧X` / `⌘⇧G` / `⌘⇧L` | Composer model/host/effort/mode/workspace/branch/prev-worktree | Keep | `[ ]` Missing |
| `⌘S` | `composer.stash` | Keep | `[ ]` Missing |
| `⌘⇧↵` / `⌥↑` / `⌘↵` / `⌘⌥↵` | Composer steer/edit queued / send alternate / send background | Keep | `[ ]` Missing |
| `F6` / `⇧F6` | `workspace.focusNext` / `workspace.focusPrevious` | Keep | `[ ]` Missing |
| `⌘D` / `⌘⇧D` / `⌘N` / `⌘W` (`terminalFocus`) | Multi-tab/split terminal commands | Deferred (`docs/scope.md` #16) | `[-]` Deferred |
| `⌘U`, `c`/`t`/`l`, `⌘⇧1..4` | Usage page shortcuts | Drop (`docs/scope.md` #3) | `[-]` Out of scope |
| `⌘⌥⇧T` | `themeEditor.toggle` | Drop (`docs/scope.md` #30) | `[-]` Out of scope |

---

## Prioritized Porting Batches

All `[ ]` and `[~]` items grouped into concrete, dependency-ordered, multi-agent-safe implementation chunks:

### Batch 1 — Core Overlays Infrastructure & Global Shortcuts (`crates/conn-app/src/{overlays/,toast.rs,app.rs,menus.rs}`)
*High user-facing leverage; unblocks feedback & confirmations across every panel and settings page.*
1. **Toast System (`toast.rs`)**: `ToastProvider` overlay in top-right (`dropdown-glass`), stacked cards, corner dismiss `X`, auto-dismiss pausing on window blur, `Copy error` button, action buttons, and anchored tooltip-toasts (`"Copied"`).
2. **`ConfirmDialogHost`**: Reusable confirmation modal (`Title`, `Description`, `Cancel` + default/destructive `Confirm`) + `RevertConfirmHost` (3-way edit-from-here) + `BranchRestoreConfirmHost` + `QuitHoldOverlay` (`⌘Q` hold/double-press).
3. **`WorkspaceDialog`**: Full create/edit workspace modal (name, 12 colors, Letter/Image/icon picker, grouped-by-connection project checklist, Delete/Save) wired to `rail-new-workspace` and workspace rail right-click Edit.
4. **Core Keybinding Wave 1**: Fix `⌘W` to close active right-panel tab before closing window; wire `⌘D` (Diff), `⌘J` (Terminal), `⌘⇧J` (Browser), `⌘T` (`+` add-panel menu), `⌘⇧T` (reopen closed tab), `⌘[`/`⌘]` (history), `⌘⇧[`/`⌘⇧]` (prev/next thread), `⌘1–⌘9` (thread jump), `⌘⌥A`/`⌘⌥⇧A` (theme/appearance), `⌘⇧S`/`⌘⇧P`/`⌘⇧C`.

### Batch 2 — Right Panel Shell Parity (`crates/conn-state/src/layout.rs`, `crates/conn-app/src/panels/header.rs`, `app.rs`)
1. **Per-thread right panel state** (`by_thread_id` map of open tabs, active tab, visibility, width, maximized) + closed-tab stack (`⌘⇧T`).
2. **Dynamic tab headers**: Live browser title + favicon + audio mute button, PR `#number` + state-colored glyph, Device target name + OS glyph, unsaved file dirty dot, and truncated tab tooltips.
3. **Tab strip polish**: Overflow scroll buttons (`<`/`>`) + wheel horizontal scroll + active-tab scroll-into-view, drag-to-reorder tabs, tab right-click context menu (`Copy path`, `Mute`, `Close`, `Close others`, `Close to the right`, `Close all`).
4. **Header cleanup & empty state**: Remove dead `panel-bottom.svg` stub button and stray `Browser` chevron-right in `+` menu; add `RightPanelEmptyState` ("Open a surface" launcher with arrow/letter navigation); support multiple concurrent Browser tabs (`browser:<id>`); add narrow-viewport `RightPanelSheet`.

### Batch 3 — Search Overlays & Command Palette Completeness (`crates/conn-app/src/palette/`)
1. **`ProjectFilePicker` (`⌘P`)**: Server-backed `projects.searchEntries` fuzzy file jump with `@pierre/trees` icons, highlighted match ranges, and opening file tabs.
2. **`ProjectContentSearchDialog` (`⌘⇧F`)**: Full project grep dialog (`Aa`, `ab`, `.*` toggles, sticky file groups, syntax-highlighted match lines, line numbers, jump to file+line).
3. **`ThreadFindBar` (`⌘F`)**: Floating top-right glass search pill over chat timeline (`N/M`, prev/next, Enter/Shift+Enter, Esc, match highlights).
4. **Command Palette parity**: Add missing `Open API/Database/MCP/Tasks/Pull request/Linked items/Device` actions; add submenu stack (`Backspace` back) for `New thread in…`, `Add project` (folder browser + GitHub clone), `New project`, `Change theme/appearance`; include Settings search items + async `In messages` search + `Restart agent session` + `Copy thread`/`PR link` + `Link PR`; wrap-around keyboard nav & hover-sync + match range bolding + restore composer focus.

### Batch 4 — Files & Diff/Git Panel Depth (`crates/conn-app/src/panels/{files.rs,tree.rs,diff.rs}`)
1. **Unwrapped horizontal scroll fix** in `files.rs`, `diff.rs`, and `pull_request/tabs.rs` (replace `overflow_hidden().whitespace_nowrap()` clipping with horizontal scroll container).
2. **Files Panel parity**: Server `projects.searchEntries` + Esc clear + folder spinner + retry banner; interactive clickable `FileBreadcrumbs` with sibling `FolderContentsMenu` + `ArrowLeft`; toggleable resizable `FileExplorerPane` in file tabs; `OpenInPicker` (editor / Reveal in Finder); tree right-click context menu + drag-to-mention; `workspaceMutationId` auto-refresh; button tooltips + copy checkmark feedback; line reveal + flash (`revealLine`).
3. **Rich File Previews & Editing**: Markdown preview toggle (with interactive checkboxes), Mermaid/CSV/HTML previews, Image/Video/Audio/PDF/Binary/LargeText viewers, inline `EditableFileSurface` with autosave, and line-selection review comments -> composer.
4. **Diff Panel parity**: Move hierarchical `DiffFileTree` to right side (default closed) + render all changed files continuously with collapsible sticky headers + Expand/Collapse all (`ChevronsDownUp`/`ChevronsUpDown`); fix reversed `head → base` arrow + searchable base-ref combobox with `Remote` toggle; add `Latest turn` & `Tool call` scopes + commit timestamps/GitHub links; segmented persisted `Stacked`/`Split` toggle; `Hide test files` toggle; expandable hidden context lines; inline diff review comments -> composer; `DiffPanelLoadingState` skeleton & auto-refresh.
5. **`GitActionsControl` + `ThreadDetailsPanel`**: Build `ThreadDetailsPanel` (`SquareMenu` header toggle, `⌘⇧B`) hosting `GitActionsControl` (Commit/Push/Pull/Create PR/Publish GitHub repo + Commit message & file-selection modal + default-branch confirm), `OpenInPicker`, `ProjectScriptsControl`, `BranchToolbar`, detected dev servers, automations, and lineage.

### Batch 5 — Browser, Laravel Toolbar, API, Database & Terminal Parity (`crates/conn-app/src/panels/{browser.rs,api.rs,database/,terminal.rs}`)
1. **Full 8-panel `BrowserLaravelToolbar` + API Panel wiring**: Build reusable floating blur sheet for all 8 Laravel Toolbar panels (`Requests`, `Request`, `Timings`, `Memory`, `Database` -> click query opens Database panel via `openDatabaseQuery`, `Models`, `Orbit`, `Environment`) and mount it in both `BrowserPanel` and `ApiPanel` (plus `baseUrl` seeding and response syntax highlighting/copy in `ApiPanel`).
2. **Browser Chrome & Tools**: `PreviewMoreMenu` (`⋮` — Hard reload, CEF DevTools, Separate window PiP, Device toolbar toggle, Appearance, Zoom `-`/`%`/`+`/Reset, Clear cookies/cache), `BrowserDeviceToolbar` (device presets, W×H, lock, rotate), Screenshot & Recording (`Camera` + Shift-record), Element/Region/Drawing picker to composer, URL bar search-engine fallback + Esc revert + external-browser icon + 2px loading progress bar, `PreviewEmptyState` (Recently used + Local servers), `PreviewUnreachable` error page, Test Logins merged into Credential popover, single hover-queue Annotations button + `⌘⇧A`, browser shortcuts (`⌘L`/`⌘R`/`⌘[`/`⌘]`/`⌘+`/`⌘-`/`⌘0`), and `ThreadPreviewMiniPlayer` PiP.
3. **Terminal RPC & UX**: Route `TerminalPanel` through `conn-server` `terminal.*` RPCs so remote Orbit Nodes/Instances get real remote shells; replace overlapping floating buttons with a 22px top border bar + `⌘K` clear; add right-click context menu (`Add to chat`, `Copy`, `Paste`, `Select all`, `Jump to bottom`) and clickable URL/file links; honor terminal font settings.
4. **Database Polish**: SQL syntax highlighting in editor, source section headers in connection menu (`From .env` / `Saved` / `Vault`), and click-to-copy cell values.

### Batch 6 — Pull Request, Tasks & Device Polish (`crates/conn-app/src/panels/{pull_request/,linked_items/,tasks/,device/}`)
1. **Pull Request & Linked Items**: Add `PullRequestCheckoutMenu` (`In a separate worktree` / `In this repository`) + `PullRequestThreadDialog`; upgrade PR Code tab to continuous multi-file diff with commit filter, Split/Unified, ignore whitespace, hide test files, and inline PR review annotations + pending review queue; add PR Stack header/menu; add comment edit/delete; add `Shift` speed actions & drag-to-composer in Linked Items.
2. **Tasks Panel wiring**: Wire `TasksPanel::open_pull_request` to open inline `RightPanelTab::PullRequest` instead of macOS `open`; wire `TasksPanel::open_agent_conversation` to navigate to the target thread.
3. **Device Panel cleanup & polish**: Strip out-of-scope EAS Cloud & Simlock forms from `panels/device/hosts.rs` (per `docs/scope.md` #24); hide permanently disabled 3D view button in rail; wire AX element frame overlay painting; add Float PiP & foldable/Duo viewport support; switch screenshot notice to toast.
4. **Media Lightboxes**: Implement `ExpandedImageDialog` (zoomable/pannable carousel lightbox) and `HtmlRenderDialog` (`50%–200%` zoom modal) for chat timeline media/HTML cards.

### Batch 7 — Settings Modal In-Scope Expansion (`crates/conn-app/src/settings/`)
1. **Settings Navigation & Search**: Group sidebar nav (`Core`, `Agents`, `Code`, `Connections`, `Maintenance/About`), default to `General`, add `/` & `⌘F` search focus with sidebar result list + arrow/Enter jump-and-highlight, add `Restore device defaults` header button + per-row reset buttons.
2. **General & Appearance Completion**: Populate `General` (In-app notifications, Project order, Unpin/Archive/Delete/Quit confirmations, Time format); complete `Appearance` (System/Light/Dark scheme + paired theme halves, Contrast & Glass opacity sliders, Chat width, Thread details visibility, Effort display, Render math, Panel animations, Composer context, full `TypographySection`).
3. **Missing In-Scope Settings Pages**:
   - `Chat` (Rich text composer, Send shortcut, Skills in `/` menu, Queue/Steer follow-up)
   - `Diffs & pull requests` (Diff layout, Ignore whitespace, Default collapsed, Diff colors, Proactive panels, Open PR links in app)
   - `Threads` (Add project base dir, Default model/permissions/new-thread mode, Auto-settle rules, Text gen model, Response streaming)
   - `Browser` (Agent browser access, Default viewport/zoom/appearance, Recording FPS/overlays, Open links in, Search engine, Auto-show PiP, Dictation URLs)
   - `Passwords` (Vaultwarden/Vault bridge status + Test Logins CRUD + Block scripts after fill + Subdomain fill)
   - `Devices` (Hub toggle, Agent device access, Local simulator check, SSH remote host editor moved/linked from `DevicePanel`)
   - `Projects` (Name/icon/path, Project Actions/Scripts + `t3.json`, per-project overrides)
   - `Providers` (CLI status/versions for claude/codex/acp, custom binary/env/models, Compact idle threads)
   - `Source control` & `Worktrees` (GitHub token/CLI, Auto-pull, Remove agent credits, Default merge method; Start from remote, Submodules, Worktree location & cleanup)
   - `Maintenance` & `About` (Provider update checks, Continue after restarts, Background activity profile, Artifacts/logs cleanup; Version/updates, CLI command, Licenses)
   - `Scheduled tasks` polish: add `WebhookFiltersField` and delete confirmation.
   - `Keyboard` reference: sync table with all implemented shortcuts from Batch 1 & 3.
