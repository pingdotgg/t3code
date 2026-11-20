import {
  CommandId,
  type EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadShell,
  ProjectListEntriesError,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { engineBridge } from "../connection/bridge";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  archiveBoard,
  type BoardThreads,
  type FamilyThread,
  restoreBoard,
} from "../store/boardArchive";
import {
  createBoard,
  type ListedBoard,
  listBoards,
  type ProjectFiles,
  type ValidBoard,
} from "../store/boardFiles";
import { createLocalState, type LocalState } from "../store/localState";
import { failureText } from "../settings/failureText";
import {
  engineConnectionAtom,
  engineEnvironmentIdAtom,
  environmentProjects,
  projectEnvironment,
} from "./projects";

export const localState = createLocalState({
  read: engineBridge.readLocalState,
  write: engineBridge.writeLocalState,
});

const listEntries = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:project:list-entries",
  tag: WS_METHODS.projectsListEntries,
});
const readFile = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:project:read-file",
  tag: WS_METHODS.projectsReadFile,
});
const dispatch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:thread:dispatch",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});
const threadFamily = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:thread:family",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
});
const archivedSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:thread:archived-snapshot",
  tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
});

// Ids are minted in event handlers, outside any Effect.
export const newId = () =>
  // @effect-diagnostics-next-line cryptoRandomUUID:off
  crypto.randomUUID();

const isProjectListEntriesError = Schema.is(ProjectListEntriesError);

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

type Shell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "status" | "lineage" | "activityRunStatus" | "pendingBackgroundTasks"
>;

// An orchestrator's own run ends while its delegated tasks keep going, so the status alone says
// nothing about them. The engine refuses an archive until the shell shows none of these.
const familyThread = (shell: Shell): FamilyThread => ({
  id: shell.id,
  working:
    LIVE_STATUSES.has(shell.status) ||
    (shell.activityRunStatus ?? null) !== null ||
    (shell.pendingBackgroundTasks?.length ?? 0) > 0,
  isRoot: shell.id === shell.lineage.rootThreadId,
});

/** The engine calls the board's files and threads go through, as the store layer's ports. */
export function boardEngine(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const run = async <A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> => {
    const settled = await pending;
    if (settled._tag === "Success") return settled.value;
    throw new Error(failureText(settled));
  };
  const send = (type: "thread.stop" | "thread.archive" | "thread.unarchive", id: string) =>
    run(
      runAtomCommand(
        registry,
        dispatch,
        {
          environmentId,
          input:
            type === "thread.stop"
              ? {
                  type,
                  commandId: CommandId.make(newId()),
                  threadId: ThreadId.make(id),
                  stopDelegatedTasks: true,
                }
              : { type, commandId: CommandId.make(newId()), threadId: ThreadId.make(id) },
        },
        { reportFailure: false },
      ),
    ).then(() => undefined);

  const files: ProjectFiles = {
    list: async (cwd, directoryPath) => {
      const result = await runAtomCommand(
        registry,
        listEntries,
        { environmentId, input: { cwd, directoryPath } },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value.entries;
      const failure = squashAtomCommandFailure(result);
      if (isProjectListEntriesError(failure) && failure.failure === "directory_list_failed") {
        return null;
      }
      throw new Error(failureText(result));
    },
    read: async (cwd, relativePath) => {
      const result = await run(
        runAtomCommand(
          registry,
          readFile,
          { environmentId, input: { cwd, relativePath, allowMissing: true } },
          { reportFailure: false },
        ),
      );
      return result.exists === false ? null : result.contents;
    },
    write: (cwd, relativePath, contents) =>
      run(
        runAtomCommand(
          registry,
          projectEnvironment.writeFile,
          { environmentId, input: { cwd, relativePath, contents } },
          { reportFailure: false },
        ),
      ).then(() => undefined),
  };

  const threads: BoardThreads = {
    stop: (id) => send("thread.stop", id),
    archive: (id) => send("thread.archive", id),
    unarchive: (id) => send("thread.unarchive", id),
    activeFamily: async (id) =>
      (
        await run(
          runAtomCommand(
            registry,
            threadFamily,
            { environmentId, input: { threadId: ThreadId.make(id) } },
            { reportFailure: false },
          ),
        )
      ).threads.map(familyThread),
    archivedFamily: async (id) =>
      (
        await run(
          runAtomCommand(
            registry,
            archivedSnapshot,
            { environmentId, input: {} },
            { reportFailure: false },
          ),
        )
      ).threads
        .filter((shell) => shell.lineage.rootThreadId === id)
        .map(familyThread),
  };

  return { files, threads };
}

export type ProjectBoards =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly boards: ReadonlyArray<ListedBoard> };

