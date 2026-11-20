# pstack on T3

The pstack skills contain the workflow and engineering rules. This adapter supplies the host mechanics for T3. It does not select a playbook or weaken a gate. T3 is the engine under Agent Board. Every tool named here is a T3 MCP tool, which Claude threads show as `mcp__t3-code__<tool>` and Codex threads show as `mcp__t3_code__<tool>`.

## Task surface

Start every child with `delegate_task`. Claude Code's built-in subagent tool, `Task` or `Agent`, is never used. T3 turns its calls into child threads that have no registry role, and an orchestrator instance has the tool switched off.

Each call carries `role`, `isolation`, `target`, `title`, and `task`.

- `role` is the registry role's T3 role, one of `implementation`, `research`, `review`, `design`, `test`, or `general`.
- `isolation` is `worktree` for a child that changes files, so two children never share a checkout, and `shared` for a child that only reads.
- `target` is the registry role's target, copied as written. A target without a `model` runs the child on the parent's model.
- `title` is `[<ticket key>] <registry role name>`, or `[board] <registry role name>` for a child that serves no ticket.
- `task` is the standalone brief. The child sees no parent history.

Omit `mode`, which defaults to `async`. Use `mode: "wait"` only when the current turn cannot go on without the result, and expect it to return after 45 seconds at most. Omit `runtimeMode` unless the user asks for a supervised child. T3 refuses a runtime mode broader than the parent's.

Put shared immutable material in each brief. A brief has no `context` field. Repeat the `Goal`, `Constraints`, and `Contract` headings in every child's `task`, so each brief stands alone. Never put a secret in `task`.

Do not invent Cursor fields such as `subagent_type`, `readonly`, `environment`, `run_in_background`, or `cloud_base_branch`. Model routing belongs to the registry's `target`. Call `orchestrator_capabilities` to see which providers and models an instance offers.

Reach the human only through `foryou.jsonl` in the board folder, and through `request_secret` for a token or password. Never end a turn with a question in chat. Never ask a question a probe, a source read, or a runtime check can settle.

## Role map

The board's role registry is authority. It lists 18 roles, each with a T3 role, an isolation, a target, and a read-only flag. With the standard registry, map pstack roles as follows.

| Pstack role         | Registry role       | Contract                                                        |
| ------------------- | ------------------- | --------------------------------------------------------------- |
| `explorer`          | `scout`             | Read-only reconnaissance and narrow evidence gathering.         |
| `watcher`           | `scout`             | Observe one exact generation or external transition, then stop. |
| `researcher`        | `scout`             | Source-verified external or repository research.                |
| `planner`           | `task`              | Technical decomposition and sequencing.                         |
| `designer`          | `task`              | Non-visual or product-design candidates.                        |
| `implementer`       | `task`              | Bounded implementation with explicit write scope.               |
| `owner`             | `task`              | Coupled multi-step implementation retained through follow-ups.  |
| `mechanical`        | `sonic`             | Fully specified low-judgment edits.                             |
| `reviewer`          | `reviewer`          | Independent code, protocol, behavioral, or quality review.      |
| `security reviewer` | `security-reviewer` | Independent read-only security review.                          |
| `synthesizer`       | `reviewer`          | Synthesis over frozen reports.                                  |

Use `poteto-agent` when the child must own a whole pstack workflow. It reads `$poteto-mode` first and selects the playbook. Use `comment-sicko` for read-only adversarial review of comments and documentation. Use the `thermo-nuclear-*` roles for branch audits and the `egm-*` roles for document review panels. Start a fresh `poteto-agent` for each new task and send it a follow-up only when the new work strictly needs state that lives in it.

A read-only role stays read-only only because its role file says so. T3 cannot limit a child's tools, so repeat the restriction in the brief.

## Brief contract

Every dispatch contains:

**Target**

Exact files, symbols, or external state.

**Change**

The bounded outcome and the one writer responsible for it.

**Acceptance**

Observable results, one per line.

Add `Verify`, `Forbidden`, and `Report` when the assignment is non-trivial. Every brief starts with the instruction to read the role's file and act as that role, as the host rules say. Tell every child not to call `delegate_task`, not to ask the user, not to edit outside its scope, and not to claim completion without running its assigned verification. Tell child workers to skip project-wide formatting, linting, and test suites. The root owns shared validation.

Name a skill in a brief as `$name` at the start of a word, for example `$no-comments`. T3 expands only that form, and only in a message it sends. A skill name inside backticks, or glued to other characters, stays plain text. Both Claude and Codex list the plugin's skills under the plugin's name, so the mention that expands is `$pstack-t3:<name>`, for example `$pstack-t3:no-comments`. The skill files themselves say `$no-comments`. Write the prefixed form in a message you send.

## Protocols

### Bounded session

1. Write one standalone brief.
2. Start one child with `delegate_task` and the mapped registry role.
3. Record its title, `taskId`, thread link, role, scope, and expected artifact.
4. Consume the result when T3 wakes you.
5. Read the child's thread with `t3_thread_read` only when the report is incomplete or suspicious.
6. Send one bounded follow-up with `t3_thread_send` only for an in-scope correction or the next coupled phase.
7. Inspect the artifact and run the promised verification from the root.

