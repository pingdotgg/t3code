import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../connection/runtime";
import { BOARDS_DIR } from "../domain/board";
import type { StoreFiles } from "../orchestrator/brief";
import {
  launchOrchestrator,
  type LaunchPorts,
  type OrchestratorSelection,
} from "../orchestrator/launch";
import type { ValidBoard } from "../store/boardFiles";
import { boardEngine, newId, projectBoardsAtom } from "./boards";
import { engineConnectionAtom, engineEnvironmentIdAtom, environmentProjects } from "./projects";

const launchThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:thread:launch",
  tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
});
const threadProjection = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:thread:projection",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
});

type BoardProject = Pick<EnvironmentProject, "id" | "environmentId" | "workspaceRoot">;

/** Starts the board's orchestrator on the chosen instance and model, and saves its thread in `board.json`. */
export async function startBoardOrchestrator(
  registry: AtomRegistry.AtomRegistry,
  project: BoardProject,
  listed: ValidBoard,
  selection: OrchestratorSelection,
): Promise<ValidBoard> {
  const { environmentId } = project;
  const { files, threads, run } = boardEngine(registry, environmentId);
  const ports: LaunchPorts = {
    files,
    launchThread: async (request) =>
      (
        await run(
          runAtomCommand(
            registry,
            launchThread,
            {
              environmentId,
              input: {
                commandId: CommandId.make(newId()),
                projectId: project.id,
                title: request.title,
                modelSelection: {
                  instanceId: ProviderInstanceId.make(request.instanceId),
                  model: request.model,
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                initialMessage: { text: request.brief, attachments: [] },
              },
            },
            { reportFailure: false },
          ),
        )
      ).threadId,
    projection: async (threadId) => {
      const thread = await run(
        runAtomCommand(
          registry,
          threadProjection,
          { environmentId, input: { threadId: ThreadId.make(threadId) } },
          { reportFailure: false },
        ),
      );
      return {
        runs: thread.runs,
        messages: thread.messages,
        failures: thread.turnItems.flatMap((item) => (item.type === "error" ? [item.failure] : [])),
      };
    },
    discard: threads.archive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  try {
    const board = await launchOrchestrator(
      ports,
      { cwd: project.workspaceRoot, folder: listed.folder, board: listed.board },
      selection,
    );
    return { ...listed, board };
  } finally {
    registry.refresh(projectBoardsAtom(project.id));
  }
}

const STORE_POLL_MS = 3_000;

const sameFiles = (left: StoreFiles | null, right: StoreFiles) =>
  left !== null &&
  left.tickets === right.tickets &&
  left.forYou === right.forYou &&
  left.decisions === right.decisions;

/**
 * The orchestrator's store files for one board, by `<projectId>/<folder>`. The orchestrator writes
 * them with its own tools, so the app reads them again every few seconds while a card shows them.
 */
export const boardStoreAtom = Atom.family((key: string) =>
  Atom.make<StoreFiles | null>((get) => {
    const split = key.indexOf("/");
    const projectId = key.slice(0, split);
    const folder = key.slice(split + 1);
    const environmentId = get.once(engineEnvironmentIdAtom);
    const project = get
      .once(environmentProjects.projectsAtom)
      .find((entry) => entry.id === projectId);
    if (
      get(engineConnectionAtom).state.phase === "connected" &&
      environmentId !== null &&
      project !== undefined
    ) {
      const { files } = boardEngine(get.registry, environmentId);
      const read = (name: string) =>
        files.read(project.workspaceRoot, `${BOARDS_DIR}/${folder}/${name}`);
      const refresh = () =>
        Promise.all([read("tickets.json"), read("foryou.jsonl"), read("decisions.tsv")]).then(
          ([tickets, forYou, decisions]) => {
            const next = { tickets, forYou, decisions };
            if (!sameFiles(Option.getOrNull(get.self<StoreFiles | null>()) ?? null, next)) {
              get.setSelf(next);
            }
          },
          // The last files stay up until the next read answers.
          () => undefined,
        );
      void refresh();
      const timer = setInterval(() => void refresh(), STORE_POLL_MS);
      get.addFinalizer(() => clearInterval(timer));
    }
    return Option.getOrElse(get.self<StoreFiles | null>(), () => null);
  }).pipe(Atom.withLabel(`board-store:${key}`)),
);
