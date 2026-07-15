# Advisor mode

Advisor is a consultative thread mode: the agent reads the workspace, answers
questions, explains how things work, reviews code and designs, weighs tradeoffs
and recommends a course of action — and cannot change anything while it does so.

It is the third value on the interaction axis (`default | plan | advisor`); see
[runtime-modes.md](./runtime-modes.md) for how that axis relates to permissions.

## Advisor vs. plan

They look similar and are easy to conflate, so the distinction is worth stating
plainly.

|             | Plan                                                  | Advisor                                       |
| ----------- | ----------------------------------------------------- | --------------------------------------------- |
| Goal        | A decision-complete spec another agent can implement  | An answer to the question you asked           |
| Output      | A `<proposed_plan>` artifact, rendered as a plan card | An ordinary chat reply                        |
| Ends when   | You accept the plan and implement it                  | You stop asking                               |
| Enforcement | Prompt-level only — the sandbox is unchanged          | Sandbox/permission-level — writes are blocked |

Plan mode is a phase of doing the work. Advisor is a different activity: you are
consulting the agent, not dispatching it. The practical tell is that plan mode
drives toward an artifact, and advisor never produces one.

## Enforcement

Advisor does not trust the model to honour a prompt. `resolveEffectiveRuntimeMode`
(`packages/contracts/src/orchestration.ts`) clamps the permission axis:

```
advisor + any RuntimeMode  ->  approval-required
```

`ProviderCommandReactor.ensureSessionForThread` starts the provider session with
that effective mode, so an advisor thread runs under whatever the driver already
considers its strictest policy. Nothing new had to be built per provider, and a
driver that has never heard of advisor still cannot mutate unattended — it will
at worst raise an approval the user has to answer. Advisor **fails closed**.

Three invariants fall out of this, each covered by a test:

- The thread keeps the user's stored `runtimeMode`; only the session is clamped.
  Leaving advisor restores what they picked.
- The restart-on-change check compares the _effective_ mode against the session's
  mode. Comparing the thread's raw mode instead would make every advisor turn
  look like a permission change and restart the session each time.
- **Sub-agents inherit the clamped mode, not the stored one.** Because an advisor
  thread still stores e.g. `full-access`, a child spawned with `parent.runtimeMode`
  would run with write access — delegation would be an escape hatch out of a mode
  the user believes is read-only. `SubAgentCoordinator` therefore resolves the
  effective mode before creating the child.

## Per-provider behaviour

Enforcement is uniform (the clamp). Steering — getting the model to _act_ like an
advisor rather than merely being unable to write — is per-driver and best-effort.

| Driver                          | Write blocking (from the clamp)                | Advisor steering                                                                         |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Codex, Fugu                     | `read-only` OS sandbox — a real one            | `CODEX_ADVISOR_MODE_DEVELOPER_INSTRUCTIONS`, sent on the `plan` wire mode                |
| Claude, Claudex, ClaudeSynthero | SDK `plan` permission mode + `canUseTool` gate | `ExitPlanMode` is denied and the plan artifact suppressed, steering it back to answering |
| OpenCode                        | Ask-everything permission ruleset              | Runs the read-only `plan` agent                                                          |
| Cursor (ACP)                    | Per-tool permission requests                   | Switches to the `plan`/`architect` ACP mode                                              |
| Grok (ACP)                      | Per-tool permission requests                   | **None** — Grok ignores interaction mode entirely                                        |
| ChatGptBrowser                  | n/a (no tools)                                 | None                                                                                     |

Codex only accepts `plan | default` as a collaboration mode on the wire, so
advisor borrows the `plan` kind: it is the non-default kind that keeps
`request_user_input` available and `update_plan` disabled, which is what a
consultative mode wants. The advisor developer instructions — which forbid the
`<proposed_plan>` block — are what actually separate the two.

Grok is the weak spot. It gets the permission clamp, so it cannot write without
asking, but it will not _behave_ like an advisor: expect it to try to make edits
and surface approval prompts instead of answering. Wiring Grok's ACP mode aliases
is the obvious follow-up.

## Backend events and permissions

**No new events, commands or schemas were required.** This is the main finding of
the spike, and it is why the change is small.

Advisor reuses the interaction-mode plumbing that plan already uses end to end:

- Command: `thread.interaction-mode.set` (`ThreadInteractionModeSetCommand`)
- Event: `thread.interaction-mode-set`
- Carried on every turn by `thread.turn-start-requested`
- Projected onto `OrchestrationThread.interactionMode` and the thread shell
- Persisted in `projection_threads.interaction_mode`, a `TEXT` column with no
  `CHECK` constraint — so **no migration is needed** for the new value

The only contract change is widening the `ProviderInteractionMode` literal union.
Permissions are likewise unchanged: advisor composes the existing `RuntimeMode`
values rather than introducing a new permission level.

Old clients are forward-compatible in the safe direction: a client that does not
know `advisor` still sends `default` or `plan` and behaves as before. A server
older than this change would reject an `advisor` turn at schema decode rather
than silently running it with write access.

## Native control surface (macOS)

The composer's mode capsule now holds two `Menu`s instead of a menu and a toggle:

- **Runtime mode** (`RuntimeModeMenu`) — unchanged options, but the label now
  shows the mode _actually in force_. Under advisor it reads "Approvals required"
  with a section header explaining why, while the checkmark stays on the user's
  stored choice. The control does not claim full access while advisor is on.
- **Interaction mode** (`InteractionModeMenu`) — Default / Plan / Advisor, each
  with an SF Symbol and a tooltip.
- **`/advisor`** joins `/plan` and `/default` as a built-in slash command.

The one-tap plan toggle became a menu item. That is a deliberate tradeoff: three
modes do not fit a boolean toggle, and a menu labelled with the current mode is
more legible than an accented icon you have to decode. `/plan` still gives
one-keystroke access for anyone who used the toggle reflexively.

Native affordances considered and **not** used, in rough order of appeal:

- A `Menu(primaryAction:)` split button, so clicking still toggles plan while the
  chevron reveals all three modes. Preserves the old muscle memory. Worth
  revisiting if the plan toggle is missed.
- Menu-bar commands (`CommandMenu`) with `⌘1/⌘2/⌘3` for the three modes. The app
  currently has almost no custom menu-bar surface, so this would be the first.
- Advisor threads reading visually distinct in the sidebar (a tint or glyph),
  which is where this brushes up against SER-84's thread ordering work.

## Known gaps

- **Grok does not steer** (above). It is safe, not useful.
- **Sub-agents of an advisor thread are permission-clamped but are not themselves
  advisors.** They inherit the effective (`approval-required`) runtime mode, so
  they cannot write unattended, but `SubAgentCoordinator` always spawns children
  with `interactionMode: "default"`. A child will therefore try to _do_ the work
  and raise approvals, rather than advising. Propagating the parent's interaction
  mode is the natural follow-up.
- **Entering advisor does not restart a live session eagerly.** The clamp is
  applied at the next `ensureSessionForThread`, i.e. before the next turn is
  sent. A session sitting idle in `full-access` stays that way until the user
  actually sends an advisor turn, at which point it restarts read-only. No turn
  ever runs unclamped; only the idle session lags.
- **Claude's advisor steering leans on denying `ExitPlanMode`.** If a future SDK
  stops routing plan exits through `canUseTool`, advisor would start emitting
  plan cards again. The write-blocking is unaffected either way.
