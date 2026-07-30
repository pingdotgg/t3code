# Hermes event compatibility inventory

The plugin deliberately uses only the public Hermes plugin and platform-adapter
surfaces audited at Hermes Agent upstream commit `62e07223` (v0.19.0).

Scope note: this file inventories **upstream Hermes** surfaces only. T3-side
machinery the plugin talks to over the wire — `withHermesConfig`, the broker's
generation fencing, `getOrCreateHomeThread` — is not a Python concern and is
documented on the T3 side; only the wire contract those produce appears here.

Audited surfaces, all present at that commit:

| Surface                                  | Location at 62e07223                 |
| ---------------------------------------- | ------------------------------------ |
| `save_env_value` / `get_env_path`        | `hermes_cli/config.py:8137` / `:688` |
| `load_config_readonly`                   | `hermes_cli/config.py:7415`          |
| `skills_list` (registered tool)          | `tools/skills_tool.py:785`           |
| `skill_view` (registered tool)           | `tools/skills_tool.py:961`           |
| `build_session_key`                      | `gateway/session.py:1029`            |
| `resolve_gateway_approval`               | `tools/approval.py:2073`             |
| `resolve_gateway_clarify`                | `tools/clarify_gateway.py:160`       |
| `register_platform` (`**entry_kwargs`)   | `hermes_cli/plugins.py:931`          |
| `_mark_notify_metadata` (`notify` flag)  | `gateway/platforms/base.py:89`       |
| Tool-hook `session_id` (= run id)        | `agent/tool_executor.py:188`         |
| Run-id generation                        | `gateway/session.py:2388`            |
| `HERMES_SESSION_KEY` binding             | `gateway/run.py:17367`               |
| `get_session_env` accessor               | `gateway/session_context.py:303`     |
| Tool-thread context propagation          | `agent/tool_executor.py:715`         |
| Final-delivery `notify` stamp            | `gateway/platforms/base.py:5220`     |
| Streaming final `notify` stamp           | `gateway/stream_consumer.py:328`     |
| `REQUIRES_EDIT_FINALIZE` declaration     | `gateway/platforms/base.py:3128`     |
| Progress-loop `finalize` injection       | `gateway/run.py:20777`               |
| Segment-break `finalize` (flag-agnostic) | `gateway/stream_consumer.py:938`     |
| Live tool-chrome delivery path           | `gateway/run.py:20485`               |
| `tool_progress` display resolution       | `gateway/display_config.py:187`      |
| `format_tool_event` (override hook)      | `gateway/platforms/base.py:2740`     |
| Tool-chrome dispatch (`None` == eat)     | `gateway/stream_dispatch.py:108`     |
| `/steer` active-run handler              | `gateway/run.py:11280`               |
| Home-channel notice text                 | `gateway/run.py:13780`               |
| Active-command inline dispatch           | `gateway/platforms/base.py:4926`     |
| User-plugin path `$HERMES_HOME/plugins/` | `hermes_cli/plugins.py:10`, `:1350`  |

Home-channel surfaces, added for protocol v3:

| Surface                                    | Location at 62e07223               |
| ------------------------------------------ | ---------------------------------- |
| `cron_deliver_env_var` registration flag   | `gateway/platform_registry.py:143` |
| `standalone_sender_fn` registration flag   | `gateway/platform_registry.py:159` |
| Standalone-sender invocation               | `tools/send_message_tool.py:741`   |
| `_home_target_env_var` fallback convention | `gateway/run.py:1541`              |
| `_resolve_home_env_var` (plugin lookup)    | `cron/scheduler.py:1025`           |
| `env_enablement_fn` `home_channel` promote | `gateway/config.py:2648`           |
| `HomeChannel` dataclass                    | `gateway/config.py:421`            |
| `get_home_channel`                         | `gateway/config.py:1022`           |
| `get_hermes_home` (queue/state base)       | `hermes_constants.py:106`          |
| `get_hermes_home` re-export                | `hermes_cli/config.py:686`         |
| Cron run-id shape (`cron_*`)               | `cron/scheduler.py:3017`, `:3484`  |
| Cron session-var clearing                  | `cron/scheduler.py:3066-3091`      |
| Cron `job_id` in routed metadata           | `cron/scheduler.py:1782`           |
| Cron metadata reaching `adapter.send`      | `gateway/delivery.py:606`          |
| Cron wrap header (`Cronjob Response: …`)   | `cron/scheduler.py:1513`           |
| Gateway online notice                      | `gateway/run.py:17277`             |
| Gateway restart notice                     | `gateway/run.py:17236`             |
| Gateway shutdown/restarting notice         | `gateway/run.py:6599`              |
| `/handoff` synthetic source identity       | `gateway/run.py:8854`              |
| `HERMES_SESSION_USER_ID` binding           | `gateway/run.py:17372`             |
| Session-context lifetime around a turn     | `gateway/run.py:12972` → `:14626`  |

