import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderPersistedThread } from "../Services/ProviderAdapter.ts";
import {
  groupPersistedThreadDiscoveryCandidates,
  providerThreadDiscoveryExclusions,
  continuationIdentityDigest,
  recoverReconciliationCause,
  reconcilePersistedThread,
  resolvePersistedContinuationKey,
} from "./ProviderThreadReconciler.ts";

const CONTINUATION_KEY = "codex:home:/work/.codex";
const CONTINUATION_IDENTITY = "8da0416c4575b56e6f63b88a";
const PROVIDER_THREAD_ID = "0198cb4a-thread";
const providerIdentity = `${CONTINUATION_KEY.length}:${CONTINUATION_KEY}${PROVIDER_THREAD_ID}`;
const importedThreadId = ThreadId.make(`imported:${CONTINUATION_IDENTITY}:${PROVIDER_THREAD_ID}`);

const instance = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driverKind: ProviderDriverKind.make("codex"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: CONTINUATION_KEY,
  },
} as ProviderInstance;

const persistedThread: ProviderPersistedThread = {
  providerThreadId: PROVIDER_THREAD_ID,
  cwd: "/work/external",
  title: "External work",
  createdAt: "2026-08-21T03:22:43.000Z",
  updatedAt: "2026-08-21T03:24:43.000Z",
  discoveryCursor: "2026-08-21T03:24:43.000Z:idle",
  sourceMetadata: { source: "cli" },
  messages: [
    {
      id: "user-item",
      sourceOrdinal: 0,
      role: "user",
      text: "Investigate this",
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-21T03:24:43.000Z",
    },
    {
      id: "assistant-item",
      sourceOrdinal: 1,
      role: "assistant",
      text: "Done",
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-21T03:24:43.000Z",
    },
  ],
};

it("keeps deterministic fallback candidates for each shared Codex home", () => {
  const makeDiscoveryInstance = (instanceId: string, continuationKey: string) =>
    ({
      ...instance,
      instanceId: ProviderInstanceId.make(instanceId),
      continuationIdentity: {
        driverKind: ProviderDriverKind.make("codex"),
        continuationKey,
      },
      enabled: true,
      adapter: { discoverPersistedThreads: () => Effect.succeed([]) },
    }) as unknown as ProviderInstance;

  const groups = groupPersistedThreadDiscoveryCandidates([
    makeDiscoveryInstance("codex-z", CONTINUATION_KEY),
    makeDiscoveryInstance("codex-a", CONTINUATION_KEY),
    makeDiscoveryInstance("codex-other", "codex:home:/other/.codex"),
  ]);

  expect(groups.map((group) => group.map((candidate) => candidate.instanceId))).toEqual([
    ["codex-other"],
    ["codex-a", "codex-z"],
  ]);
});

it("recovers a continuation key after the owning instance is removed", () => {
  expect(
    resolvePersistedContinuationKey(
      "codex-removed",
      { continuationKey: CONTINUATION_KEY },
      new Map([["codex-next", CONTINUATION_KEY]]),
    ),
  ).toBe(CONTINUATION_KEY);
});

it("uses opaque continuation identities and prefers persisted ownership", () => {
  expect(continuationIdentityDigest(CONTINUATION_KEY)).toBe(CONTINUATION_IDENTITY);
  expect(continuationIdentityDigest(CONTINUATION_KEY)).not.toContain("work");
  expect(
    resolvePersistedContinuationKey(
      "codex-reconfigured",
      { continuationKey: CONTINUATION_KEY },
      new Map([["codex-reconfigured", "codex:home:/different/.codex"]]),
    ),
  ).toBe(CONTINUATION_KEY);
});

it("excludes unresolved legacy native threads from every continuation group", () => {
  expect(
    Array.from(
      providerThreadDiscoveryExclusions(
        new Set(["legacy-native-thread"]),
        new Set(["current-native-thread"]),
      ),
    ),
  ).toEqual(["legacy-native-thread", "current-native-thread"]);
});

