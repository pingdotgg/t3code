// @effect-diagnostics effectFnOpportunity:off - Thin wrapper over the promise-based IWE core; spans come from withSpan.
import {
  IweError,
  type IweCompletion,
  type IweNote,
  type IweNoteSummary,
  type IweRenameResult,
  type IweToolStatus,
  type IweWorkspaceInfo,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { IweCore } from "./iweCore.ts";

const toError = (cause: unknown) => new IweError({ message: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: toError }).pipe(Effect.withSpan(`IweService.${name}`));

export class IweService extends Context.Service<
  IweService,
  {
    readonly core: IweCore;
    readonly status: Effect.Effect<IweToolStatus, IweError>;
    readonly install: (report: (completed: number | null, total: number | null) => void) => Effect.Effect<IweToolStatus, IweError>;
    readonly prepare: (path: string, mode: "open" | "new") => Effect.Effect<IweWorkspaceInfo, IweError>;
    readonly workspace: (root: string) => Effect.Effect<IweWorkspaceInfo | null, IweError>;
    readonly search: (root: string, query: string, mode: "fuzzy" | "lexical" | "both", limit: number) => Effect.Effect<ReadonlyArray<IweNoteSummary>, IweError>;
    readonly note: (root: string, key: string) => Effect.Effect<IweNote, IweError>;
    readonly save: (root: string, key: string, content: string, threadId: ThreadId | null) => Effect.Effect<IweNote, IweError>;
    readonly create: (root: string, title: string, content: string) => Effect.Effect<IweNote, IweError>;
    readonly rename: (root: string, key: string, newKey: string) => Effect.Effect<IweRenameResult, IweError>;
    readonly complete: (root: string, key: string, text: string, line: number, character: number) => Effect.Effect<ReadonlyArray<IweCompletion>, IweError>;
    readonly renameLink: (root: string, key: string, text: string, line: number, character: number, newName: string) => Effect.Effect<IweRenameResult, IweError>;
    readonly run: <A>(name: string, work: (core: IweCore) => Promise<A>) => Effect.Effect<A, IweError>;
  }
>()("t3/iwe/IweService") {}

export const layer = Layer.effect(
  IweService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const env = yield* HostProcess.Environment;
    const core = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => IweCore.start({ baseDir: config.baseDir, stateDir: config.stateDir, platform, arch, env }), catch: toError }),
      (started) => Effect.sync(() => started.stop()),
    );
    return IweService.of({
      core,
      status: attempt("status", () => core.status()),
      install: (report) => attempt("install", () => core.install(report)),
      prepare: (path, mode) => attempt("prepare", () => core.prepare(path, mode)),
      workspace: (root) => attempt("workspace", () => core.workspace(root)),
      search: (root, query, mode, limit) => attempt("search", () => core.search(root, query, mode, limit)),
      note: (root, key) => attempt("note", () => core.note(root, key)),
      save: (root, key, content, threadId) =>
        attempt("save", async () => {
          const note = await core.save(root, key, content);
          if (threadId !== null) core.record(threadId, [note], "updated", "user");
          return note;
        }),
      create: (root, title, content) => attempt("create", () => core.create(root, { title, content })),
      rename: (root, key, newKey) => attempt("rename", () => core.rename(root, key, newKey)),
      complete: (root, key, text, line, character) => attempt("complete", () => core.complete(root, key, text, line, character)),
      renameLink: (root, key, text, line, character, newName) => attempt("renameLink", () => core.renameLink(root, key, text, line, character, newName)),
      run: (name, work) => attempt(name, () => work(core)),
    });
  }),
);

/** The project folder of a thread, which may itself be an IWE workspace. */
export const threadProjectRoot = Effect.fn("IweService.threadProjectRoot")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null) return null;
  const project = yield* projects.getById(shell.projectId as ProjectId).pipe(Effect.orElseSucceed(() => Option.none()));
  return shell.worktreePath ?? Option.getOrNull(Option.map(project, (value) => value.workspaceRoot));
});