This inventory describes gateway wire protocol v5. Protocol v2 added active-turn
recovery in `session.ready` and authoritative `content.snapshot` replacement; v3
added `role` on `connection.hello`, `homeThreadId` on `connection.accepted`, and
the `home.deliver` / `home.deliver.ack` pair; v4 adds media — optional inline
`attachments` on `turn.start` / `turn.steer`, the `media.deliver` /
`media.deliver.ack` pair, and the `attachments` capability flipping to the
literal `true`; v5 adds on-demand `models.list.request` /
`models.list.response`, requested model/reasoning fields on `turn.start`, and
verified applied selections on `turn.started`. Older server/plugin pairs are
rejected during the handshake — the version policy stays fail-closed.

## Mapped in the initial scope

| Hermes surface                                        | T3 gateway event                                  |
| ----------------------------------------------------- | ------------------------------------------------- |
| Cumulative `send` / `edit_message` output             | `content.delta` / `content.snapshot`              |
| Final stream edit                                     | `item.completed`, `turn.completed`                |
| `pre_tool_call` / `post_tool_call` hooks              | Typed `item.started` / `item.completed`           |
| Live adapter status text                              | `status_text` activity item                       |
| `load_config_readonly()["model"]["default"]`          | Optional `model` on `connection.hello`            |
| `send_exec_approval`                                  | `request.opened` / `request.resolved`             |
| `send_clarify`                                        | `user-input.requested` / `user-input.resolved`    |
| `/steer` gateway command                              | `turn.steer`                                      |
| Adapter interrupt event                               | `turn.interrupt`                                  |
| `load_config_readonly()["agent"]["reasoning_effort"]` | Optional `reasoningEffort` on `describe.response` |
| `inventory.build_models_payload(...)`                 | `models.list.response` on explicit request        |
| Session-scoped `/model` and `/reasoning` commands     | v5 `turn.start` selection fields                  |
| `skills_list()` metadata                              | `skills` on `describe.response`                   |
| `skill_view(name, preprocess=False)`                  | `markdown` on `skill.body.response`               |
| Cron `deliver=t3`, `send_message t3`, lifecycle       | `home.deliver` / `home.deliver.ack`               |

## Known limitations

- The platform adapter receives cumulative rendered text, not the underlying
  token stream category. The current adapter maps it to `assistant_text`; Hermes reasoning,
  plan, and command-output stream categories are not publicly exposed here.
- Prefix-extending cumulative edits emit `content.delta`; edits that revise or
  clear already-emitted text emit an authoritative `content.snapshot`.
- Hermes' exact first-chat T3 home-channel notice is suppressed at the adapter
  output boundary. The plugin does not assign a home channel or redirect
  proactive delivery; other Hermes platform notices pass through unchanged.
  This match is **exact string equality**, which is fragile: Hermes builds the
  notice inline from an f-string (`gateway/run.py:13780`) rather than exporting
  a constant, so any wording change upstream silently stops the suppression and
  the notice reaches the transcript. Re-verified byte-for-byte at 62e07223 by
  reconstructing the f-string with `platform_name="t3"` (`Platform("t3").value`
  → `"t3"`, `.title()` → `"T3"`) and the non-Slack `/sethome` branch; it still
  matches. A regression test pins the literal.
- Hermes' documented tool hook surface exposes a `task_id`, tool name,
  arguments, string result, and duration. Verified at 62e07223: the runtime
  additionally supplies `session_id`, `tool_call_id`, `turn_id`,
  `api_request_id`, and `middleware_trace` on both hooks
  (`hermes_cli/plugins.py:2146` for `pre_tool_call`, `model_tools.py:1050` for
  `post_tool_call`), and `post_tool_call` also supplies `status`, `error_type`,
  and `error_message`. The adapter consumes `session_id`, `tool_call_id`, and
  `status` when present and falls back to the documented IDs for older
  versions. It projects only canonical, whitelisted fields (command/cwd, file
  path, search query, image path, or MCP server/operation); arbitrary arguments
  and raw results never cross the wire.