const LOADING: ProjectBoards = { status: "loading" };

// A read before the engine answers fails, and the list would keep that failure.
const engineConnectedAtom = Atom.make(
  (get) => get(engineConnectionAtom).state.phase === "connected",
).pipe(Atom.withLabel("engine-connected"));

/**
 * The boards each project lists, by project id. A project's `.agentboard` folder is read when its
 * row opens and again on `registry.refresh`, and the last list stays up while it reads.
 */
export const projectBoardsAtom = Atom.family((projectId: string) =>
  Atom.make<ProjectBoards>((get) => {
    const environmentId = get.once(engineEnvironmentIdAtom);
    const project = get
      .once(environmentProjects.projectsAtom)
      .find((entry) => entry.id === projectId);
    if (get(engineConnectedAtom) && environmentId !== null && project !== undefined) {
      listBoards(boardEngine(get.registry, environmentId).files, project.workspaceRoot)
        .then(
          (boards): ProjectBoards => ({ status: "ready", boards }),
          (error): ProjectBoards => ({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((result) => get.setSelf(result));
    }
    return Option.getOrElse(get.self<ProjectBoards>(), () => LOADING);
  }).pipe(Atom.withLabel(`project-boards:${projectId}`)),
);

/** The board the user last opened, which the sidebar marks. The saved choice replaces null on launch. */
export const lastOpenedBoardAtom = Atom.writable(
  (get): LocalState["lastOpenedBoard"] => {
    void localState.read().then((state) => get.setSelf(state.lastOpenedBoard));
    return null;
  },
  (context, opened: NonNullable<LocalState["lastOpenedBoard"]>) => context.setSelf(opened),
).pipe(Atom.keepAlive, Atom.withLabel("last-opened-board"));

type BoardProject = Pick<EnvironmentProject, "id" | "environmentId" | "workspaceRoot">;

export async function addBoard(
  registry: AtomRegistry.AtomRegistry,
  project: BoardProject,
  name: string,
): Promise<ValidBoard> {
  const created = await createBoard(
    boardEngine(registry, project.environmentId).files,
    project.workspaceRoot,
    {
      id: newId(),
      projectId: project.id,
      name,
      createdAt: new Date().toISOString(),
    },
  );
  registry.refresh(projectBoardsAtom(project.id));
  return created;
}

export async function setBoardArchived(
  registry: AtomRegistry.AtomRegistry,
  project: BoardProject,
  listed: ValidBoard,
  archived: boolean,
) {
  const { files, threads } = boardEngine(registry, project.environmentId);
  const target = { cwd: project.workspaceRoot, folder: listed.folder, board: listed.board };
  try {
    if (archived) {
      await archiveBoard(files, threads, target, {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    } else {
      await restoreBoard(files, threads, target);
    }
  } finally {
    registry.refresh(projectBoardsAtom(project.id));
  }
}

export function openBoard(
  registry: AtomRegistry.AtomRegistry,
  opened: NonNullable<LocalState["lastOpenedBoard"]>,
) {
  registry.set(lastOpenedBoardAtom, opened);
  return localState.update((state) => ({ ...state, lastOpenedBoard: opened }));
}
