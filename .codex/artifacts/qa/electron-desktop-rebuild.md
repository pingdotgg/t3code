# Electron Desktop QA

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`
App: `ClayCode (Alpha)` built desktop bundle
State dir: `/tmp/t3-electron-qa-state`

## Build + launch

- Passed `bun run build:desktop`
- Passed `bun run test:desktop-smoke`
- Launched the built Electron app via `apps/desktop` `bun run start`

## QA inventory

- Desktop app launches from the built Electron bundle
- Project onboarding works in Electron
- Draft-thread creation works in Electron
- Snippet picker opens and inserts a snippet into the composer
- Quick thread search opens from the keyboard shortcut and navigates to a thread
- Desktop Connections settings render the Tailnet access row and network-access confirmation dialog
- Identify any Electron-specific blockers for provider-backed turn flows

## Passed

- Added the repo as a project from the desktop `Add project` flow using `/Users/canal/.codex/worktrees/28c4/t3code`
- Verified the app created a fresh draft thread route on project open
- Switched the provider selector from unavailable Codex to `Claude Sonnet 4.6`
- Opened the snippet picker from the composer and confirmed built-in snippets render in the dialog
- Filtered/selected the built-in `Write Tests` snippet and verified it inserted into the composer
- Opened Quick Thread Search with `Cmd+Shift+F`
- Verified the Quick Thread Search dialog rendered with the expected search/help copy
- Searched for the existing thread and confirmed navigation back into that thread route
- Created another new draft thread from the sidebar and verified the route changed to a new `/draft/<id>`
- Opened `Settings -> Connections`
- Verified the `Tailnet access` row rendered with the live Tailnet hostname and IP
- Toggled `Network access` and verified the confirmation dialog opened with `Cancel` and `Restart and enable`
- Cancelled the dialog successfully and confirmed the settings page returned to its prior state

## Hotkeys

- `Cmd+Shift+F`: passed. Opened Quick Thread Search and navigated back into the existing thread route from a fresh draft thread.
- `Cmd+Shift+S`: passed. Opened the snippet picker in Electron and exposed the built-in snippet list; I also verified snippet insertion into the composer in the same desktop run.
- `Cmd+[` / `Cmd+]`: attempted against real draft/thread route history, but no route change was observed in the later Electron session. Because Computer Use key injection became inconsistent for command shortcuts in that session, I am treating this result as inconclusive rather than claiming a definite product regression.
- `Tab` while a turn is running: passed. I typed `Then list the exact Queue + Steer functions and where each one is called.` during an active `GPT-5.4` run, pressed `Tab`, and verified the queued panel appeared with `1 queued follow-up`, `Ready to dispatch in order.`, and the expected queued row actions.
- `Enter` while a turn is running: passed. I then typed `Also explain how Steer with Enter differs from Queue with Tab.` during the same live run, pressed `Enter`, and verified it posted immediately as a new live user turn instead of going back into the queue.
- `Shift+Tab` composer mode toggle: not separately re-verified in Electron once shortcut delivery became inconsistent; this still needs a clean follow-up pass if we want explicit desktop-only evidence for every shortcut.

## Blocked / not fully verified

- Codex provider-backed turn execution is blocked in this Electron run because the desktop app reports `Codex CLI is not authenticated. Run \`codex login\` and try again.`
- Claude-backed turn execution is also blocked for full happy-path validation because the attempted message failed immediately with `Credit balance is too low`
- I was able to re-verify live-response behavior in Electron with `GPT-5.4`, including:
  - successful response rendering from a live provider-backed turn
  - queueing a follow-up during an active response with `Tab`
  - steering immediately during an active response with `Enter`
  - queued follow-up auto-dispatch after the active turn settled
- I did not re-verify queued follow-up save-from-queue behavior in this Electron pass.

## Notes

- The Electron shell, routing, project onboarding, settings surfaces, snippet picker, quick thread search, and draft-thread navigation all behaved correctly in the built desktop app
- Live provider-backed turns are workable in Electron through `GPT-5.4`, even though the Codex and Claude providers remained blocked in this environment for separate auth/quota reasons
- In the successful queue/steer pass, the queued panel disappeared after dispatch and both follow-up user turns were visible in-thread while the assistant continued working, which is the expected user-facing behavior
- Command-shortcut delivery through Computer Use became inconsistent later in the session, so the sidebar-history hotkeys need one cleaner follow-up check before I would mark them definitively passed or failed in Electron