- `post_tool_call` passes `result` as `Any`, not a guaranteed `str` — the
  adapter never forwards it, so the looser type is inert here.
- **The tool hooks' `session_id` is not this plugin's session id.** Hermes
  passes `agent.session_id` (`agent/tool_executor.py:188`, `:305`, `:341`),
  which the gateway sets from `SessionEntry.session_id` — a timestamped run id
  like `20260725_143012_ab12cd34` (`gateway/session.py:2388`,
  `agent/agent_init.py:1446-1453`). This plugin's session ids come from
  `build_session_key` (`gateway/session.py:1029`) and are shaped
  `agent:main:t3:dm:<thread>`. The two namespaces never intersect, so keying
  the thread lookup on the hook's value alone matched nothing and silently
  dropped every tool activity item. This is the same class of defect as the
  `finalize` bug — keying behaviour off a Hermes-supplied value whose meaning
  was assumed rather than verified. `_turn_for_tool_hook` now resolves in three
  steps: the raw `session_id` as a routing key (free, and correct if upstream
  ever passes the gateway key here), then `HERMES_SESSION_KEY` from Hermes'
  session context (`gateway/run.py:17367` →
  `gateway/session_context.py:200`, read via `get_session_env` at `:303`),
  which IS the `build_session_key` value and is propagated into the tool worker
  threads by `propagate_context_to_thread` (`agent/tool_executor.py:715`), then
  the sole active turn when exactly one exists. With two or more concurrent
  turns and no routing key it emits nothing rather than misattributing activity
  to the wrong thread. Every step is best-effort and cannot raise: tool
  activity is decorative and must never break a turn.

  Regression shape if upstream changes: if `HERMES_SESSION_KEY` stops being
  bound or stops propagating into tool threads, a **multi-thread** Hermes loses
  tool activity rows (single-thread still works via the sole-turn fallback).
  Turn lifecycle is unaffected either way — tool items are decorative.

- Approval resolution is session-FIFO in Hermes. T3 request IDs identify the UI
  prompt, then resolve the oldest matching Hermes approval for that session.
- The public `clarify` hook is a single question. The wire protocol supports an
  array so richer structured input can be added without a protocol break.
- Hermes session completion has no dedicated platform-adapter callback. The
  plugin uses `notify=True` metadata on `send` as the authoritative completion
  boundary (`_mark_notify_metadata`, `gateway/platforms/base.py:89`). It
  explicitly does **not** use `finalize=True` on `edit_message`, which upstream
  sets on every mid-turn tool-progress edit and every stream segment break —
  see "Turn completion is keyed off `notify`, never `finalize`" below.
- Active `/steer` dispatch returns a textual Hermes control acknowledgement
  through the normal platform `send(..., notify=True)` path
  (`gateway/platforms/base.py:4926`). The plugin captures that response in the
  originating steering request's async context and suppresses it from the
  transcript. Because a steer targets a _running_ turn, the capture is
  correlated by the steering `requestId` — which the base adapter passes back
  as `reply_to` via `_reply_anchor_for_event` — and not by `chat_id`. Genuine
  assistant output emitted on the same thread during the steer window carries a
  different correlation id and reaches the transcript untouched.
- The plugin acknowledges T3 only when the audited Hermes success response
  begins with `⏩ Steer queued`. That prefix is likewise matched against an
  inline f-string (`gateway/run.py:11280`) rather than an exported constant, so
  it carries the same drift risk as the home-channel notice. Confirmed present
  at 62e07223. Unknown future response shapes fail closed with `protocol.error`
  rather than completing the turn.
- Hermes' configured default model is read once per handshake from the
  documented read-only accessor `load_config_readonly()["model"]["default"]`.
  That accessor returns the shared process-wide config cache and its docstring
  forbids mutation, so the plugin copies out only a trimmed string. Any failure
  — missing key, import error, older Hermes — omits the optional `model` field
  from `connection.hello` rather than sending null or empty. On an explicit
  `models.list.request`, the plugin also calls `load_picker_context()` and
  `build_models_payload()` off the event loop, requesting only explicitly
  configured providers and no refresh or custom-provider probes. Inventory
  failures return an empty model list while preserving the readable current
  selection.
