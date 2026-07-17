# Effect.fn Refactor Checklist

Generated from a repo scan for non-test wrapper-style candidates matching either `=> Effect.gen(function* ...)` or `return Effect.gen(function* ...)`.

Refactor Method:

```ts
// Old
function old () {
    return Effect.gen(function* () {
        ...
    });
}

const old2 = () => Effect.gen(function* () {
    ...
});
```

```ts
// New
const new = Effect.fn('functionName')(function* () {
    ...
})
```

- Use `Effect.fn('name')(function* (input: Input): Effect.fn.Return<A, E, R> {})` to annotate the return type of the function if needed.

- The 2nd argument works as a pipe, and it gets the effect and input as arguments:

```ts
Effect.fn("name")(
  function* (input: Input): Effect.fn.Return<A, E, R> {},
  (effect, input) => Effect.catch(effect, (reason) => Effect.logWarning("Err", { input, reason })),
);
```

## Summary

- Total non-test candidates: `322`

## Suggested Order

- [ ] `apps/server/src/provider/Layers/ProviderService.ts`
- [x] `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- [x] `apps/server/src/provider/Layers/CodexAdapter.ts`
- [x] `apps/server/src/git/Layers/GitCore.ts`
- [x] `apps/server/src/git/Layers/GitManager.ts`
- [x] `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- [x] `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- [ ] `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- [ ] `apps/server/src/provider/Layers/EventNdjsonLogger.ts`
- [ ] `Everything else`

## Checklist

### `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`62`)

- [x] [buildUserMessageEffect](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L554)
- [x] [makeClaudeAdapter](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L913)
- [x] [startSession](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L2414)
- [x] [sendTurn](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L2887)
- [x] [interruptTurn](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L2975)
- [x] [readThread](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L2984)
- [x] [rollbackThread](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L2990)
- [x] [stopSession](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L3039)
- [x] Internal helpers and callback wrappers in this file

### `apps/server/src/git/Layers/GitCore.ts` (`58`)

