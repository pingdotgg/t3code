# Context handoffs

Portable provider and fork handoffs carry a budgeted selection of intact historical messages,
not provider-native session state. The [shared budget selector](../../packages/provider-core/src/server/handoffBudget.ts)
keeps complete items or omits them; it does not shorten each message to a 240-character prefix.
See [Context in portable handoffs](../user/portable-handoffs.md) for the user-visible limits.

`ContextHandoffServiceV2` stores selected messages and coverage references in `history`.
[Delivery](../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts) budgets them again against
the target's available context, then injects them natively when supported or renders attributed
conversation context. Omitted history remains retrievable through `t3_thread_read`. Native tool
state, reasoning, approvals, and attachments are not replayed.

Provider handoffs cover the full eligible app history or the delta since that provider last
participated. Fork merge-back selects from the child's delta. `compactText` still produces short
summaries for fork-delta fallback text and side-chat activity; those summaries do not define the
message budget for portable handoffs.

Legacy v1 continuation also prepares structured history through the shared selector. Its separate
32,000-character recovery excerpt remains in `summaryText`; delivery uses that text only for older
handoff records without structured `history`. Do not treat that excerpt limit as the portable
handoff budget.