- Hermes' configured reasoning effort is read from
  `load_config_readonly()["agent"]["reasoning_effort"]` on every
  `describe.request`, with the same discipline as the model read above: a
  trimmed string copy, no mutation of the shared cache, and any failure omits
  the optional `reasoningEffort` field rather than sending null or empty. Note
  this is the _global_ effort. Hermes also supports
  `agent.reasoning_overrides` (per-model) and `delegation.reasoning_effort`
  (subagents); neither is resolved here, so a user with a per-model override
  active sees the global value on the Agent page.
- A v5 `turn.start` may request a default or specific model plus one of
  `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`.
  Before registering the turn, the adapter dispatches synthetic command
  events directly to Hermes' registered runner handler: `/model ... --session`
  first, then `/reasoning ...`. Control acknowledgements are discarded rather
  than entering the transcript, and the runner's effective session overrides
  are verified before `turn.started` is emitted. A model failure prevents the
  reasoning command and the user message from running. Repeated selections
  are cached per T3 thread but skipped only while the runner's live override
  still matches; no global config is written.
- Skills are enumerated through the registered `skills_list()` tool surface
  (`tools/skills_tool.py:785`), not the private `_find_all_skills()` scanner
  behind it. Consequences of that choice, all verified at 62e07223:
  - `skills_list()` already applies Hermes' disabled-skill, platform, and
    environment filters, so **disabled skills are absent from the list rather
    than reported with `enabled: false`**. The wire field is always `true`.
    Reporting disabled skills would require `_find_all_skills(skip_disabled=True)`
    plus `hermes_cli.skills_config.get_disabled_skills()` — a private scanner
    and a config-mutating module — so T3 shows what this Hermes would actually
    load, not the full on-disk inventory.
  - The surface publishes only `name`, `description`, and `category`. There is
    **no path or install-source field**: `category` is the nearest published
    analogue and is sent as `source`. The real on-disk path is available only
    from `skill_view()` per skill, so it is not eagerly fetched.
  - The list reflects `~/.hermes/skills/` plus configured `skills.external_dirs`,
    and is served from a 30s in-process cache keyed on a directory-mtime and
    disabled-set signature. A skill added seconds before a `describe.request`
    may be one refresh late.
  - MCP servers are not reported at all. Hermes has no public enumeration
    surface for them at this commit, and the T3 contract omits the field in v1.
- Skill bodies are read with `skill_view(name, preprocess=False)`. Preprocessing
  is disabled deliberately: T3 renders the skill for a human to read, so the
  literal authored markdown is wanted rather than Hermes' template and
  inline-shell rendering of it — the latter executes shell fragments embedded in
  the skill, which must not happen merely because a user expanded a row. Bodies
  are truncated at 512 KiB. Any failure — unknown name, ambiguous name across
  `external_dirs`, unreadable file, older Hermes — replies with `markdown: null`
  rather than an error, so the UI renders "no body available" instead of a
  protocol failure. The plugin calls `skill_view` directly rather than the
  registered `_skill_view_with_bump` handler, so a T3 body fetch does **not**
  bump that skill's view/use counters (`tools/skill_usage.py`) — browsing an
  agent's skills in T3 must not look like the agent loading one, since
  `last_used_at` is what Hermes' curator keys its stale-skill timer off.
- Neither describe frame can fail the connection over a _Hermes_ problem.
  Every Hermes-sourced read degrades — omitted optional field, empty skill
  list, or null markdown — so a `describe.request` against an older or
  partially-broken Hermes yields a thinner reply, never a `protocol.error`.
  The one exception is a malformed request: `skill.body.request` with no
  `skillName` cannot be answered, because the response echoes the name back
  and the wire type is non-empty. That takes the ordinary correlated
  `protocol.error` path.
- Attachments have been part of the protocol since v4; the capability is fixed
  to `true`
  (T3's schema pins the literal, so a plugin that cannot handle them is a v3
  plugin and is rejected at the version gate). Inbound, `turn.start` /
  `turn.steer` may carry inline base64 files (≤25MB each): turn-start files
  are written to private temp files and ride `MessageEvent.media_urls` /
  `media_types` into Hermes' own enrichment pipeline; steer files are
  appended to the injected `/steer` text as path notes, because Hermes'
  steer handler injects only text between tool iterations
  (`gateway/run.py:11254`). Outbound, the adapter overrides
  `send_image_file` / `send_video` / `send_voice` / `send_document` to emit
  `media.deliver` frames (raw bytes ≤25MB, base64 on the wire) with the same
  durable queue-then-ack lifecycle as `home.deliver`; the
  `standalone_sender_fn` sends `media_files` the same way, and
  `force_document` remains signature parity only — T3 derives rendering from
  `mimeType`, so there is no document/photo distinction to force.
