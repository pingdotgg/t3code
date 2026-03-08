import {
  type ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ServerProviderStatus,
  type WebSocketRequest,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { Effect, Option, Stream, Struct } from "effect";

import type { CheckpointDiffQueryShape } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import type { KeybindingsShape } from "./keybindings.ts";
import { REMOTE_HELPER_METHODS } from "./remote/protocol.ts";
import type { RemoteHostRegistryShape } from "./remote/Services/HostRegistry.ts";
import type { RemoteHelperClientShape } from "./remote/Services/HelperClient.ts";
import type { WorkspaceRuntimeRouterShape } from "./remote/Services/WorkspaceRuntimeRouter.ts";

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

export function createWsRouteRequest<E>(input: {
  readonly checkpointDiffQuery: CheckpointDiffQueryShape;
  readonly cwd: string;
  readonly availableEditors: readonly string[];
  readonly keybindingsConfigPath: string;
  readonly keybindingsManager: Pick<KeybindingsShape, "loadConfigState" | "upsertKeybindingRule">;
  readonly normalizeDispatchCommand: (request: {
    readonly command: ClientOrchestrationCommand;
  }) => Effect.Effect<Parameters<OrchestrationEngineShape["dispatch"]>[0], E, never>;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionReadModelQuery: ProjectionSnapshotQueryShape;
  readonly providerStatuses: ReadonlyArray<ServerProviderStatus>;
  readonly remoteHelperClient: RemoteHelperClientShape;
  readonly remoteHostRegistry: RemoteHostRegistryShape;
  readonly runtimeRouter: WorkspaceRuntimeRouterShape;
  readonly failRouteRequest: (message: string) => Effect.Effect<never, E, never>;
  readonly openInEditor: (
    input: Parameters<WorkspaceRuntimeRouterShape["openInEditor"]>[0],
  ) => Effect.Effect<void, E, never>;
}) {
  return Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* input.projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const normalizedCommand = yield* input.normalizeDispatchCommand({
          command: request.body.command,
        });
        return yield* input.orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* input.checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* input.checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          input.orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries:
        return yield* input.runtimeRouter.projectSearchEntries(stripRequestTag(request.body));

      case WS_METHODS.projectsWriteFile:
        return yield* input.runtimeRouter.projectWriteFile(stripRequestTag(request.body));

      case WS_METHODS.remoteHostsList:
        return yield* input.remoteHostRegistry.list();

      case WS_METHODS.remoteHostsUpsert:
        return yield* input.remoteHostRegistry.upsert(stripRequestTag(request.body));

      case WS_METHODS.remoteHostsRemove: {
        const body = stripRequestTag(request.body);
        return yield* input.remoteHostRegistry.remove(body.remoteHostId);
      }

      case WS_METHODS.remoteHostsTestConnection: {
        const body = stripRequestTag(request.body);
        const result = yield* input.remoteHelperClient.testConnection(body.remoteHostId);
        return {
          remoteHostId: body.remoteHostId,
          ok: true,
          helperVersion: result.helperVersion,
          capabilities: result.capabilities,
          checkedAt: new Date().toISOString(),
        };
      }

      case WS_METHODS.remoteHostsBrowse: {
        const body = stripRequestTag(request.body);
        const host = yield* input.remoteHostRegistry.getById(body.remoteHostId);
        if (Option.isNone(host)) {
          return yield* input.failRouteRequest(
            `Remote host '${body.remoteHostId}' was not found.`,
          );
        }
        const cwd = body.path ?? "~";
        const result = yield* input.remoteHelperClient.call(
          body.remoteHostId,
          body.query
            ? REMOTE_HELPER_METHODS.workspaceSearchEntries
            : REMOTE_HELPER_METHODS.workspaceBrowseEntries,
          body.query
            ? { cwd, query: body.query, limit: body.limit }
            : { cwd, limit: body.limit },
        );
        const resultCwd = "cwd" in result ? result.cwd : cwd;
        return {
          remoteHostId: body.remoteHostId,
          cwd: resultCwd,
          entries: result.entries,
          truncated: result.truncated,
        };
      }

      case WS_METHODS.shellOpenInEditor:
        return yield* input.openInEditor(stripRequestTag(request.body));

      case WS_METHODS.gitStatus:
        return yield* input.runtimeRouter.gitStatus(stripRequestTag(request.body));

      case WS_METHODS.gitPull:
        return yield* input.runtimeRouter.gitPull(stripRequestTag(request.body));

      case WS_METHODS.gitRunStackedAction:
        return yield* input.runtimeRouter.gitRunStackedAction(stripRequestTag(request.body));

      case WS_METHODS.gitListBranches:
        return yield* input.runtimeRouter.gitListBranches(stripRequestTag(request.body));

      case WS_METHODS.gitCreateWorktree:
        return yield* input.runtimeRouter.gitCreateWorktree(stripRequestTag(request.body));

      case WS_METHODS.gitRemoveWorktree:
        return yield* input.runtimeRouter.gitRemoveWorktree(stripRequestTag(request.body));

      case WS_METHODS.gitCreateBranch:
        return yield* input.runtimeRouter.gitCreateBranch(stripRequestTag(request.body));

      case WS_METHODS.gitCheckout:
        return yield* input.runtimeRouter.gitCheckout(stripRequestTag(request.body));

      case WS_METHODS.gitInit:
        return yield* input.runtimeRouter.gitInit(stripRequestTag(request.body));

      case WS_METHODS.terminalOpen:
        return yield* input.runtimeRouter.terminalOpen(stripRequestTag(request.body));

      case WS_METHODS.terminalWrite:
        return yield* input.runtimeRouter.terminalWrite(stripRequestTag(request.body));

      case WS_METHODS.terminalResize:
        return yield* input.runtimeRouter.terminalResize(stripRequestTag(request.body));

      case WS_METHODS.terminalClear:
        return yield* input.runtimeRouter.terminalClear(stripRequestTag(request.body));

      case WS_METHODS.terminalRestart:
        return yield* input.runtimeRouter.terminalRestart(stripRequestTag(request.body));

      case WS_METHODS.terminalClose:
        return yield* input.runtimeRouter.terminalClose(stripRequestTag(request.body));

      case WS_METHODS.serverGetConfig: {
        const keybindingsConfig = yield* input.keybindingsManager.loadConfigState;
        return {
          cwd: input.cwd,
          keybindingsConfigPath: input.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: input.providerStatuses,
          availableEditors: input.availableEditors,
        };
      }

      case WS_METHODS.serverUpsertKeybinding: {
        const keybindingsConfig = yield* input.keybindingsManager.upsertKeybindingRule(
          stripRequestTag(request.body),
        );
        return { keybindings: keybindingsConfig, issues: [] };
      }

      default: {
        const exhaustiveCheck: never = request.body;
        return yield* input.failRouteRequest(`Unknown method: ${String(exhaustiveCheck)}`);
      }
    }
  });
}