### Panel

1. Partition independent slices or race arms with one `delegate_task` call per participant.
2. Start every participant before consuming a result.
3. Track participants by title and `taskId`, never arrival order.
4. Wait only for required work, by ending your turn. Cancel stale work explicitly with `task_cancel`.
5. Freeze artifacts, reports, and generations before starting reviewers.
6. Start reviewers in a new set of calls against frozen evidence.
7. Treat synthesis as advice. The root selects and verifies.

### Long-lived owner

1. Start one `worktree` child with the complete owner brief: the `task` role, or `poteto-agent` when the owner runs a whole pstack workflow.
2. Keep its thread id and send only bounded follow-ups for the same unit with `t3_thread_send`.
3. Independently verify every boundary before authorizing the next phase.
4. Stand down on ownership violation, stale generation, or scope breach.

### One-shot watcher

1. Start one `scout` child.
2. Include the exact branch, generation, watched predicate, stop predicate, and timebox.
3. Require one meaningful event and a terminal report.
4. Discard a report whose generation no longer matches.
5. Start a fresh watcher for every new generation.

## Ownership and verification

One writer owns each branch, mutable state, and output path. Isolate concurrent writers with separate worktrees or disjoint paths before dispatch. Reviewers never modify the artifact they review. A worker report never verifies its own work. A new commit, restack, conflict resolution, or applied patch creates a new generation and voids a prior verdict. Prefer behavioral proof over type-check-only evidence.

Use T3's `preview_*` tools for web UI verification and direct terminal interaction for CLI or TUI verification. No Cursor `control-ui`, `control-cli`, cloud VM, or `/loop` command is assumed. For unattended progress, use a bounded watcher child or a scheduled task from **Job control** rather than a host-specific loop command.

## Job control

T3 wakes the parent when a child finishes or asks a question. Read the result after the wake. Use these tools.

| Need                                                        | Tool                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Block until a child finishes                                | End your turn. T3 wakes you. `delegate_task` with `mode: "wait"` blocks for 45 seconds at most, and `t3_thread_wait` waits on one thread's run. Use them only when the turn cannot go on without the result. |
| A child's status or final result                            | `task_status` with its `taskId`. Do not call it on a running task before the completion wakes you. Reading a finished result marks it delivered.                                                             |
| A child's transcript or an old thread                       | `t3_thread_read` with the thread id. View `messages` by default and `activity` for every item.                                                                                                               |
| Find threads                                                | `t3_thread_list`.                                                                                                                                                                                            |
| Follow-up, correction, or zero-writes hold order to a child | `t3_thread_send`. A send to a finished child starts a fresh task and returns its `taskId`.                                                                                                                   |
| Cancel stale work                                           | `task_cancel` with its `taskId`. `t3_thread_interrupt` stops a top-level thread's running turn.                                                                                                              |
| Keep the thread Working while a background shell job runs   | `t3_background_wait` with the job's task id, on Claude only.                                                                                                                                                 |
| Timed wake, such as an hourly audit tick                    | `schedule_task` with a `prompt` and a `schedule`. Check it with `list_scheduled_tasks` and remove it with `delete_scheduled_task` when the tick is no longer needed.                                         |

Never poll with `sleep` loops, `ps`, or log tailing. A scheduled task is one wake per tick, not a polling loop. In your reply, name a child or thread by the `link` the tool returned, verbatim.

## Model routing

Do not choose a model in a brief. The registry's `target` for each role sets it. `delegate_task` accepts any model in the instance's catalog, so claim model diversity only when the result's `model` and `executedModel` differ.

## Internal references

Skills reach you in two ways. You load a skill with Claude Code's Skill tool or by reading its file, and a message to a child expands one with `$name`.

- The pstack skills sit in one folder. On Claude it is `skills/` inside the `pstack-t3` plugin, under `plugins/` in the instance's Claude config folder. On Codex it is `~/.codex/skills/`. A plugin loaded from a development folder is in neither place. Call the Skill tool with `pstack-t3:pstack-t3` then, because it reports this skill's folder and every other pstack skill is a sibling folder of it.
- A playbook or reference is a file inside its skill, such as `poteto-mode/playbooks/feature.md`. Find the folder once, for example with `find -L ~/.claude/plugins ~/.codex/skills -maxdepth 8 -name playbooks -path '*poteto-mode*'`, then read the file from there. The `-L` is needed because Codex's skill folders are links. Use the instance's own Claude config folder in place of `~/.claude` when the instance has a separate home.
- `$poteto-mode` and this adapter are in your standing instructions. Every other skill loads on demand, so read a skill's SKILL.md in full before you apply it.
- Relative paths remain valid for files inside the same installed skill. This plugin's `agents/` files are role definitions. Agent Board copies each one into the board's `roles/` folder, and a child reads its role file there. Cursor plugin metadata and Cursor-only automation registration are not loaded.
