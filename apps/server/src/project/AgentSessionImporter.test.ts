import { expect, it } from "@effect/vitest";
import {
  type AgentSessionImportSource,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

for (const scenario of [
  "canonical",
  "fallback",
  "manual-title",
  "other-project",
  "native-history",
  "other-provider",
  "repair-failure",
  "changed-transcript",
  "changed-repair-failure",
  "regenerating",
  "deleted",
] as const) {
  it.effect(`repairs only eligible imported Codex titles (${scenario})`, () => {
    let title = scenario === "manual-title" ? "My custom title" : "<recommended_plugins>";
    const originalTitle = title;
    const source: AgentSessionImportSource = {
      provider: "codex",
      providerInstanceId,
      providerSessionId,
      filePath: "/tmp/native-codex-thread.jsonl",
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    };
    const messages = [
      { role: "user", text: "<recommended_plugins>\nInjected setup\n</recommended_plugins>" },
      { role: "user", text: "Build a trade replication prototype" },
    ];
    const recorded: Array<unknown> = [];
    const renamed: Array<unknown> = [];
    const canonicalTitle = "Prototype MetaApi trade replication";
    const scanner = AgentSessionScanner.AgentSessionScanner.of({
      scan: Effect.die("unused"),
      recentThreads: () =>
        Stream.succeed(
          scenario === "changed-transcript" || scenario === "changed-repair-failure"
            ? {
                _tag: "Importable",
                source,
                thread: {
                  source: "codex",
                  providerInstanceId,
                  providerSessionId,
                  title: canonicalTitle,
                  model: null,
                  createdAt: "2026-09-01T10:00:00.000Z",
                  updatedAt: "2026-09-01T10:01:00.000Z",
                  messages: [],
                },
              }
            : {
                _tag: "AlreadyImported",
                source,
                canonicalTitle: scenario === "fallback" ? null : canonicalTitle,
              },
        ),
    });
    const testLayer = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  projectId: scenario === "other-project" ? ProjectId.make("other") : projectId,
                  title,
                  providerInstanceId:
                    scenario === "other-provider"
                      ? ProviderInstanceId.make("claudeAgent")
                      : providerInstanceId,
                  historyOrigin: scenario === "native-history" ? "native" : "v1_import",
                  deletedAt:
                    scenario === "deleted" ? DateTime.makeUnsafe("2026-09-02T10:00:00.000Z") : null,
                  titleRegeneration:
                    scenario === "regenerating" ? { requestId: "regenerate-title" } : null,
                },
                messages: messages.map((message, index) => ({
                  ...message,
                  id: `${threadId}:${String(index).padStart(6, "0")}`,
                  createdAt: DateTime.makeUnsafe("2026-09-01T10:00:00.000Z"),
                })),
              } as never),
            dispatch: (command) => {
              if (scenario === "repair-failure" || scenario === "changed-repair-failure") {
                return Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }));
              }
              return Effect.sync(() => {
                if (command.type === "thread.metadata.update" && command.title !== undefined) {
                  title = command.title;
                  renamed.push(command);
                }
                return { sequence: 1, storedEvents: [] };
              });
            },
          }),
          Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.die("history must not change") }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
          }),
          IdAllocator.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      const shouldRepair = ["canonical", "fallback", "changed-transcript"].includes(scenario);
      expect(title).toBe(
        shouldRepair
          ? scenario === "fallback"
            ? "Build a trade replication prototype"
            : canonicalTitle
          : originalTitle,
      );
      expect(renamed).toHaveLength(shouldRepair ? 1 : 0);
      if (shouldRepair)
        expect(renamed[0]).toMatchObject({
          expectedTitle: originalTitle,
          expectedTitleRegenerationRequestId: null,
        });
      expect(recorded).toHaveLength(
        scenario === "changed-transcript" || scenario === "changed-repair-failure" ? 1 : 0,
      );
      expect(messages.map((message) => message.text)).toEqual([
        "<recommended_plugins>\nInjected setup\n</recommended_plugins>",
        "Build a trade replication prototype",
      ]);
    }).pipe(Effect.provide(testLayer));
  });
}

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(testLayer));
});
