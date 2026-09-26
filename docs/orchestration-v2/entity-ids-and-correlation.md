# Entity IDs And Correlation

## Principle

Provider ids are evidence. App ids are identity.

Every durable entity uses an app-owned id as its primary key. Provider-native ids are stored as optional refs and used only for correlation, debugging, replay, and command routing.

## ID Families

```text
ThreadId              app-visible conversation thread
RunId                 counted app turn
NodeId                execution graph node
ProviderSessionId     live/resumable provider runtime session
ProviderThreadId      app handle for provider-native conversation
ProviderTurnId        app handle for provider-native turn
RuntimeRequestId      app handle for provider callback/request
RawEventId            optional raw provider diagnostic frame id
CheckpointId          app checkpoint id
PlanId                app plan/todo/question artifact id
```

Provider ids never replace these ids.

## Provider Refs

Provider refs are metadata on runtime entities and events.

```ts
type ProviderRefs = {
  provider: ProviderKind;
  nativeSessionRef?: string;
  nativeThreadRef?: string;
  nativeTurnRef?: string;
  nativeItemRef?: string;
  nativeRequestRef?: string;
  rawEventId?: RawEventId;
  method?: string;
};
```

Codex can populate most of these fields. Other providers may populate only a subset.

## Correlation Scope

Correlation is always scoped. Never match a native id globally without a provider/session/thread scope.

Preferred matching keys:

```text
ProviderThread:
  provider + providerSessionId + nativeThreadRef

ProviderTurn:
  providerThreadId + nativeTurnRef
  or providerThreadId + turnOrdinal

Node / TurnItem:
  providerTurnId + nativeItemRef
  or providerTurnId + itemOrdinal

RuntimeRequest:
  providerSessionId + nativeRequestRef
  or providerTurnId + requestOrdinal
```

If a provider recycles ids, the provider adapter must widen the scope until the mapping is unambiguous.

## Mapping Store

V2 needs a durable correlation table or equivalent event-sourced binding stream.

```ts
type IdentityBinding = {
  id: IdentityBindingId;
  appEntityKind: "provider_thread" | "provider_turn" | "node" | "item" | "request" | "message";
  appEntityId: string;
  provider: ProviderKind;
  providerSessionId: ProviderSessionId;
  nativeKind: string | null;
  nativeRef: string | null;
  scope: {
    threadId: ThreadId | null;
    runId: RunId | null;
    parentNodeId: NodeId | null;
    providerThreadId: ProviderThreadId | null;
    providerTurnId: ProviderTurnId | null;
  };
  correlation: "native_exact" | "native_scoped" | "ordinal" | "fingerprint" | "synthetic";
  firstRawEventId?: RawEventId;
  lastRawEventId?: RawEventId;
  createdAt: string;
  updatedAt: string;
};
```

This is not meant to be a large identity subsystem. It is the minimal durable place that says, "this native thing corresponds to this app thing." Raw event references are optional diagnostic pointers; the binding itself must not require production SQLite to retain raw provider frames forever.

## ID Allocation Rules

1. If the provider gives a stable native id, reuse the existing binding or allocate a new app id and bind it.
2. If the provider gives no stable id, allocate by scoped ordinal.
3. If ordinals are insufficient, add a fingerprint inside the scope.
4. Once allocated, never change the app id for that entity.
5. Never infer parent/root completion by string matching ids.

## Scoped Ordinals

Weak providers need deterministic ordinals.

```text
runOrdinalWithinThread
providerTurnOrdinalWithinProviderThread
nodeOrdinalWithinParent
itemOrdinalWithinProviderTurn
requestOrdinalWithinProviderTurn
messageOrdinalWithinNode
```

Ordinals are assigned by the normalizer when provider frames are processed. They must be replay-deterministic for a given provider transcript.

## Fingerprints

Fingerprints are only fallback correlation tools. They should include scope and stable structure, not large mutable text.

Examples:

```text
ProviderTurn fingerprint:
  providerThreadId + runId + providerTurnOrdinalWithinProviderThread

Node / TurnItem fingerprint:
  providerTurnId + itemKind + itemOrdinalWithinProviderTurn + toolName?

RuntimeRequest fingerprint:
  providerTurnId + requestKind + nativeItemRef? + requestOrdinalWithinProviderTurn
```

Do not use complete assistant text as a primary fingerprint. Text is mutable, can stream in chunks, and can be duplicated.

## Runtime Events

Normalized runtime events should carry both app ids and provider refs.

```ts
type RuntimeEvent = {
  id: RuntimeEventId;
  type: RuntimeEventType;
  threadId: ThreadId;
  runId: RunId | null;
  nodeId: NodeId | null;
  parentNodeId: NodeId | null;
  providerSessionId: ProviderSessionId | null;
  providerThreadId: ProviderThreadId | null;
  providerTurnId: ProviderTurnId | null;
  nativeItemRef: string | null;
  requestId: RuntimeRequestId | null;
  providerRefs: ProviderRefs;
  payload: unknown;
  createdAt: string;
};
```

Downstream systems should use app ids. Provider refs are preserved for inspection and adapter routing.

## Command Routing

UI and orchestration commands target app ids.

```text
approval.respond(RuntimeRequestId)
interrupt.run(RunId)
interrupt.node(NodeId)
fork.fromNode(NodeId)
rollback.toRun(ThreadId, runOrdinal)
```

The provider command layer resolves app ids to provider refs at the edge. If the provider ref is missing or no longer live, the command fails with a typed capability/state error.

Examples:

```text
RuntimeRequestId -> nativeRequestRef + providerSessionId
RunId -> root NodeId -> ProviderTurnId -> nativeTurnRef
NodeId -> ProviderThreadId -> nativeThreadRef
```

## Pending Requests After Restart

Pending request records may survive restart, but provider callback state usually does not.

V2 should distinguish historical pending-looking requests from respondable requests:

```ts
type ResponseCapability =
  | { type: "live"; providerSessionId: ProviderSessionId }
  | { type: "not_resumable"; reason: string };
```

The UI can show that a request expired and the user must restart or rerun the turn.

## Subagent Correlation

Subagents are represented through parent-child execution nodes.

For Codex:

```text
collabAgentToolCall item
  -> ExecutionNode(kind="subagent" or "tool_call")
receiverThreadIds[]
  -> ProviderThread records
child turn/started and turn/completed
  -> child ProviderTurn and child ExecutionNode
```

The child provider turn keeps its own provider refs. It is linked to the parent through `parentNodeId`, not by replacing its turn id with the parent turn id.

For weak providers, the adapter may create a child node by ordinal under the active parent node.

## Replay Determinism

Given the same provider transcript and same initial app state, normalization must produce the same ids.

Requirements:

- Identity bindings are persisted as events or durable rows.
- Generated ids can be random if the binding is persisted before downstream projection.
- Fixture replay may use deterministic id generation to make assertions easier.
- Reprocessing the same provider frame should find the existing binding, not allocate another entity.
