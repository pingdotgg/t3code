# Hermes event compatibility inventory

The plugin deliberately uses only the public Hermes plugin and platform-adapter
surfaces audited at Hermes Agent commit
`3910ab28c0892fcf846fc61318d2fd15689eddf1`.

## Mapped in V1

| Hermes surface                            | T3 gateway event                               |
| ----------------------------------------- | ---------------------------------------------- |
| Cumulative `send` / `edit_message` output | `content.delta`                                |
| Final stream edit                         | `item.completed`, `turn.completed`             |
| `pre_tool_call` / `post_tool_call` hooks  | Typed `item.started` / `item.completed`        |
| Live adapter status text                  | Generic `unknown` activity item                |
| `send_exec_approval`                      | `request.opened` / `request.resolved`          |
| `send_clarify`                            | `user-input.requested` / `user-input.resolved` |
| `/steer` gateway command                  | `turn.steer`                                   |
| Adapter interrupt event                   | `turn.interrupt`                               |

## Known limitations

- The platform adapter receives cumulative rendered text, not the underlying
  token stream category. V1 maps it to `assistant_text`; Hermes reasoning,
  plan, and command-output stream categories are not publicly exposed here.
- The delta contract has no replacement operation. Rare edits that revise
  already-emitted text become a meaningful generic activity instead of
  corrupting the T3 transcript.
- Hermes' documented tool hook surface exposes a `task_id`, tool name,
  arguments, string result, and duration. The audited runtime additionally
  supplies `session_id` and `tool_call_id`; V1 uses them when present and falls
  back to the documented IDs for older versions. It projects only canonical,
  whitelisted fields (command/cwd, file path, search query, image path, or MCP
  server/operation); arbitrary arguments and raw results never cross the wire.
- Approval resolution is session-FIFO in Hermes. T3 request IDs identify the UI
  prompt, then resolve the oldest matching Hermes approval for that session.
- The public `clarify` hook is a single question. The wire protocol supports an
  array so richer structured input can be added without a protocol break.
- Hermes session completion has no dedicated platform-adapter callback. The
  plugin uses the stream consumer's required `finalize=True` edit as the
  authoritative completion boundary.
- Active `/steer` dispatch returns a textual Hermes control acknowledgement
  through the normal platform `send(..., notify=True)` path. The plugin
  captures that response in the originating steering request's async context,
  suppresses it from the transcript, and acknowledges T3 only when the audited
  Hermes success response begins with `⏩ Steer queued`. Unknown future response
  shapes fail closed with `protocol.error` rather than completing the turn.
- Attachments are not accepted. They are the first planned post-stability
  feature; the capability is reserved and fixed to `false` in protocol V1.
