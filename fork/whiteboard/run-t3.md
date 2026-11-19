# Run the embedded chat

The whiteboard is `fork/whiteboard/` of a T3 Code fork. The T3 Code at the repository root, two levels up, carries the whiteboard's embedding changes, and the whiteboard's chat panel is an iframe that shows it. That instance keeps its state under `~/.whiteboard/t3-userdata` and reads nothing from a personal T3 installation (`~/.t3`, port 3773, the `t3code` service).

Browsers reach it only through the whiteboard's `webPort`. The whiteboard proxies `/chat/` on `webPort` to `chatPort`, along with the chat's own `/api`, `/ws`, and `/.well-known` paths, so `chatPort` stays bound to `127.0.0.1` and is never exposed. This instance accepts every browser without pairing, so expose `webPort` only to people who may use the chat.

## Install and build

Run once, and again after changing anything under `apps/web` or `packages/`. The server serves the built output. `VITE_T3_WHITEBOARD=1` selects the whiteboard build: it is configured for the `/chat/` prefix, so its pages load only through the whiteboard's `webPort`; opening `chatPort` straight in a browser fails to fetch the assets. A build without the variable is a normal T3 Code build and does not work behind `/chat/`.

```bash
cd ../..   # the repository root
pnpm install
VITE_T3_WHITEBOARD=1 pnpm --dir apps/web run build
```

## Run as a systemd user service

`run-t3.sh` starts the T3 Code of the repository it sits in. Three environment variables override its defaults: `T3_PORT` (default `6070`, must equal `chatPort` in `~/.whiteboard/config.json`), `T3_DATA` (default `~/.whiteboard/t3-userdata`), and `T3_PROJECT` (default the repository root). `T3_PROJECT` is only the server's working directory: with auto-bootstrap off it opens no project, and it does not choose a board.

Save this as `~/.config/systemd/user/whiteboard-chat.service`, with `WorkingDirectory` set to the repository root:

```ini
[Unit]
Description=Whiteboard embedded T3 Code

[Service]
WorkingDirectory=/path/to/t3code
ExecStart=/usr/bin/env bash fork/whiteboard/run-t3.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

A usage source is a CLIProxyAPI hub added in settings. The hub is a separate program that holds Claude logins and answers usage and reset-credit requests. To use only a usage source for Claude usage reads, reset-credit reads and reset redemptions, add `Environment=T3CODE_CLAUDE_USAGE_SOURCE_ONLY=1` under `[Service]`. For a login that no source holds, the server then reports "No usage source holds this Claude login." instead of reading the login's usage and reset credits from Claude. `apps/server/src/fork/claudeUsageSource/claudeLoginSource.ts` decides when a request goes through a source.

Then enable the service. `enable-linger` keeps user services running after you log out.

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now whiteboard-chat
```

Restart after a rebuild with `systemctl --user restart whiteboard-chat`; read its log with `journalctl --user -u whiteboard-chat -f`.

## Embedding changes to T3 Code

