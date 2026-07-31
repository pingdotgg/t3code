import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance, ProviderThreadHistorySource } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeCodexSessionImport } from "./CodexSessionImport.ts";

const CODEX = ProviderDriverKind.make("codex");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const PROJECT_ID = ProjectId.make("project-codex-import");
const NOW = "2026-01-01T00:00:00.000Z";

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Codex import project",
  workspaceRoot: "/workspace/codex-import",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const candidate = (externalThreadId: string) => ({
  externalThreadId,
  title: `Session ${externalThreadId}`,
  preview: `Preview ${externalThreadId}`,
  createdAt: NOW,
  updatedAt: "2026-01-02T00:00:00.000Z",
  source: "cli",
  archived: false,
});

function makeInstance(source: ProviderThreadHistorySource): ProviderInstance {
  return {
    instanceId: PROVIDER_INSTANCE_ID,
    driverKind: CODEX,
    continuationIdentity: {
      driverKind: CODEX,
      continuationKey: "codex:home:test",
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        models: [{ slug: "gpt-5-codex", isDefault: true }],
      }),
    } as unknown as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    threadHistory: source,
  };
}

function makeRegistry(
  instance: ProviderInstance,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] {
  return {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === instance.instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (changes) =>
      PubSub.subscribe(changes),
    ),
  };
}

function makeDirectory(input?: {
  readonly bindings?: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>;
  readonly upserts?: Array<ProviderSessionDirectory.ProviderRuntimeBinding>;
}): ProviderSessionDirectory.ProviderSessionDirectory["Service"] {
  return {
    upsert: (binding) =>
      Effect.sync(() => {
        input?.upserts?.push(binding);
      }),
    getProvider: () => Effect.die("not used by Codex session import"),
    getBinding: () => Effect.succeed(Option.none()),
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed(input?.bindings ?? []),
  };
}

function makeImportLayer(input: {
  readonly source: ProviderThreadHistorySource;
  readonly dispatches?: Array<OrchestrationCommand>;
  readonly bindings?: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>;
  readonly upserts?: Array<ProviderSessionDirectory.ProviderRuntimeBinding>;
}) {
  const instance = makeInstance(input.source);
  return Layer.mergeAll(
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
        getProjectShellById: (projectId: ProjectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    ),
    Layer.succeed(
      OrchestrationEngine.OrchestrationEngineService,
      OrchestrationEngine.OrchestrationEngineService.of({
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            input.dispatches?.push(command);
            return { sequence: 1 };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
    ),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, makeRegistry(instance)),
    Layer.succeed(
      ProviderSessionDirectory.ProviderSessionDirectory,
      makeDirectory({
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.upserts === undefined ? {} : { upserts: input.upserts }),
      }),
    ),
  );
}

it("marks only strict imported bindings as already imported", () => {
  const source: ProviderThreadHistorySource = {
    listThreads: () =>
      Effect.succeed({
        threads: [candidate("ordinary-session"), candidate("imported-session")],
        truncated: false,
      }),
    readThreads: () => Effect.succeed([]),
  };
  const result = Effect.runSync(
    Effect.gen(function* () {
      const importer = yield* makeCodexSessionImport;
      return yield* importer.list({
        projectId: PROJECT_ID,
        providerInstanceId: PROVIDER_INSTANCE_ID,
      });
    }).pipe(
      Effect.provide(
        makeImportLayer({
          source,
          bindings: [
            {
              threadId: ThreadId.make("ordinary-t3-thread"),
              provider: CODEX,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              resumeCursor: { threadId: "ordinary-session" },
              lastSeenAt: NOW,
            },
            {
              threadId: ThreadId.make("imported-t3-thread"),
              provider: CODEX,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              resumeCursor: { threadId: "imported-session", requireExistingThread: true },
              lastSeenAt: NOW,
            },
          ],
        }),
      ),
    ),
  );

  expect(
    result.sessions.map((session) => [session.externalThreadId, session.importedThreadId]),
  ).toEqual([
    ["ordinary-session", null],
    ["imported-session", ThreadId.make("imported-t3-thread")],
  ]);
});

it("imports each selected native session once with a strict continuation binding", () => {
  const readCalls: Array<ReadonlyArray<string>> = [];
  const dispatches: OrchestrationCommand[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
  const source: ProviderThreadHistorySource = {
    listThreads: () => Effect.succeed({ threads: [candidate("native-session")], truncated: false }),
    readThreads: ({ externalThreadIds }) => {
      readCalls.push(externalThreadIds);
      return Effect.succeed([
        {
          externalThreadId: "native-session",
          title: "Imported native session",
          createdAt: NOW,
          messages: [
            {
              externalMessageId: "message-1",
              role: "user",
              text: "Please continue this work.",
              createdAt: NOW,
            },
          ],
        },
      ]);
    },
  };

  const result = Effect.runSync(
    Effect.gen(function* () {
      const importer = yield* makeCodexSessionImport;
      return yield* importer.import({
        projectId: PROJECT_ID,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        externalThreadIds: ["native-session", "native-session"],
      });
    }).pipe(Effect.provide(makeImportLayer({ source, dispatches, upserts }))),
  );

  expect(readCalls).toEqual([["native-session"]]);
  expect(result).toEqual({
    importedThreadIds: [ThreadId.make("codex:codex:native-session")],
    alreadyImportedThreadIds: [],
  });
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0]).toMatchObject({
    type: "thread.history.import",
    commandId: CommandId.make("codex-history-import:codex:native-session"),
    threadId: ThreadId.make("codex:codex:native-session"),
    projectId: PROJECT_ID,
    modelSelection: {
      instanceId: PROVIDER_INSTANCE_ID,
      model: "gpt-5-codex",
    },
    messages: [
      expect.objectContaining({
        role: "user",
        text: "Please continue this work.",
        turnId: null,
      }),
    ],
  });
  expect(upserts).toEqual([
    expect.objectContaining({
      threadId: ThreadId.make("codex:codex:native-session"),
      provider: CODEX,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      status: "stopped",
      resumeCursor: { threadId: "native-session", requireExistingThread: true },
      runtimePayload: expect.objectContaining({
        cwd: project.workspaceRoot,
        importedFrom: "codex",
      }),
    }),
  ]);
});

it("refuses a stale selection before reading or creating any T3 thread", () => {
  let readCount = 0;
  const dispatches: OrchestrationCommand[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
  const source: ProviderThreadHistorySource = {
    listThreads: () => Effect.succeed({ threads: [], truncated: false }),
    readThreads: () => {
      readCount += 1;
      return Effect.succeed([]);
    },
  };

  const error = Effect.runSync(
    Effect.gen(function* () {
      const importer = yield* makeCodexSessionImport;
      return yield* importer
        .import({
          projectId: PROJECT_ID,
          providerInstanceId: PROVIDER_INSTANCE_ID,
          externalThreadIds: ["no-longer-present"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(makeImportLayer({ source, dispatches, upserts }))),
  );

  expect(error._tag).toBe("CodexSessionImportError");
  expect(error.operation).toBe("validate-sessions");
  expect(readCount).toBe(0);
  expect(dispatches).toEqual([]);
  expect(upserts).toEqual([]);
});