it.effect("does not recover a reconciliation interruption", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      recoverReconciliationCause(Cause.interrupt(), "should not log", {}, undefined),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    }
  }),
);

it.effect("imports an unmatched Codex thread into the unassigned project", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const bindings: Array<Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]> = [];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as OrchestrationEngineService["Service"];
    const directory = {
      upsert: (binding: Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]) =>
        Effect.sync(() => {
          bindings.push(binding);
        }),
    } as unknown as ProviderSessionDirectory["Service"];
    const snapshots = {
      getThreadShellById: () => Effect.succeed(Option.none()),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const identities = new Map<string, ThreadId>();

    yield* reconcilePersistedThread({
      instance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: identities,
      directory,
      snapshots,
      engine,
      unassignedWorkspaceRoot: "/t3/provider-imports/codex-work",
    });

    expect(commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.message.import",
      "thread.message.import",
    ]);
    expect(commands[1]).toMatchObject({
      type: "thread.create",
      title: "External work",
      worktreePath: "/work/external",
    });
    expect(commands[2]).toMatchObject({
      type: "thread.message.import",
      role: "user",
      turnId: "turn-1",
    });
    expect(commands[3]).toMatchObject({
      type: "thread.message.import",
      role: "assistant",
      turnId: "turn-1",
    });
    const importedMessageIds = commands
      .filter((command) => command.type === "thread.message.import")
      .map((command) => command.messageId);
    expect(importedMessageIds.toSorted()).toEqual(importedMessageIds);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      providerInstanceId: "codex-work",
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { threadId: "0198cb4a-thread" },
      runtimePayload: {
        imported: true,
        providerDiscoveryCursor: "2026-08-21T03:24:43.000Z:idle",
      },
    });
  }),
);

it.effect("reuses the group project when discovery ownership changes", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const handoffInstance = {
      ...instance,
      instanceId: ProviderInstanceId.make("codex-next"),
    } as ProviderInstance;

    yield* reconcilePersistedThread({
      instance: handoffInstance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: new Map(),
      directory: {
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: () => Effect.succeed(Option.none()),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex-work"),
                model: "gpt-5.6-sol",
              },
            }),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"],
      unassignedWorkspaceRoot: "/t3/provider-imports/shared-home",
    });

    expect(commands.map((command) => command.type)).toEqual([
      "project.meta.update",
      "thread.create",
      "thread.message.import",
      "thread.message.import",
    ]);
    expect(commands[0]).toMatchObject({
      type: "project.meta.update",
      defaultModelSelection: { instanceId: "codex-next", model: "gpt-5.6-sol" },
    });
  }),
);

it.effect("migrates an existing imported thread when discovery ownership changes", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const bindings: Array<Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]> = [];
    const handoffInstance = {
      ...instance,
      instanceId: ProviderInstanceId.make("codex-next"),
    } as ProviderInstance;

    yield* reconcilePersistedThread({
      instance: handoffInstance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: new Map([[providerIdentity, importedThreadId]]),
      directory: {
        upsert: (binding: Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]) =>
          Effect.sync(() => {
            bindings.push(binding);
          }),
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              id: importedThreadId,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex-work"),
                model: "gpt-5.6-sol",
              },
            }),
          ),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex-work"),
                model: "gpt-5.6-sol",
              },
            }),
          ),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              messages: [
                { id: "existing-user", role: "user", text: "Investigate this" },
                { id: "existing-assistant", role: "assistant", text: "Done" },
              ],
            }),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"],
      unassignedWorkspaceRoot: "/t3/provider-imports/shared-home",
    });

    expect(commands.map((command) => command.type)).toEqual([
      "project.meta.update",
      "thread.meta.update",
    ]);
    expect(bindings[0]).toMatchObject({
      providerInstanceId: "codex-next",
      runtimePayload: {
        modelSelection: { instanceId: "codex-next", model: "gpt-5.6-sol" },
      },
    });
  }),
);

