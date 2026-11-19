import { assert, it } from "@effect/vitest";
import { CommandId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";

import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { findReplayFixture, readReplayFixtureTranscript } from "./ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const SCENARIO = "thread-delete-provider-native-subagents";

it.effect("deleting a thread deletes the subagent threads Codex started for it", () =>
  Effect.gen(function* () {
    const fixture = findReplayFixture("subagent");
    assert.isDefined(fixture);
    const codex = fixture.providers.find((provider) => provider.driver === "codex");
    assert.isDefined(codex);
    const fixtureInput = fixture.buildInput();
    const workspace = yield* checkpointWorkspace(SCENARIO, fixtureInput.workspaceFiles);
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptWorkspace(
        materializeReplayTranscriptRuntimeInstructions(
          yield* readReplayFixtureTranscript(codex.transcriptFile),
          { driver: codex.driver, model: codex.modelSelection.model },
        ),
        workspace,
      ),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: SCENARIO,
      fixtureInput,
      driver: codex.driver,
      modelSelection: codex.modelSelection,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const threadId = materialized.projectionThreadIds[0];
    assert.isDefined(threadId);
    const deleteCommand = {
      type: "thread.delete",
      commandId: CommandId.make(`${SCENARIO}-delete`),
      threadId,
    } satisfies OrchestrationV2Command;

    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${SCENARIO}/codex`,
        transcript,
        commands: [...materialized.commands, deleteCommand],
        steps: [
          ...materialized.steps,
          { type: "capture_shell_snapshot", key: "before-delete" },
          { type: "dispatch", command: deleteCommand, await: true },
        ],
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...codex.runtimePolicyOverride, cwd: workspace },
      },
      CodexOrchestratorReplayHarness,
    ).pipe(provideDeterministicTestRuntime);

    const beforeDelete = result.capturedShellSnapshots.get("before-delete");
    assert.isDefined(beforeDelete);
    const subagentThreadIds = beforeDelete.threads
      .filter(
        (thread) =>
          thread.lineage.parentThreadId === threadId &&
          thread.lineage.relationshipToParent === "subagent",
      )
      .map((thread) => thread.id);
    assert.lengthOf(subagentThreadIds, 2);

    const deletedThreadIds = new Set(
      result.domainEvents.flatMap((event) =>
        event.type === "thread.deleted" ? [event.threadId] : [],
      ),
    );
    assert.deepEqual(
      [threadId, ...subagentThreadIds].filter((id) => !deletedThreadIds.has(id)),
      [],
    );
    assert.deepEqual(result.shellSnapshot.threads, []);
  }).pipe(Effect.scoped),
);
