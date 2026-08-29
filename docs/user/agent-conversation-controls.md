# Agent conversation controls

Agents connected through T3 Code's built-in MCP server can inspect and change an existing conversation's provider settings. These controls use the same durable thread state as the web, desktop, and mobile clients.

`t3_thread_configuration` returns the selected provider instance, model, model options, runtime mode, and interaction mode. It also lists the models and option values currently advertised by configured providers. When `threadId` is omitted, the tool reads the agent's current conversation.

`t3_thread_configure` changes one or more of those settings. Omitted fields keep their current values, except that changing the provider while omitting `model` selects that provider's default or first advertised model. Passing an empty `options` array clears model options. A provider change does not copy options from the previous provider or model.

Queued runs keep the model selection captured when they were created, but resolve runtime and interaction modes from the thread settings when they execute. A provider, model, or runtime change can request immediate provider-session detachment when the adapter cannot apply it in session; detaching a shared session can interrupt active provider work. The result lists the active and queued run IDs observed after the commands commit.

Some providers can use the new selection on the next turn without detaching. Others require a provider-session detach, or a cross-provider context handoff that is planned when the next turn starts. The tool reports the committed command separately from requested detach effects and required next-turn handoff work; it does not claim that a replacement session or handoff already completed.

An agent cannot use these tools to grant itself broader access. The calling conversation's runtime and interaction modes set the ceiling for every target conversation. A plan-mode caller cannot switch a target to default interaction mode, and an approval-required caller cannot select a broader runtime mode.

Targets must belong to the calling conversation's project. Use `clientRequestId` for a mutation that may be retried. T3 Code derives stable V2 command IDs from it and records a receipt even when the requested setting is already selected, so a later retry cannot turn that accepted no-op into a new change. Results normally identify their settings and run IDs as a post-dispatch observation. If the final read is unavailable, the result explicitly labels them as a pre-dispatch fallback instead of presenting requested values as current state.
