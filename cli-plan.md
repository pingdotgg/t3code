# T3 CLI full capability implementation plan

Build CLI parity by adding a reusable RPC client first, then layer command groups over existing contracts.

1. **Create the CLI runtime foundation**
   - Add a shared CLI client module in `apps/server/src/cli/`.
   - Resolve target server from flags/env/persisted runtime state: `--url`, `--token`, `--base-dir`, `--environment`.
   - Support live server mode first; keep existing offline project mutation behavior only where safe.
   - Add common output helpers: human table, pretty JSON, `--json`, `--quiet`, `--watch`, error formatting.
   - Add typed helpers for generating `commandId`, `threadId`, `messageId`, timestamps, and parsing `ModelSelection`.

2. **Add a generic escape hatch**
   - `t3 rpc call <method> --payload <json|file>`
   - `t3 orchestration dispatch --payload <json|file>`
   - `t3 orchestration snapshot`
   - `t3 orchestration watch --shell`
   - This gives immediate full power while ergonomic commands are built.

3. **Implement read-only app inspection**
   - `t3 server config`
   - `t3 server lifecycle --watch`
   - `t3 project list/show`
   - `t3 chat list/show --messages`
   - `t3 chat archived`
   - `t3 provider list/status/models/options`
   - `t3 skills list`
   - These should mostly wrap `subscribeShell`, thread subscription snapshots, provider config, and settings.

4. **Complete project commands**
   - Extend existing `t3 project` with:
     - `list`
     - `show <project>`
     - `set-default-model <project> ...`
     - `set-scripts <project> --json/file`
     - `search <project> <query>`
     - `browse <project> [path]`
     - `write-file <project> <path> --content/--file`
     - `open <project> --editor <id>`
   - Reuse `project.create`, `project.meta.update`, filesystem, and project RPCs.

5. **Add chat/thread lifecycle commands**
   - `t3 chat create --project <id|path> --title ... --model ...`
   - `t3 chat rename <thread> <title>`
   - `t3 chat delete <thread>`
   - `t3 chat archive/unarchive <thread>`
   - `t3 chat fork <thread> --message <message-id>`
   - `t3 chat set-model <thread> ...`
   - `t3 chat set-runtime <thread> <runtime-mode>`
   - `t3 chat set-interaction <thread> <interaction-mode>`
   - `t3 chat set-branch <thread> --branch ... --worktree ...`
   - Back these with `thread.*` orchestration commands.

6. **Add turn/conversation commands**
   - `t3 chat send <thread> <prompt>`
   - `t3 chat new <prompt> --project ...`
   - `t3 chat stream <thread>`
   - `t3 chat interrupt <thread> [--turn <id>]`
   - `t3 chat stop <thread>`
   - `t3 chat queue add/update/delete <thread>`
   - `t3 chat queue dispatch <thread> <queued-turn>`
   - Support `--file`, `--attachment`, `--model`, `--reasoning`, `--thinking`, `--effort`, `--fast-mode`.
   - For streaming, subscribe to thread events and render assistant deltas, tool activity, approvals, and completion status.

7. **Add approvals and user-input handling**
   - `t3 approval list [--thread <id>]`
   - `t3 approval respond <thread> <request-id> --approve|--deny`
   - `t3 input list [--thread <id>]`
   - `t3 input respond <thread> <request-id> --answers <json>`
   - Source pending items from thread snapshots/events; dispatch `thread.approval.respond` and `thread.user-input.respond`.

8. **Add model/provider management**
   - `t3 model list [--provider <instance>]`
   - `t3 model options <provider> <model>`
   - `t3 model default get/set`
   - `t3 provider refresh [instance]`
   - `t3 provider commands <instance>`
   - `t3 provider enable/disable <instance>`
   - `t3 provider instance add/update/remove/list`
   - `t3 provider set <instance> --binary-path ... --custom-model ... --env ...`
   - Implement provider settings through `server.getSettings`, `server.updateSettings`, and `server.updateProvider`.

9. **Add diff/checkpoint/export commands**
   - `t3 diff turn <thread> <turn>`
   - `t3 diff thread <thread>`
   - `t3 diff state <thread> [--turn <turn>]`
   - `t3 checkpoint list <thread>`
   - `t3 checkpoint revert <thread> --turn-count <n>`
   - `t3 export markdown <thread> [--editor <id>]`
   - Wrap orchestration diff RPCs and `server.exportThreadMarkdown`.

10. **Add Git/VCS/source-control commands**
    - `t3 git status/watch/pull/branches/create-branch/checkout/init`
    - `t3 git worktree create/remove`
    - `t3 git pr resolve/prepare-thread`
    - `t3 git stacked-action ...`
    - `t3 vcs status/pull/refs/create-ref/switch-ref/worktree/init`
    - `t3 source-control discover/lookup/clone/publish`
    - Use existing Git, VCS, and source-control RPC contracts.

11. **Add terminal commands**
    - `t3 terminal open --thread <id> [--cwd ...]`
    - `t3 terminal attach <terminal-id|thread>`
    - `t3 terminal write <terminal> <input>`
    - `t3 terminal clear/restart/close`
    - `t3 terminal metadata --watch`
    - Render attach streams safely; support raw mode later as a separate interactive milestone.

12. **Add settings, keybindings, diagnostics**
    - `t3 settings get/set/update --json`
    - `t3 settings observability get/set`
    - `t3 keybinding list/add/remove`
    - `t3 diagnostics trace`
    - `t3 diagnostics process`
    - `t3 diagnostics resources`
    - `t3 diagnostics signal <pid|process-id> <signal>`
    - Keep destructive ops explicit with confirmation or `--yes`.

13. **Add environment/remote management**
    - `t3 env list/add/remove/rename`
    - `t3 env secret set/remove`
    - `t3 env connect/test`
    - `t3 env use <id>`
    - Persist local environment registry/secrets where the desktop/web client currently does, or define server-side CLI-specific storage if local browser storage is unavailable.

14. **Design command UX and compatibility rules**
    - Every command supports `--json`.
    - Mutating commands print stable IDs.
    - Selectors should accept IDs first, then exact title/path fallback.
    - Avoid ambiguous title matches unless `--first` or exact unique match.
    - Streaming commands should exit non-zero on failed turns.
    - Never expose bearer tokens in list commands unless explicitly using `--token-only` creation.

15. **Testing strategy**
    - Unit-test command parsing and selector resolution.
    - Unit-test model option parsing: `--reasoning`, `--thinking`, `--effort`, `--fast-mode`, generic `--option key=value`.
    - Add integration tests against in-process RPC/service layers for each command group.
    - Add golden tests for `--json` output shape.
    - Add smoke tests for: create project -> create chat -> send turn -> stream -> interrupt/stop -> export.

16. **Rollout order**
    - Milestone 1: RPC foundation + raw dispatch + list/show snapshots.
    - Milestone 2: project/chat lifecycle + model selection.
    - Milestone 3: send/stream/approvals/queued turns.
    - Milestone 4: diffs/checkpoints/export.
    - Milestone 5: providers/settings/keybindings.
    - Milestone 6: git/vcs/source-control/terminal.
    - Milestone 7: diagnostics + remote environments + polish.

Keep the CLI as a thin typed adapter over existing contracts; avoid duplicating orchestration logic in command handlers.