- **Kind/label classification is heuristic.** `adapter.send()` carries no
  structured "this is a cron delivery" marker on every path, so the plugin
  reads what does exist (see "Home-channel delivery" below). A
  misclassification costs a wrong badge — and, for `lifecycle`, a delivery that
  raises its hand when it should have landed quietly — never a lost delivery.
  If upstream ever exposes delivery provenance in metadata, adopt it and
  replace the heuristics here.

## Turn completion is keyed off `notify`, never `finalize`

**A previous revision of this document blamed `format_tool_event` for the
early-turn-truncation bug. That diagnosis was wrong.** It is corrected here;
the real cause and the real completion signal are documented below.

### The signal that ends a turn: `notify=True` on `send`

`_mark_notify_metadata` (`gateway/platforms/base.py:89`) stamps `notify: True`
onto the metadata of a send, and the gateway applies it **only** for genuine
user-visible replies:

- the final response delivery (`gateway/platforms/base.py:5220`, consumed at
  `:5261`, `:5330`, `:5376`, `:5418`, `:5433`-`:5469`),
- slash-command acknowledgements (`:4827`, `:4934`, `:4987`),
- and, in the streaming path, `StreamConsumer._metadata_for_send(final=True)`
  (`gateway/stream_consumer.py:328-329`).

`send(..., metadata={"notify": True})` is therefore the plugin's completion
boundary, and `_complete_turn` is reached from nowhere else on the output path.

### The signal that does NOT end a turn: `finalize=True` on `edit_message`

`finalize` reads like "last edit of the response", and the base class documents
it that way (`gateway/platforms/base.py:3176-3183`). It is **not** a turn
boundary. Two upstream paths set it mid-turn:

1. **The tool-progress loop.** When an adapter declares
   `REQUIRES_EDIT_FINALIZE`, `_edit_progress_message` passes `finalize=True` on
   **every** progress-bubble edit (`gateway/run.py:20777-20780`) — once per tool
   event, for the whole turn. Nothing about that edit is final.
2. **The stream consumer's segment breaks.** `_send_or_edit` is called with
   `finalize=(got_done or got_segment_break)`
   (`gateway/stream_consumer.py:938-940`), so every mid-turn tool/segment
   boundary finalizes the current content message. This path is
   **independent of `REQUIRES_EDIT_FINALIZE`** — setting the flag to `False`
   does not suppress it.

