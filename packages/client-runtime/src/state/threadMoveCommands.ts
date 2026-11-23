import {
  WS_METHODS,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadMoveSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export interface ThreadMoveRequest {
  /** Generated once per attempt, so a retry lands on the same new thread. */
  readonly commandId: CommandId;
  readonly source: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly label: string;
  };
  readonly snapshot: ThreadMoveSnapshot;
  readonly creationSource: "web" | "mobile";
}

export interface ThreadMoveOutcome {
  readonly threadId: ThreadId;
  readonly carriedBranch: string | null;
  /** False when the new thread exists but the original could not be archived. */
  readonly sourceArchived: boolean;
}

export function createThreadMoveCommands<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  const exportThread = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:thread-move:export",
    tag: WS_METHODS.threadMoveExport,
  });
  const importThread = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:thread-move:import",
    tag: WS_METHODS.threadMoveImport,
  });
  const completeMove = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:thread-move:complete",
    tag: WS_METHODS.threadMoveComplete,
  });

  /** Creates the thread on the target, then archives the original. */
  const move = {
    label: "environment-data:thread-move:move",
    run: (registry: Parameters<typeof importThread.run>[0], request: ThreadMoveRequest) =>
      Effect.gen(function* () {
        const imported = yield* importThread.run(registry, {
          environmentId: request.target.environmentId,
          input: {
            commandId: request.commandId,
            projectId: request.target.projectId,
            snapshot: request.snapshot,
            creationSource: request.creationSource,
          },
        });
        const completed = yield* Effect.exit(
          completeMove.run(registry, {
            environmentId: request.source.environmentId,
            input: {
              threadId: request.source.threadId,
              targetEnvironmentLabel: request.target.label,
            },
          }),
        );
        return {
          threadId: imported.threadId,
          carriedBranch: imported.carriedBranch,
          sourceArchived: Exit.isSuccess(completed),
        } satisfies ThreadMoveOutcome;
      }),
  };

  return {
    exportThread,
    move,
    /** Moving needs both: starting the thread on the target and archiving the source. */
    importPermissionAtom: importThread.permissionAtom,
    completePermissionAtom: completeMove.permissionAtom,
  };
}