The fork's T3 Code differs from upstream in the points below for the whiteboard's sake. Keep this list current when merging upstream. Server points are switched by environment variables that `run-t3.sh` sets. Web points are switched at build time by `VITE_T3_WHITEBOARD=1`, read by `apps/web/vite/fork/whiteboardBuild.ts` (Vite) and `apps/web/src/fork/whiteboard/build.ts` (client code; `isEmbeddedInWhiteboard()` adds the check that the page is inside the board's iframe). Whiteboard-only client code lives in `apps/web/src/fork/whiteboard/`; upstream files hold only the call or import.

- No login, behind a switch. With `T3CODE_UNSAFE_NO_AUTH=1` (set by `run-t3.sh`), requests without a credential, or with a rejected one, get a session with the standard client scopes (`unsafe-no-auth`; no admin scopes such as `review:write`) instead of a 401, websocket tickets issued to that session are accepted, and its websocket does not wait for revocation (the session has no stored row, so upstream's revocation check would end the socket at once). Without the variable upstream auth applies unchanged, so upstream's auth tests stay as they are. Files: `apps/server/src/auth/EnvironmentAuth.ts`, `apps/server/src/ws.ts` (one added test in `EnvironmentAuth.test.ts`).
- Framing from the same origin, behind a switch. With `T3CODE_ALLOW_SAME_ORIGIN_FRAME=1` (set by `run-t3.sh`) the app page is sent with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so the board page can frame `/chat/` and other sites stay refused. Without the variable upstream's headers apply unchanged (`frame-ancestors 'none'`, `DENY`), so upstream's test stays as it is. Files: `apps/server/src/fork/sameOriginFrame.ts` (with test), `apps/server/src/http.ts` (the call).
- Whiteboard skills for agents. `T3CODE_CLAUDE_PLUGIN_ROOT` is loaded as a local Claude plugin; `T3CODE_CODEX_SKILL_ROOT` is registered with each Codex app-server through `skills/extraRoots/set`. Files: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (`makeClaudeQueryOptions`, with test), `CodexAdapterV2.ts` (after `initialize`), `apps/server/src/provider/codexLaunchArgs.ts` (`resolveCodexSkillRoot`, with test), `apps/server/src/provider/CodexProvider.ts` (probe client). `run-t3.sh` sets both variables, puts `tools/bin` on `PATH`, and sets `BASH_ENV` to `tools/agent-env.sh`.
- Served under `/chat/` (whiteboard build). The Vite plugin sets `base: "/chat/"` and recolours `manifest.webmanifest` from `#161616` to the board page's `#0a0a0a`; the router gets `basepath: "/chat"`. The manifest's icon paths are relative in every build. Files: `apps/web/vite/fork/whiteboardBuild.ts`, `apps/web/vite.config.ts` (plugin entry), `apps/web/src/router.ts`, `apps/web/public/manifest.webmanifest`.
- Whiteboard links (every build). `board://` links in assistant markdown are allowed and rendered with hover and click handlers that reach the board through `apps/web/src/fork/whiteboard/boardChannel.ts`: inside the board page's chat slot as `wb-hover` and `wb-highlight` messages to the parent window, on a board host as messages to the Whiteboard tab's frame (next entry), and nowhere otherwise, and `[label](board://...)` mention chips in the composer show the label and report hover. Files: `apps/web/src/fork/whiteboard/markdown-whiteboard.ts` (with test), `apps/web/src/components/ChatMarkdown.tsx`, `packages/shared/src/markdownPipeline.ts` (`board` href protocol), `apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `packages/shared/src/composerInlineTokens.ts` (board mention token, with test).
- Parent-window messages (whiteboard build, inside the iframe). The chat posts `wb-project` (workspace root and thread key) when the active thread changes, inserts a reference into the composer on a `wb-insert-ref` message, and follows the board panel's state: it asks with `wb-layout-get`, the parent answers with `wb-layout` (`boardHidden`), and while the board is collapsed a Board button before the sidebar trigger posts `wb-show-board`. Files: `apps/web/src/fork/whiteboard/useWhiteboardProject.ts` (called from `components/ChatView.tsx`), `useWhiteboardInsertRef.ts` (called from `components/chat/ChatComposer.tsx`), `WhiteboardSidebar.tsx` (hooks and Board button, used by `components/AppSidebarLayout.tsx`).
- Iframe layout (whiteboard build). The composer never switches to its mobile layout. Standalone, the sidebar starts open only when the window fits it beside the minimum thread width; inside the iframe it starts closed, unless the first `wb-layout` report says the board is hidden and the sidebar fits. The whiteboard build passes no `storageKey`, so upstream's stored sidebar state (#24202) is off and this start rule applies on every load. Files: `apps/web/src/components/chat/ChatComposer.tsx` (`isMobileViewport`), `apps/web/src/components/AppSidebarLayout.tsx` (`SidebarProvider` props), `apps/web/src/fork/whiteboard/WhiteboardSidebar.tsx` (`whiteboardSidebarProviderProps`).
- Board as a right-panel tab (whiteboard build, top-level window). When some hostname in `openViews` maps to `"app"`, `run-t3.sh` exports `T3CODE_WHITEBOARD_PANEL` as `{"menu": <rightPanelMenu>}`; it leaves the variable unset otherwise, and also when the config cannot be read, which it reports in one line. The server parses the variable leniently and advertises it as the `whiteboardPanel` capability; without it the client is unchanged. With it, the right panel's menu offers a Whiteboard item that opens the board page's embed mode, `/?embed=panel&room=<project root>`, in an iframe, and Settings > Right panel lets each browser hide menu items or change their letters over the machine defaults. The board page in that iframe renders the board alone (`web/pageMode.ts` picks the mode, `web/panelHost.ts` bridges it): it posts `wb-ready` to the parent once the board can show a region and `wb-unload` when the page goes away, takes `wb-highlight`, `wb-hover` (with `origin` in the iframe's coordinates) and `wb-visible` (a hidden board stops drawing), and posts `wb-insert-ref`. Both sides accept messages only from their own origin and from the other window. `boardChannel.ts` keeps the iframe loaded while its tab is hidden: it owns one frame per board page and moves it with `Element.moveBefore` between the tab and a hidden holder, at most two per window, and unloads a board when no thread that showed it lists its tab; browsers without `moveBefore` reload it. Files: `apps/server/src/fork/whiteboardPanel.ts` (with test), `packages/contracts/src/fork/rightPanelMenu.ts` (with test), `apps/web/src/fork/whiteboard/` (`role.ts`, `WhiteboardPanel.tsx`, `boardChannel.ts`, `boardChannel.logic.ts` with test, `useWhiteboardInsertRef.ts`), `apps/web/src/fork/rightPanelMenu/` (resolver with test, the settings page, the nav, search and all-hidden hooks), `apps/web/src/fork/dashboard/dashboardSurface.ts` (the Whiteboard item beside Dashboard and Replies). Upstream hooks, each a few lines that call into those files: `apps/server/src/environment/ServerEnvironment.ts`, `packages/contracts/src/{environment,settings,index}.ts`, `apps/web/src/rightPanelStore.ts` and `closedViewStore.ts` (the `whiteboard` kind), `apps/web/src/components/RightPanelTabs.tsx` (an `id` on each menu item, the two `useArrangedSurfaceActions` wraps, the all-hidden hint, title and icon cases), `components/chat/RightPanelSurfaceContent.tsx` (the tab body), `components/ChatMarkdown.tsx` (the link click), `components/chat/ChatComposer.tsx` (the composer's insert hook), `components/settings/{settingsSearch.ts,useAvailableSettingsSearchItems.ts,SettingsSidebarNav.tsx,SettingsScopeSentence.tsx}` and `routes/_chat.settings.right-panel.tsx` (the page, its nav entry, its search gate). A merge that drops the `SettingsSidebarNav.tsx` or search hook still type-checks, so check the page's nav and search entries by hand. The settings page repeats the upstream items' built-in letters (`RightPanelMenuSettings.tsx`); when upstream changes a letter in `RightPanelTabs.tsx`, change it there too.
- New-thread landing. `run-t3.sh` sets `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false` so each page load opens the new-thread page rather than the oldest thread of the project.
- Board of the calling chat. `run-t3.sh` exports `WB_CHAT_PID`, the server's own PID, which agents inherit. `wb` walks up its parent processes to the server's child, the agent, and uses that agent's working directory to pick the board.