This plugin previously declared `REQUIRES_EDIT_FINALIZE = True` and treated
`finalize=True` in `edit_message` as "turn finished", calling `_complete_turn`.
Consequently the **first tool call ended the T3 turn while Hermes was still
working**: the transcript kept the progress chrome ("📚 Reading skill
hermes-agent 🔍 Searching the web for …") as the assistant's entire answer, and
every subsequent send failed with `Send failed: no active T3 turn — trying
plain-text fallback` in the gateway log. The real answer never arrived.

The fix is twofold, and both halves are needed because of path (2) above:

- `REQUIRES_EDIT_FINALIZE = False` — declaring it only arms path (1). T3 closes
  an item on `item.completed`, which this plugin emits itself; it has no
  rich-card streaming state that needs an explicit close.
- `edit_message` ignores `finalize` outright (`del metadata, finalize`) and
  never calls `_complete_turn` — this is what defends against path (2).

`test_tool_progress_bubble_edits_never_complete_the_turn` pins both legs:
it replays the gateway's `_edit_progress_message` closure verbatim and a
segment-break finalize, asserts the turn survives every one, then asserts a
single `notify=True` send completes it exactly once.

**Regression shape if upstream changes.** If a future Hermes makes `finalize`
genuinely mean "turn over" and removes the mid-turn uses, this plugin will
simply never see a completion via that route — harmless, since `notify` still
fires. The dangerous direction is the inverse: if `_mark_notify_metadata` stops
being applied to the final delivery (or the streaming path stops calling
`_metadata_for_send(final=True)`), turns would **never complete** — T3 threads
would hang in the running state with the full answer streamed but no
`turn.completed`. That is the opposite failure mode from the original bug and
would show up as spinners that never resolve, not truncated answers.

## Home-channel delivery: the gate is provenance, not turn absence

Hermes-initiated output — cron results, `send_message` with a bare `t3` target,
gateway lifecycle notices, `/handoff t3` — has no T3-issued turn to stream into.
It is emitted as `home.deliver` against the instance's durable home thread.

### The deadlock this design exists to avoid

The naive rule — "no active turn for this thread → deliver" — is wrong, and
wrong in the same keyed-off-the-wrong-signal way as the `finalize` bug above.
When the home thread itself has a live user turn, a cron delivery targeting it
would fall into the active-turn path, stream as that turn's assistant content,
and — because final cron deliveries arrive notify-stamped via
`_mark_notify_metadata` (`gateway/platforms/base.py:89`) — **complete the user's
live turn with the cron output as its answer**.

The discriminator is `HERMES_SESSION_KEY`. The gateway binds it onto the turn's
context for the whole handler (`gateway/run.py:12972` → `:14626`, read via
`get_session_env`), and every send a turn produces — streamed or final — happens
inside that scope, so a genuine turn reply resolves to this plugin's
`build_session_key` id for its thread. Cron runs under its own
`cron_<job>_<timestamp>` session with the gateway routing keys explicitly
cleared (`cron/scheduler.py:3066-3091`), and lifecycle broadcasts run in no
session at all.

`_is_proactive_delivery` therefore decides in this order:

1. Session key matches an active turn on this thread → **turn content**, never
   a delivery. Checked first, so a turn reply can never be rerouted.
2. Not the home thread → never a delivery. "Message any thread unprompted"
   stays out of scope and the existing `"no active T3 turn"` error is returned
   verbatim.
3. Home thread, no active turn → delivery. There is nothing it could belong to.
4. Home thread **with** a non-matching active turn → delivery only when
   provenance is positively established. This is the conservative half: an
   unattributable send in that window stays with the turn (at worst misplaced
   inside the same thread) rather than being torn out of a turn it may belong
   to. So an unclassifiable send can never steal a live answer, and a
   recognisable cron/lifecycle/handoff delivery never completes one.

Ordering inside `send()` is load-bearing: `_capture_steer_control_response`
stays first, because steer acknowledgements arrive with `notify=True` and must
never be read as deliveries.

`edit_message` has **no** proactive branch and keeps returning `"no active T3
turn"` outside a turn. A delivery is an atomic document, not a streaming
surface. If an upstream path ever streams a home delivery, revisit with a
`home.deliver`-supersedes-by-`deliveryId` scheme rather than edit frames.

### What classification keys off

All best-effort, in precedence order, all degrading to
`("message", "Hermes", uncertain)`:

- `metadata["job_id"]` — the only structured signal. The cron scheduler stamps
  it into the routed metadata (`cron/scheduler.py:1782`) and
  `DeliveryRouter._deliver_to_platform` passes the dict through to
  `adapter.send` unchanged (`gateway/delivery.py:606`).
- The cron wrap header `Cronjob Response: <name>` (`cron/scheduler.py:1513`),
  present whenever `cron.wrap_response` is on (the default), which also
  supplies the human job name for the badge.
- Lifecycle literals: `gateway/run.py:17277`, `:17236`, `:6599`. These are
  inline f-strings upstream, not exported constants, so they carry the same
  drift risk as the `/sethome` notice and the `⏩ Steer queued` prefix.
- `HERMES_SESSION_USER_ID == "system:handoff"`, the synthetic source identity
  `/handoff` dispatches under (`gateway/run.py:8854`, bound at `:17372`).

### Registration contracts

- **`cron_deliver_env_var="T3_HOME_CHANNEL"`.** The name is not free-form.
  `_home_target_env_var` (`gateway/run.py:1541`) consults built-ins, then the
  plugin registry via `_resolve_home_env_var` (`cron/scheduler.py:1025`), then
  falls back to `f"{PLATFORM.upper()}_HOME_CHANNEL"` — exactly this string for
  platform `t3`. Matching the fallback means `send_message`'s error hints and
  cron's env-only resolution agree with what the plugin writes, with no
  upstream override-table entry. Without the flag, `deliver=t3` is silently
  dropped by cron.
- **`env_enablement_fn` seeds `home_channel`.** That key is magic: core pops it
  out of the returned dict and promotes it to a real `HomeChannel` dataclass
  (`gateway/config.py:2648-2660`, reading only `chat_id` / `name` /
  `thread_id`). The promotion is what makes `get_home_channel("t3")`
  (`gateway/config.py:1022`) resolve, which is what makes `send_message`,
  lifecycle broadcasts, and `/handoff` work — core hardcodes env promotion only
  for built-ins. T3 threads are the addressing unit, so `chat_id` **is** the
  thread id and `thread_id` stays unset.
- **`standalone_sender_fn`.** Out-of-process cron has no live adapter
  (`tools/send_message_tool.py:741`). The plugin dials T3 itself over a
  short-lived socket announcing `role: "delivery"`. That role is load-bearing:
  T3's broker registers a `gateway` connection under generation fencing and
  displaces its predecessor, so a cron dial-in announcing the default role
  would kick the live gateway socket off its own instance mid-turn.

### Designation is a synced cache, not local state

`T3_HOME_CHANNEL` is written by the plugin, never by the user. T3's settings
blob is authoritative and republishes `homeThreadId` on every
`connection.accepted`; the plugin compares and persists via `save_env_value`
(the same profile-aware helper enrollment uses) and mirrors into `os.environ`
so a running gateway needs no restart. A hand-edited value is overwritten on
the next reconnect — documented in the README. A read-only or managed `.env`
degrades to the in-process mirror only: routing works for the life of the
process and re-reconciles on the next connect.

### Queue and state location

The plugin previously persisted nothing to disk. It now keeps one JSONL outbox
at `<hermes home>/gateway/t3_home_delivery_queue.jsonl`, using
`get_hermes_home()` (`hermes_constants.py:106`, re-exported at
`hermes_cli/config.py:686`) as the base — the same accessor and the same
`gateway/` subdirectory Hermes' own Discord adapter uses for per-profile
adapter state (`plugins/platforms/discord/adapter.py:52`, `:272`, `:1694`).
Resolving through that accessor rather than `~/.hermes` makes the queue
profile-scoped: a second profile cannot replay another profile's deliveries
into its own home thread.

Correctness rests on one rule: an entry is removed **only** on its
`home.deliver.ack`. Everything else — a socket that dropped mid-send, a server
that died before writing, a plugin restart — leaves the entry to be replayed,
which is safe because T3 dedupes on `deliveryId`. Acking before the durable
write on the server side would break this. The queue is capped at 300 entries
and drops oldest-first with a logged warning; one flush replays at most 50
entries so a reconnect does not stall live traffic.

### Cron tool-hook misattribution

`_turn_for_tool_hook`'s sole-active-turn fallback is now skipped for cron runs.
The hooks are process-global, so a cron job running tools while exactly one T3
turn happens to be live would resolve through that fallback and paint the cron
job's tool calls into an unrelated live conversation. Cron runs are identifiable
by the `cron_<job>_<timestamp>` session id the scheduler mints
(`cron/scheduler.py:3017`, passed to the agent at `:3484`) — the exact value the
hooks receive. Upstream treats the same routing hazard as real, clearing the
process-global session env vars for it (`cron/scheduler.py:3066-3091`). A cron
job's activity belongs to the eventual `home.deliver`, never to a live turn.

Prefix matching carries the usual drift risk: if upstream renames the shape,
this degrades to the previous behaviour (cron tool rows may again be
misattributed to a sole live turn) rather than breaking anything.

## Tool-progress chrome: the `format_tool_event` override is not the defence

The plugin overrides `format_tool_event` to return `None`
(`gateway/platforms/base.py:2740`), which `gateway/stream_dispatch.py:108`
documents as "adapter chose to eat this event". T3 already renders tool calls as
typed `item.started` / `item.completed` activity from the `pre_tool_call` /
`post_tool_call` hooks, so the text line is a strictly poorer duplicate.

**At 62e07223 this hook is dead code on the live path.** Its only caller is
`GatewayEventDispatcher` (`gateway/stream_dispatch.py:40`, dispatch at `:108`),
and that class is referenced nowhere in the shipped gateway — only from
`tests/gateway/test_stream_events.py`. The path that actually runs is
`gateway/run.py:20485+`, which builds the same emoji lines itself and delivers
them via `adapter.send` / `adapter.edit_message`, with **no adapter hook to
suppress them**. Chrome visibility there is governed by the platform's
`tool_progress` display setting (`gateway/display_config.py:187`), not by this
override.

The override is kept as documented-contract defence: it costs nothing and
becomes load-bearing again if upstream routes chrome through the dispatcher. But
it never protected the turn — ignoring `finalize` does.