it.effect("imports a new thread directly into its matching project", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineService["Service"];

    yield* reconcilePersistedThread({
      instance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: new Map(),
      directory: {
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: () => Effect.succeed(Option.none()),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some({ id: "project-1" })),
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine,
      unassignedWorkspaceRoot: "/unused",
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.message.import",
      "thread.message.import",
    ]);
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      projectId: "project-1",
      worktreePath: null,
    });
  }),
);

it.effect("does not advance the discovery watermark after a partial message import", () =>
  Effect.gen(function* () {
    const bindings: Array<Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]> = [];
    const exit = yield* Effect.exit(
      reconcilePersistedThread({
        instance,
        thread: persistedThread,
        model: "gpt-5.6-sol",
        threadByProviderIdentity: new Map(),
        directory: {
          upsert: (binding: Parameters<ProviderSessionDirectory["Service"]["upsert"]>[0]) =>
            Effect.sync(() => {
              bindings.push(binding);
            }),
        } as unknown as ProviderSessionDirectory["Service"],
        snapshots: {
          getThreadShellById: () => Effect.succeed(Option.none()),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some({ id: "project-1" })),
        } as unknown as ProjectionSnapshotQuery["Service"],
        engine: {
          dispatch: (command: OrchestrationCommand) =>
            command.type === "thread.message.import" && command.role === "assistant"
              ? Effect.die("message import failed")
              : Effect.succeed({ sequence: 1 }),
        } as unknown as OrchestrationEngineService["Service"],
        unassignedWorkspaceRoot: "/unused",
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(bindings).toEqual([]);
  }),
);

it.effect("does not duplicate an identity owned by a compatible instance", () =>
  Effect.gen(function* () {
    const identities = new Map<string, ThreadId>([
      [providerIdentity, ThreadId.make("native-t3-thread")],
    ]);
    let touched = false;
    const failIfTouched = () =>
      Effect.sync(() => {
        touched = true;
        return Option.none();
      });

    yield* reconcilePersistedThread({
      instance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: identities,
      directory: {
        upsert: () => Effect.sync(() => void (touched = true)),
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: failIfTouched,
        getActiveProjectByWorkspaceRoot: failIfTouched,
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine: {
        dispatch: () => Effect.sync(() => void (touched = true)) as never,
      } as unknown as OrchestrationEngineService["Service"],
      unassignedWorkspaceRoot: "/unused",
    });

    expect(touched).toBe(false);
  }),
);

it.effect("does not re-import turns that T3 already projected under different message ids", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const identities = new Map<string, ThreadId>([[providerIdentity, importedThreadId]]);

    yield* reconcilePersistedThread({
      instance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: identities,
      directory: {
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              id: importedThreadId,
              modelSelection: {
                instanceId: instance.instanceId,
                model: "gpt-5.6-sol",
              },
            }),
          ),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some({ id: "project-1" })),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              messages: [
                { id: "t3-user-id", role: "user", text: "Investigate this" },
                { id: "assistant:user-item", role: "assistant", text: "Done" },
              ],
            }),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"],
      unassignedWorkspaceRoot: "/unused",
    });

    expect(commands).toEqual([]);
  }),
);

it.effect("appends only messages missing after a deterministic imported id", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];

    yield* reconcilePersistedThread({
      instance,
      thread: persistedThread,
      model: "gpt-5.6-sol",
      threadByProviderIdentity: new Map([[providerIdentity, importedThreadId]]),
      directory: {
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectory["Service"],
      snapshots: {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              id: importedThreadId,
              modelSelection: {
                instanceId: instance.instanceId,
                model: "gpt-5.6-sol",
              },
            }),
          ),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some({ id: "project-1" })),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              messages: [
                {
                  id: `provider:${CONTINUATION_IDENTITY}:${PROVIDER_THREAD_ID}:message:0000000000:user-item`,
                  role: "user",
                  text: "Investigate this",
                },
              ],
            }),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"],
      engine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"],
      unassignedWorkspaceRoot: "/unused",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.message.import",
      role: "assistant",
      text: "Done",
    });
  }),
);
