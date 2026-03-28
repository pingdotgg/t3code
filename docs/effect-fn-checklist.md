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

## Summary

- Total non-test candidates: `322`

## Suggested Order

- [ ] `apps/server/src/provider/Layers/ProviderService.ts`
- [x] `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- [ ] `apps/server/src/provider/Layers/CodexAdapter.ts`
- [ ] `apps/server/src/git/Layers/GitCore.ts`
- [ ] `apps/server/src/git/Layers/GitManager.ts`
- [ ] `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- [ ] `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- [ ] `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- [ ] `apps/server/src/provider/Layers/EventNdjsonLogger.ts`
- [ ] `Everything else`

## Checklist

### `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`62`)

- [x] [buildUserMessageEffect](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L554)
- [x] [makeClaudeAdapter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L913)
- [x] [startSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2414)
- [x] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2887)
- [x] [interruptTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2975)
- [x] [readThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2984)
- [x] [rollbackThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2990)
- [x] [stopSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3039)
- [x] Internal helpers and callback wrappers in this file

### `apps/server/src/git/Layers/GitCore.ts` (`58`)

- [ ] [makeGitCore](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L495)
- [ ] [handleTraceLine](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L317)
- [ ] [emitCompleteLines](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L449)
- [ ] [commit](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1178)
- [ ] [pushCurrentBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1217)
- [ ] [pullCurrentBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1316)
- [ ] [checkoutBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1697)
- [ ] Service methods and callback wrappers in this file

### `apps/server/src/git/Layers/GitManager.ts` (`28`)

- [ ] [configurePullRequestHeadUpstream](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L387)
- [ ] [materializePullRequestHeadBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L428)
- [ ] [findOpenPr](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L576)
- [ ] [findLatestPr](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L602)
- [ ] [runCommitStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L728)
- [ ] [runPrStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L842)
- [ ] [runFeatureBranchStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L1106)
- [ ] Remaining helpers and nested callback wrappers in this file

### `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`25`)

- [ ] [runProjectorForEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1161)
- [ ] [applyProjectsProjection](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L357)
- [ ] [applyThreadsProjection](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L415)
- [ ] `Effect.forEach(..., threadId => Effect.gen(...))` callbacks around `L250`
- [ ] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L264`
- [ ] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L305`
- [ ] Remaining apply helpers in this file

### `apps/server/src/provider/Layers/ProviderService.ts` (`24`)

- [ ] [makeProviderService](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L134)
- [ ] [recoverSessionForThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L196)
- [ ] [resolveRoutableSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L255)
- [ ] [startSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L284)
- [ ] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L347)
- [ ] [interruptTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L393)
- [ ] [respondToRequest](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L411)
- [ ] [respondToUserInput](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L430)
- [ ] [stopSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L445)
- [ ] [listSessions](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L466)
- [ ] [rollbackConversation](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L516)
- [ ] [runStopAll](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L538)

### `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`14`)

- [ ] [finalizeAssistantMessage](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L680)
- [ ] [upsertProposedPlan](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L722)
- [ ] [finalizeBufferedProposedPlan](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L761)
- [ ] [clearTurnStateForSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L800)
- [ ] [processRuntimeEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L908)
- [ ] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/CodexAdapter.ts` (`12`)

- [ ] [makeCodexAdapter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1317)
- [ ] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1399)
- [ ] [writeNativeEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1546)
- [ ] [listener](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1555)
- [ ] Remaining nested callback wrappers in this file

### `apps/server/src/checkpointing/Layers/CheckpointStore.ts` (`10`)

- [ ] [captureCheckpoint](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L89)
- [ ] [restoreCheckpoint](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L183)
- [ ] [diffCheckpoints](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L220)
- [ ] [deleteCheckpointRefs](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L252)
- [ ] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/EventNdjsonLogger.ts` (`9`)

- [ ] [toLogMessage](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L77)
- [ ] [makeThreadWriter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L102)
- [ ] [makeEventNdjsonLogger](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L174)
- [ ] [write](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L231)
- [ ] [close](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L247)
- [ ] Flush and writer-resolution callback wrappers in this file

### `apps/server/scripts/cli.ts` (`8`)

- [ ] Command handlers around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L125)
- [ ] Command handlers around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L170)
- [ ] Resource callbacks around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L221)
- [ ] Resource callbacks around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L239)

### `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (`7`)

- [ ] [processEnvelope](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L64)
- [ ] [dispatch](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L218)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L162)
- [ ] Catch/stream callback wrappers around [OrchestrationEngine.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L200)

### `apps/server/src/orchestration/projector.ts` (`5`)

- [ ] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L242)
- [ ] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L336)
- [ ] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L397)
- [ ] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L446)
- [ ] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L478)

### Smaller clusters

- [ ] [packages/shared/src/DrainableWorker.ts](/Users/julius/Development/Work/codething-mvp/packages/shared/src/DrainableWorker.ts) (`4`)
- [ ] [apps/server/src/wsServer/pushBus.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/wsServer/pushBus.ts) (`4`)
- [ ] [apps/server/src/wsServer.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/wsServer.ts) (`4`)
- [ ] [apps/server/src/provider/Layers/ProviderRegistry.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderRegistry.ts) (`4`)
- [ ] [apps/server/src/persistence/Layers/Sqlite.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/Layers/Sqlite.ts) (`4`)
- [ ] [apps/server/src/orchestration/Layers/ProviderCommandReactor.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) (`4`)
- [ ] [apps/server/src/main.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/main.ts) (`4`)
- [ ] [apps/server/src/keybindings.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/keybindings.ts) (`4`)
- [ ] [apps/server/src/git/Layers/CodexTextGeneration.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/CodexTextGeneration.ts) (`4`)
- [ ] [apps/server/src/serverLayers.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/serverLayers.ts) (`3`)
- [ ] [apps/server/src/telemetry/Layers/AnalyticsService.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/telemetry/Layers/AnalyticsService.ts) (`2`)
- [ ] [apps/server/src/telemetry/Identify.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/telemetry/Identify.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ProviderAdapterRegistry.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/CodexProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexProvider.ts) (`2`)
- [ ] [apps/server/src/provider/Layers/ClaudeProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeProvider.ts) (`2`)
- [ ] [apps/server/src/persistence/NodeSqliteClient.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/NodeSqliteClient.ts) (`2`)
- [ ] [apps/server/src/persistence/Migrations.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/Migrations.ts) (`2`)
- [ ] [apps/server/src/open.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/open.ts) (`2`)
- [ ] [apps/server/src/git/Layers/ClaudeTextGeneration.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/ClaudeTextGeneration.ts) (`2`)
- [ ] [apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts) (`2`)
- [ ] [apps/server/src/provider/makeManagedServerProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/makeManagedServerProvider.ts) (`1`)