- [x] [makeGitCore](../../apps/server/src/git/Layers/GitCore.ts#L513)
- [x] [handleTraceLine](../../apps/server/src/git/Layers/GitCore.ts#L324)
- [x] [emitCompleteLines](../../apps/server/src/git/Layers/GitCore.ts#L455)
- [x] [commit](../../apps/server/src/git/Layers/GitCore.ts#L1190)
- [x] [pushCurrentBranch](../../apps/server/src/git/Layers/GitCore.ts#L1223)
- [x] [pullCurrentBranch](../../apps/server/src/git/Layers/GitCore.ts#L1323)
- [x] [checkoutBranch](../../apps/server/src/git/Layers/GitCore.ts#L1727)
- [x] Service methods and callback wrappers in this file

### `apps/server/src/git/Layers/GitManager.ts` (`28`)

- [x] [configurePullRequestHeadUpstream](../../apps/server/src/git/Layers/GitManager.ts#L387)
- [x] [materializePullRequestHeadBranch](../../apps/server/src/git/Layers/GitManager.ts#L428)
- [x] [findOpenPr](../../apps/server/src/git/Layers/GitManager.ts#L576)
- [x] [findLatestPr](../../apps/server/src/git/Layers/GitManager.ts#L602)
- [x] [runCommitStep](../../apps/server/src/git/Layers/GitManager.ts#L728)
- [x] [runPrStep](../../apps/server/src/git/Layers/GitManager.ts#L842)
- [x] [runFeatureBranchStep](../../apps/server/src/git/Layers/GitManager.ts#L1106)
- [x] Remaining helpers and nested callback wrappers in this file

### `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`25`)

- [x] [runProjectorForEvent](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1161)
- [x] [applyProjectsProjection](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L357)
- [x] [applyThreadsProjection](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L415)
- [x] `Effect.forEach(..., threadId => Effect.gen(...))` callbacks around `L250`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L264`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L305`
- [x] Remaining apply helpers in this file

### `apps/server/src/provider/Layers/ProviderService.ts` (`24`)

- [ ] [makeProviderService](../../apps/server/src/provider/Layers/ProviderService.ts#L134)
- [ ] [recoverSessionForThread](../../apps/server/src/provider/Layers/ProviderService.ts#L196)
- [ ] [resolveRoutableSession](../../apps/server/src/provider/Layers/ProviderService.ts#L255)
- [ ] [startSession](../../apps/server/src/provider/Layers/ProviderService.ts#L284)
- [ ] [sendTurn](../../apps/server/src/provider/Layers/ProviderService.ts#L347)
- [ ] [interruptTurn](../../apps/server/src/provider/Layers/ProviderService.ts#L393)
- [ ] [respondToRequest](../../apps/server/src/provider/Layers/ProviderService.ts#L411)
- [ ] [respondToUserInput](../../apps/server/src/provider/Layers/ProviderService.ts#L430)
- [ ] [stopSession](../../apps/server/src/provider/Layers/ProviderService.ts#L445)
- [ ] [listSessions](../../apps/server/src/provider/Layers/ProviderService.ts#L466)
- [ ] [rollbackConversation](../../apps/server/src/provider/Layers/ProviderService.ts#L516)
- [ ] [runStopAll](../../apps/server/src/provider/Layers/ProviderService.ts#L538)

### `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`14`)

- [x] [finalizeAssistantMessage](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L680)
- [x] [upsertProposedPlan](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L722)
- [x] [finalizeBufferedProposedPlan](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L761)
- [x] [clearTurnStateForSession](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L800)
- [x] [processRuntimeEvent](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L908)
- [x] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/CodexAdapter.ts` (`12`)

- [x] [makeCodexAdapter](../../apps/server/src/provider/Layers/CodexAdapter.ts#L1317)
- [x] [sendTurn](../../apps/server/src/provider/Layers/CodexAdapter.ts#L1399)
- [x] [writeNativeEvent](../../apps/server/src/provider/Layers/CodexAdapter.ts#L1546)
- [x] [listener](../../apps/server/src/provider/Layers/CodexAdapter.ts#L1555)
- [x] Remaining nested callback wrappers in this file

### `apps/server/src/checkpointing/CheckpointStore.ts` (`10`)

- [ ] [captureCheckpoint](../../apps/server/src/checkpointing/CheckpointStore.ts#L123)
- [ ] [restoreCheckpoint](../../apps/server/src/checkpointing/CheckpointStore.ts#L137)
- [ ] [diffCheckpoints](../../apps/server/src/checkpointing/CheckpointStore.ts#L144)
- [ ] [deleteCheckpointRefs](../../apps/server/src/checkpointing/CheckpointStore.ts#L151)
- [ ] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/EventNdjsonLogger.ts` (`9`)

- [ ] [toLogMessage](../../apps/server/src/provider/Layers/EventNdjsonLogger.ts#L77)
- [ ] [makeThreadWriter](../../apps/server/src/provider/Layers/EventNdjsonLogger.ts#L102)
- [ ] [makeEventNdjsonLogger](../../apps/server/src/provider/Layers/EventNdjsonLogger.ts#L174)
- [ ] [write](../../apps/server/src/provider/Layers/EventNdjsonLogger.ts#L231)
- [ ] [close](../../apps/server/src/provider/Layers/EventNdjsonLogger.ts#L247)
- [ ] Flush and writer-resolution callback wrappers in this file

### `apps/server/scripts/cli.ts` (`8`)

- [ ] Command handlers around [cli.ts](../../apps/server/scripts/cli.ts#L125)
- [ ] Command handlers around [cli.ts](../../apps/server/scripts/cli.ts#L170)
- [ ] Resource callbacks around [cli.ts](../../apps/server/scripts/cli.ts#L221)
- [ ] Resource callbacks around [cli.ts](../../apps/server/scripts/cli.ts#L239)

### `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (`7`)

- [ ] [processEnvelope](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L64)
- [ ] [dispatch](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L218)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L162)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L200)

### `apps/server/src/orchestration/projector.ts` (`5`)

- [ ] `switch` branch wrapper at [projector.ts](../../apps/server/src/orchestration/projector.ts#L242)
- [ ] `switch` branch wrapper at [projector.ts](../../apps/server/src/orchestration/projector.ts#L336)
- [ ] `switch` branch wrapper at [projector.ts](../../apps/server/src/orchestration/projector.ts#L397)
- [ ] `switch` branch wrapper at [projector.ts](../../apps/server/src/orchestration/projector.ts#L446)
- [ ] `switch` branch wrapper at [projector.ts](../../apps/server/src/orchestration/projector.ts#L478)

### Smaller clusters

- [ ] [packages/shared/src/DrainableWorker.ts](../../packages/shared/src/DrainableWorker.ts) (`4`)
- [ ] [apps/server/src/wsServer/pushBus.ts](../../apps/server/src/wsServer/pushBus.ts) (`4`)
- [ ] [apps/server/src/wsServer.ts](../../apps/server/src/wsServer.ts) (`4`)
- [ ] [apps/server/src/provider/Layers/ProviderRegistry.ts](../../apps/server/src/provider/Layers/ProviderRegistry.ts) (`4`)
- [ ] [apps/server/src/persistence/Layers/Sqlite.ts](../../apps/server/src/persistence/Layers/Sqlite.ts) (`4`)
- [ ] [apps/server/src/orchestration/Layers/ProviderCommandReactor.ts](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) (`4`)
- [ ] [apps/server/src/main.ts](../../apps/server/src/main.ts) (`4`)
- [ ] [apps/server/src/keybindings.ts](../../apps/server/src/keybindings.ts) (`4`)
- [ ] [apps/server/src/git/Layers/CodexTextGeneration.ts](../../apps/server/src/git/Layers/CodexTextGeneration.ts) (`4`)
- [ ] [apps/server/src/serverLayers.ts](../../apps/server/src/serverLayers.ts) (`3`)
- [ ] [apps/server/src/telemetry/Layers/AnalyticsService.ts](../../apps/server/src/telemetry/Layers/AnalyticsService.ts) (`2`)
- [ ] [apps/server/src/telemetry/Identify.ts](../../apps/server/src/telemetry/Identify.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ProviderAdapterRegistry.ts](../../apps/server/src/provider/Layers/ProviderAdapterRegistry.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/CodexProvider.ts](../../apps/server/src/provider/Layers/CodexProvider.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ClaudeProvider.ts](../../apps/server/src/provider/Layers/ClaudeProvider.ts) (`2`)
- [ ] [apps/server/src/persistence/NodeSqliteClient.ts](../../apps/server/src/persistence/NodeSqliteClient.ts) (`2`)
- [ ] [apps/server/src/persistence/Migrations.ts](../../apps/server/src/persistence/Migrations.ts) (`2`)
- [ ] [apps/server/src/open.ts](../../apps/server/src/open.ts) (`2`)
- [ ] [apps/server/src/git/Layers/ClaudeTextGeneration.ts](../../apps/server/src/git/Layers/ClaudeTextGeneration.ts) (`2`)
- [ ] [apps/server/src/checkpointing/CheckpointDiffQuery.ts](../../apps/server/src/checkpointing/CheckpointDiffQuery.ts) (`2`)
- [ ] [apps/server/src/provider/makeManagedServerProvider.ts](../../apps/server/src/provider/makeManagedServerProvider.ts) (`1`)

```

```
