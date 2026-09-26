import {
  OrchestrationThreadDetailSnapshot,
  OrchestrationEvent,
  ProjectId,
  type OrchestrationCommand,
  ProviderDriverKind,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import type { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeExtensionScopeResolver } from "../scope.ts";
import { createOrchestrationApiProviders } from "./v1.ts";

export const context = {
  resource: {
    namespace: "orchestration.fixture",
    id: "agents",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision("/workspace", null),
} as const;
const at = "2026-09-13T00:00:00.000Z";
const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
export const makeSnapshot = () =>
  decodeSnapshot({
    snapshotSequence: 1,
    thread: {
      id: "thread",
      projectId: "project",
      title: "Orchestration fixture",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      messages: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  });

/** In-memory native-service fixture for focused adapter tests. */
export async function createFixture() {
  const events = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
  let state = makeSnapshot();
  let reject = false;
  let driver = ProviderDriverKind.make("codex");
  let enabled = true;
  let rollback = true;
  let workspaceRoot = "/workspace";
  let scriptContents = "export default 1;";
  let onRead = () => {};
  const calls: OrchestrationCommand[] = [];
  const receipts = new Map<string, OrchestrationCommandReceipt>();
  const deps: Parameters<typeof createOrchestrationApiProviders>[0] = {
    environmentId: "env",
    projects: {
      getById: ({ projectId }) => Effect.succeedSome({ projectId, workspaceRoot, deletedAt: null }),
    },
    threads: {
      getById: () =>
        Effect.succeedSome({
          projectId: ProjectId.make("project"),
          worktreePath: null,
          deletedAt: null,
        }),
    },
    snapshots: {
      getThreadDetailSnapshot: () =>
        Effect.sync(() => {
          const result = state;
          onRead();
          return Option.some(result);
        }),
    },
    receipts: {
      getByCommandId: ({ commandId }) =>
        Effect.succeed(Option.fromUndefinedOr(receipts.get(commandId))),
    },
    providers: {
      getInstanceInfo: () => Effect.succeed({ enabled, driverKind: driver }),
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          supportsConversationRollback: rollback,
        }),
    },
    diffs: {
      getTurnDiff: (input) => Effect.succeed({ ...input, diff: "diff --git a/a b/a\n-a\n+b\n" }),
      getFullThreadDiff: (input) =>
        Effect.succeed({ ...input, fromTurnCount: 0, diff: "diff --git a/a b/a\n-a\n+b\n" }),
    },
    readScript: (input) =>
      Effect.sync(() => ({ ...input, contents: scriptContents, truncated: false })),
    engine: {
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      dispatch: (command) =>
        Effect.gen(function* () {
          calls.push(command);
          if (!("threadId" in command))
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "thread required",
            });
          const sequence = state.snapshotSequence + (reject ? 0 : 1);
          receipts.set(command.commandId, {
            commandId: command.commandId,
            aggregateKind: "thread",
            aggregateId: command.threadId,
            acceptedAt: at,
            resultSequence: sequence,
            status: reject ? "rejected" : "accepted",
            error: reject ? "fixture rejection" : null,
          });
          if (reject)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "fixture rejection",
            });
          state = { ...state, snapshotSequence: sequence };
          return { sequence };
        }),
    },
  };
  const providers = createOrchestrationApiProviders(deps);
  const resolveScope = makeExtensionScopeResolver(deps);
  return {
    deps,
    providers,
    status: providers[0]!,
    control: providers[1]!,
    calls,
    receipts,
    get state() {
      return state;
    },
    setState(next: OrchestrationThreadDetailSnapshot) {
      state = next;
    },
    setReject(value: boolean) {
      reject = value;
    },
    setProvider(value: string, canRollback = true, active = true) {
      driver = ProviderDriverKind.make(value);
      rollback = canRollback;
      enabled = active;
    },
    setWorkspaceRoot(value: string) {
      workspaceRoot = value;
    },
    setScriptContents(value: string) {
      scriptContents = value;
    },
    onRead(value: () => void) {
      onRead = value;
    },
    // Mirrors the broker's validateScope wiring (EnvironmentExtensions):
    // a resolver failure rejects with the tagged ExtensionOperationError.
    async validateScope() {
      return Effect.runPromise(resolveScope(context).pipe(Effect.as(true)));
    },
    async publish(sequence: number) {
      state = { ...state, snapshotSequence: sequence };
      const event = decodeEvent({
        type: "thread.settled",
        eventId: `event-${sequence}`,
        commandId: `command-${sequence}`,
        aggregateKind: "thread",
        aggregateId: "thread",
        sequence,
        occurredAt: at,
        payload: { threadId: "thread", settledAt: at, updatedAt: at },
        causationEventId: null,
        correlationId: null,
        metadata: {},
      });
      await Effect.runPromise(PubSub.publish(events, event));
    },
    async dispose() {
      await Effect.runPromise(PubSub.shutdown(events));
    },
  };
}
