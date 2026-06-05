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

- [x] [buildUserMessageEffect](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L554)
- [x] [makeClaudeAdapter](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L913)
- [x] [startSession](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2414)
- [x] [sendTurn](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2887)
- [x] [interruptTurn](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2975)
- [x] [readThread](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2984)
- [x] [rollbackThread](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2990)
- [x] [stopSession](<repo-root>/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3039)
- [x] Internal helpers and callback wrappers in this file

### `apps/server/src/git/Layers/GitCore.ts` (`58`)

- [x] [makeGitCore](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L513)
- [x] [handleTraceLine](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L324)
- [x] [emitCompleteLines](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L455)
- [x] [commit](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L1190)
- [x] [pushCurrentBranch](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L1223)
- [x] [pullCurrentBranch](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L1323)
- [x] [checkoutBranch](<repo-root>/apps/server/src/git/Layers/GitCore.ts#L1727)
- [x] Service methods and callback wrappers in this file

### `apps/server/src/git/Layers/GitManager.ts` (`28`)

- [x] [configurePullRequestHeadUpstream](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L387)
- [x] [materializePullRequestHeadBranch](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L428)
- [x] [findOpenPr](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L576)
- [x] [findLatestPr](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L602)
- [x] [runCommitStep](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L728)
- [x] [runPrStep](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L842)
- [x] [runFeatureBranchStep](<repo-root>/apps/server/src/git/Layers/GitManager.ts#L1106)
- [x] Remaining helpers and nested callback wrappers in this file

### `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`25`)

- [x] [runProjectorForEvent](<repo-root>/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1161)
- [x] [applyProjectsProjection](<repo-root>/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L357)
- [x] [applyThreadsProjection](<repo-root>/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L415)
- [x] `Effect.forEach(..., threadId => Effect.gen(...))` callbacks around `L250`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L264`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L305`
- [x] Remaining apply helpers in this file

### `apps/server/src/provider/Layers/ProviderService.ts` (`24`)

- [ ] [makeProviderService](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L134)
- [ ] [recoverSessionForThread](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L196)
- [ ] [resolveRoutableSession](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L255)
- [ ] [startSession](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L284)
- [ ] [sendTurn](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L347)
- [ ] [interruptTurn](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L393)
- [ ] [respondToRequest](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L411)
- [ ] [respondToUserInput](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L430)
- [ ] [stopSession](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L445)
- [ ] [listSessions](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L466)
- [ ] [rollbackConversation](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L516)
- [ ] [runStopAll](<repo-root>/apps/server/src/provider/Layers/ProviderService.ts#L538)

### `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`14`)

- [x] [finalizeAssistantMessage](<repo-root>/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L680)
- [x] [upsertProposedPlan](<repo-root>/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L722)
- [x] [finalizeBufferedProposedPlan](<repo-root>/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L761)
- [x] [clearTurnStateForSession](<repo-root>/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L800)
- [x] [processRuntimeEvent](<repo-root>/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L908)
- [x] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/CodexAdapter.ts` (`12`)

- [x] [makeCodexAdapter](<repo-root>/apps/server/src/provider/Layers/CodexAdapter.ts#L1317)
- [x] [sendTurn](<repo-root>/apps/server/src/provider/Layers/CodexAdapter.ts#L1399)
- [x] [writeNativeEvent](<repo-root>/apps/server/src/provider/Layers/CodexAdapter.ts#L1546)
- [x] [listener](<repo-root>/apps/server/src/provider/Layers/CodexAdapter.ts#L1555)
- [x] Remaining nested callback wrappers in this file

### `apps/server/src/checkpointing/Layers/CheckpointStore.ts` (`10`)

- [ ] [captureCheckpoint](<repo-root>/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L89)
- [ ] [restoreCheckpoint](<repo-root>/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L183)
- [ ] [diffCheckpoints](<repo-root>/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L220)
- [ ] [deleteCheckpointRefs](<repo-root>/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L252)
- [ ] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/EventNdjsonLogger.ts` (`9`)

- [ ] [toLogMessage](<repo-root>/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L77)
- [ ] [makeThreadWriter](<repo-root>/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L102)
- [ ] [makeEventNdjsonLogger](<repo-root>/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L174)
- [ ] [write](<repo-root>/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L231)
- [ ] [close](<repo-root>/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L247)
- [ ] Flush and writer-resolution callback wrappers in this file

### `apps/server/scripts/cli.ts` (`8`)

- [ ] Command handlers around [cli.ts](<repo-root>/apps/server/scripts/cli.ts#L125)
- [ ] Command handlers around [cli.ts](<repo-root>/apps/server/scripts/cli.ts#L170)
- [ ] Resource callbacks around [cli.ts](<repo-root>/apps/server/scripts/cli.ts#L221)
- [ ] Resource callbacks around [cli.ts](<repo-root>/apps/server/scripts/cli.ts#L239)

### `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (`7`)

- [ ] [processEnvelope](<repo-root>/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L64)
- [ ] [dispatch](<repo-root>/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L218)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](<repo-root>/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L162)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](<repo-root>/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L200)

### `apps/server/src/orchestration/projector.ts` (`5`)

- [ ] `switch` branch wrapper at [projector.ts](<repo-root>/apps/server/src/orchestration/projector.ts#L242)
- [ ] `switch` branch wrapper at [projector.ts](<repo-root>/apps/server/src/orchestration/projector.ts#L336)
- [ ] `switch` branch wrapper at [projector.ts](<repo-root>/apps/server/src/orchestration/projector.ts#L397)
- [ ] `switch` branch wrapper at [projector.ts](<repo-root>/apps/server/src/orchestration/projector.ts#L446)
- [ ] `switch` branch wrapper at [projector.ts](<repo-root>/apps/server/src/orchestration/projector.ts#L478)

### Smaller clusters

- [ ] [packages/shared/src/DrainableWorker.ts](<repo-root>/packages/shared/src/DrainableWorker.ts) (`4`)
- [ ] [apps/server/src/wsServer/pushBus.ts](<repo-root>/apps/server/src/wsServer/pushBus.ts) (`4`)
- [ ] [apps/server/src/wsServer.ts](<repo-root>/apps/server/src/wsServer.ts) (`4`)
- [ ] [apps/server/src/provider/Layers/ProviderRegistry.ts](<repo-root>/apps/server/src/provider/Layers/ProviderRegistry.ts) (`4`)
- [ ] [apps/server/src/persistence/Layers/Sqlite.ts](<repo-root>/apps/server/src/persistence/Layers/Sqlite.ts) (`4`)
- [ ] [apps/server/src/orchestration/Layers/ProviderCommandReactor.ts](<repo-root>/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) (`4`)
- [ ] [apps/server/src/main.ts](<repo-root>/apps/server/src/main.ts) (`4`)
- [ ] [apps/server/src/keybindings.ts](<repo-root>/apps/server/src/keybindings.ts) (`4`)
- [ ] [apps/server/src/git/Layers/CodexTextGeneration.ts](<repo-root>/apps/server/src/git/Layers/CodexTextGeneration.ts) (`4`)
- [ ] [apps/server/src/serverLayers.ts](<repo-root>/apps/server/src/serverLayers.ts) (`3`)
- [ ] [apps/server/src/telemetry/Layers/AnalyticsService.ts](<repo-root>/apps/server/src/telemetry/Layers/AnalyticsService.ts) (`2`)
- [ ] [apps/server/src/telemetry/Identify.ts](<repo-root>/apps/server/src/telemetry/Identify.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ProviderAdapterRegistry.ts](<repo-root>/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/CodexProvider.ts](<repo-root>/apps/server/src/provider/Layers/CodexProvider.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ClaudeProvider.ts](<repo-root>/apps/server/src/provider/Layers/ClaudeProvider.ts) (`2`)
- [ ] [apps/server/src/persistence/NodeSqliteClient.ts](<repo-root>/apps/server/src/persistence/NodeSqliteClient.ts) (`2`)
- [ ] [apps/server/src/persistence/Migrations.ts](<repo-root>/apps/server/src/persistence/Migrations.ts) (`2`)
- [ ] [apps/server/src/open.ts](<repo-root>/apps/server/src/open.ts) (`2`)
- [ ] [apps/server/src/git/Layers/ClaudeTextGeneration.ts](<repo-root>/apps/server/src/git/Layers/ClaudeTextGeneration.ts) (`2`)
- [ ] [apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts](<repo-root>/apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts) (`2`)
- [ ] [apps/server/src/provider/makeManagedServerProvider.ts](<repo-root>/apps/server/src/provider/makeManagedServerProvider.ts) (`1`)

```

```
