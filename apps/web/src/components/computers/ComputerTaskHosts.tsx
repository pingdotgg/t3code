import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  computerPeerFromPresentation,
  ComputerTaskDispatchError,
  matchProject,
  requireMatchedProject,
} from "@t3tools/client-runtime/computers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type ComputerPeer,
  type ComputerTaskHost as ComputerTaskHostPayload,
  type ComputerTaskSendRequest,
  type ComputerTaskSendResult,
  type ComputerTaskStreamEvent,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { newMessageId, newThreadId } from "~/lib/utils";
import { computerEnvironment } from "~/state/computers";
import { useEnvironments } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { environmentSnapshotAtom } from "~/state/shell";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { APP_DISPLAY_NAME } from "~/branding";

const TARGET_READY_TIMEOUT_MS = 20_000;
const TARGET_READY_POLL_MS = 200;

function createComputerTaskClientId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `computers-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RequestStreamResult<E> = AsyncResult.AsyncResult<ComputerTaskStreamEvent, E>;

function createComputerTaskRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<RequestStreamResult<E>>;
  readonly clientId: ComputerTaskHostPayload["clientId"];
  readonly handle: (request: ComputerTaskSendRequest) => Promise<ComputerTaskSendResult>;
  readonly respond: (response: {
    readonly clientId: ComputerTaskHostPayload["clientId"];
    readonly connectionId: string;
    readonly requestId: string;
    readonly ok: boolean;
    readonly result?: ComputerTaskSendResult;
    readonly error?: {
      readonly code:
        | "dispatch_failed"
        | "project_not_found"
        | "project_ambiguous"
        | "computer_offline";
      readonly detail: string;
    };
  }) => Promise<unknown>;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    const consume = (result: RequestStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") return;
      void options.handle(event.request).then(
        (value) =>
          options.respond({
            clientId: options.clientId,
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: value,
          }),
        (error) =>
          options.respond({
            clientId: options.clientId,
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: false,
            error: {
              code: Schema.is(ComputerTaskDispatchError)(error) ? error.code : "dispatch_failed",
              detail:
                error instanceof Error
                  ? error.message
                  : "Could not start the task on that computer.",
            },
          }),
      );
    };
    const initial = get.once(options.requestsAtom);
    get.subscribe(options.requestsAtom, consume);
    queueMicrotask(() => consume(initial));
  }).pipe(Atom.withLabel(`computer-task-consumer:${options.clientId}`));
}

export function ComputerTaskHosts() {
  const { environments } = useEnvironments();
  const computers = useMemo(
    () => environments.map((environment) => computerPeerFromPresentation(environment)),
    [environments],
  );
  if (environments.length === 0) return null;
  return (
    <>
      {environments.map((environment) => (
        <ComputerTaskHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
          computers={computers}
        />
      ))}
    </>
  );
}

function ComputerTaskHost(props: {
  readonly environmentId: EnvironmentId;
  readonly computers: ReadonlyArray<ComputerPeer>;
}) {
  const { environmentId, computers } = props;
  const registry = useContext(RegistryContext);
  const [clientId] = useState(createComputerTaskClientId);
  const [connectHost] = useState<ComputerTaskHostPayload>(() => ({ clientId, computers }));
  const requestsAtom = computerEnvironment.requests({ environmentId, input: connectHost });
  const respond = useAtomCommand(computerEnvironment.respond, { reportFailure: false });
  const sync = useAtomCommand(computerEnvironment.sync, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const thisPresentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  useAtomValue(environmentSnapshotAtom(environmentId));

  useEffect(() => {
    if (thisPresentation?.connection.phase !== "connected") return;
    void sync({ environmentId, input: { clientId, computers } });
  }, [clientId, computers, environmentId, sync, thisPresentation?.connection.phase]);

  const handleRequest = useCallback(
    async (request: ComputerTaskSendRequest): Promise<ComputerTaskSendResult> => {
      const targetId = request.computer.environmentId;
      const livePresentation = registry
        .get(environmentPresentations.presentationsAtom)
        .get(targetId);
      if (livePresentation && livePresentation.connection.phase !== "connected") {
        await retryNow(targetId);
      }
      const snapshot = await waitForTargetSnapshot(registry, targetId);
      const matched = requireMatchedProject(
        matchProject({
          projects: snapshot.projects,
          hint: request.projectHint,
          sourceTitle: request.source.projectTitle,
          sourceWorkspaceRoot: request.source.projectWorkspaceRoot,
        }),
      );
      const threadId = newThreadId();
      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      const startResult = await startTurn({
        environmentId: targetId,
        input: {
          threadId,
          message: {
            messageId,
            role: "user",
            text: request.message,
            attachments: [],
          },
          modelSelection: request.modelSelection,
          titleSeed: request.title,
          runtimeMode: request.runtimeMode,
          interactionMode: request.interactionMode,
          bootstrap: {
            createThread: {
              projectId: matched.id,
              title: request.title,
              modelSelection: request.modelSelection,
              runtimeMode: request.runtimeMode,
              interactionMode: request.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (startResult._tag === "Failure") {
        throw squashAtomCommandFailure(startResult);
      }
      return {
        environmentId: targetId,
        threadId,
        projectId: matched.id,
      };
    },
    [registry, retryNow, startTurn],
  );

  const consumerAtom = useMemo(
    () =>
      createComputerTaskRequestConsumerAtom({
        requestsAtom,
        clientId,
        handle: handleRequest,
        respond: (response) => respond({ environmentId, input: response }),
      }),
    [clientId, environmentId, handleRequest, requestsAtom, respond],
  );
  useAtomValue(consumerAtom);
  return null;
}

async function waitForTargetSnapshot(
  registry: AtomRegistry.AtomRegistry,
  targetId: EnvironmentId,
): Promise<OrchestrationV2ShellSnapshot> {
  const deadline = Date.now() + TARGET_READY_TIMEOUT_MS;
  let lastPhase: string | null = null;
  while (Date.now() < deadline) {
    const presentation = registry.get(environmentPresentations.presentationsAtom).get(targetId);
    lastPhase = presentation?.connection.phase ?? null;
    const snapshot = registry.get(environmentSnapshotAtom(targetId));
    if (lastPhase === "connected" && snapshot !== null) {
      return snapshot;
    }
    await sleep(TARGET_READY_POLL_MS);
  }
  throw new ComputerTaskDispatchError({
    code: "computer_offline",
    message:
      lastPhase === "connected"
        ? "That computer connected but T3 has not loaded its projects yet."
        : `Could not reach that computer. Keep ${APP_DISPLAY_NAME} running there, or pick it in Run on first.`,
  });
}
