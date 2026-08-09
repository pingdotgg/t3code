// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderThreadSummary } from "../Services/ProviderAdapter.ts";
import {
  synchronizeDiscoveredProviderThreads,
  type ProviderThreadDiscoverySource,
} from "./ProviderThreadDiscovery.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } as const;

function discoveredThread(
  providerThreadId: string,
  overrides: Partial<ProviderThreadSummary> = {},
): ProviderThreadSummary {
  return {
    providerThreadId,
    cwd: "/workspace/project",
    title: undefined,
    preview: `Prompt for ${providerThreadId}`,
    branch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function source(threads: ReadonlyArray<ProviderThreadSummary>): ProviderThreadDiscoverySource {
  return {
    discoveryKey: "codex:home:/home/test/.codex",
    driverKind: codex,
    instanceId,
    compatibleInstanceIds: [instanceId],
    defaultModel: "gpt-5.4",
    listThreads: () => Effect.succeed(threads),
  };
}

function emptyReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

it.effect(
  "imports unlinked Codex threads, groups their project, and persists resume bindings",
  () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const bindings: ProviderRuntimeBinding[] = [];
      const result = yield* synchronizeDiscoveredProviderThreads({
        sources: [
          source([
            discoveredThread("provider-thread-1"),
            discoveredThread("provider-thread-2", {
              title: "Named in Codex",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-04T00:00:00.000Z",
            }),
          ]),
        ],
        readModel: emptyReadModel(),
        bindings: [],
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
          }),
        upsertBinding: (binding) =>
          Effect.sync(() => {
            bindings.push(binding);
          }),
      });

      NodeAssert.deepEqual(result, { discovered: 2, imported: 2, refreshed: 0 });
      NodeAssert.equal(commands.filter((command) => command.type === "project.create").length, 1);
      const createCommands = commands.filter((command) => command.type === "thread.create");
      NodeAssert.equal(createCommands.length, 2);
      NodeAssert.equal(createCommands[0]?.title, "Prompt for provider-thread-1");
      NodeAssert.equal(createCommands[1]?.title, "Named in Codex");
      NodeAssert.equal(createCommands[0]?.projectId, createCommands[1]?.projectId);

      const sessionCommands = commands.filter((command) => command.type === "thread.session.set");
      NodeAssert.deepEqual(
        sessionCommands.map((command) => ({
          status: command.session.status,
          providerName: command.session.providerName,
          providerInstanceId: command.session.providerInstanceId,
          occurredAt: command.createdAt,
        })),
        [
          {
            status: "stopped",
            providerName: "codex",
            providerInstanceId: "codex",
            occurredAt: "2026-01-02T00:00:00.000Z",
          },
          {
            status: "stopped",
            providerName: "codex",
            providerInstanceId: "codex",
            occurredAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      );
      NodeAssert.deepEqual(
        bindings.map((binding) => binding.resumeCursor),
        [{ threadId: "provider-thread-1" }, { threadId: "provider-thread-2" }],
      );
      NodeAssert.deepEqual(
        bindings.map(
          (binding) => (binding.runtimePayload as { readonly cwd?: string } | undefined)?.cwd,
        ),
        ["/workspace/project", "/workspace/project"],
      );
    }),
);

it.effect("does not duplicate a Codex thread that already belongs to a T3 thread", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-existing");
    const threadId = ThreadId.make("t3-thread-existing");
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 1,
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          title: "Created in T3",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const commands: OrchestrationCommand[] = [];

    const result = yield* synchronizeDiscoveredProviderThreads({
      sources: [source([discoveredThread("provider-thread-existing")])],
      readModel,
      bindings: [
        {
          threadId,
          provider: codex,
          providerInstanceId: instanceId,
          resumeCursor: { threadId: "provider-thread-existing" },
        },
      ],
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
        }),
      upsertBinding: () => Effect.void,
    });

    NodeAssert.deepEqual(result, { discovered: 1, imported: 0, refreshed: 0 });
    NodeAssert.deepEqual(commands, []);
  }),
);

it.effect("refreshes imported metadata without replacing the projected session state", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-imported");
    const threadId = ThreadId.make("thread-imported");
    const originalTitle = "Original Codex title";
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 1,
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          title: originalTitle,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: {
            threadId,
            status: "stopped",
            providerName: codex,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      ],
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const commands: OrchestrationCommand[] = [];
    const bindings: ProviderRuntimeBinding[] = [];
    const updatedAt = "2026-01-05T00:00:00.000Z";

    const result = yield* synchronizeDiscoveredProviderThreads({
      sources: [
        source([
          discoveredThread("provider-thread-imported", {
            title: "Fresh Codex title",
            updatedAt,
          }),
        ]),
      ],
      readModel,
      bindings: [
        {
          threadId,
          provider: codex,
          providerInstanceId: instanceId,
          status: "stopped",
          runtimeMode: "full-access",
          resumeCursor: { threadId: "provider-thread-imported" },
          runtimePayload: {
            cwd: "/workspace/project",
            modelSelection,
            providerThreadDiscovery: {
              version: 1,
              discoveryKey: "codex:home:/home/test/.codex",
              providerThreadId: "provider-thread-imported",
              providerUpdatedAt: "2026-01-02T00:00:00.000Z",
              providerTitle: originalTitle,
            },
          },
        },
      ],
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
        }),
      upsertBinding: (binding) =>
        Effect.sync(() => {
          bindings.push(binding);
        }),
    });

    NodeAssert.deepEqual(result, { discovered: 1, imported: 0, refreshed: 1 });
    NodeAssert.deepEqual(
      commands.map((command) => command.type),
      ["thread.meta.update"],
    );
    NodeAssert.equal(
      commands[0]?.type === "thread.meta.update" && commands[0].title,
      "Fresh Codex title",
    );
    NodeAssert.equal(
      commands[0]?.type === "thread.meta.update" && commands[0].expectedTitle,
      originalTitle,
    );
    NodeAssert.equal(bindings[0]?.status, undefined);
    NodeAssert.equal(bindings[0]?.runtimeMode, undefined);
    NodeAssert.equal(readModel.threads[0]?.title, originalTitle);

    const metadata = (
      bindings[0]?.runtimePayload as {
        readonly providerThreadDiscovery?: {
          readonly providerUpdatedAt?: string;
          readonly providerTitle?: string;
        };
      }
    )?.providerThreadDiscovery;
    NodeAssert.deepEqual(metadata, {
      version: 1,
      discoveryKey: "codex:home:/home/test/.codex",
      providerThreadId: "provider-thread-imported",
      providerUpdatedAt: updatedAt,
      providerTitle: "Fresh Codex title",
    });
  }),
);
