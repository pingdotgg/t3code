---
"effect": patch
---

Bound cluster runner entity residency and storage reads.

`ShardingConfig` gains two knobs:

- `maxResidentEntities` (default `10_000`): the maximum number of entities
  that can be resident on a runner at the same time. At the cap, the storage
  read loop stops admitting messages for new entity addresses (they stay in
  storage until a slot frees up) and volatile sends to new addresses fail with
  `MailboxFull`. Persisted sends still succeed. `"unbounded"` restores the
  previous behaviour and can only be set programmatically.
- `unprocessedMessageBatchSize` (default `1024`): the maximum number of
  unprocessed messages read from storage in a single poll.

`MessageStorage.unprocessedMessages` accepts an optional
`{ limit, addresses }` argument, and only claims the messages it actually
returns. The memory implementation now applies the same ten-minute claim
window as SQL, so bounded reads advance past in-flight requests; resetting an
address or shard makes its claimed messages immediately eligible again.

The encoded driver contract replaces `Encoded.resetAddress` with the batched
`Encoded.resetAddresses` operation. `SqlMessageStorage.makeEncoded` constructs
the SQL encoded driver directly for custom storage composition.

`ClusterWorkflowEngine` entities (workflows and the durable clock) now use a
fixed ten-second idle time, so completed and suspended executions release their
entity slots quickly. Their state is durable, so an evicted execution is
rebuilt from storage when its next message arrives.
