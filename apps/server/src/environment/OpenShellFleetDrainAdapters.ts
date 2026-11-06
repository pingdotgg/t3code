import { isLiveSubagentShell, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The parts of a worker's thread shell that decide whether it is still working. */
interface DrainShellThread {
  readonly id?: string;
  readonly threadId?: string;
  readonly status?: string;
  readonly activityRunStatus?: string | null;
  readonly pendingRuntimeRequest?: unknown;
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown> | null;
}

import {
  FleetDrainStepError,
  type DrainGitPush,
  type DrainSink,
  type DrainSource,
} from "./OpenShellFleetDrain.ts";

const encode = (value: string) => encodeURIComponent(value);

/** `stateDir/fleet-drain/<environment>/<drainId>/thread-<id>.json`. */
export const fileDrainSink = (input: {
  readonly stateDir: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}): DrainSink => {
  const { fs, path, stateDir } = input;
  const dirFor = (environmentId: EnvironmentId, drainId: string) =>
    path.join(stateDir, "fleet-drain", encode(environmentId), encode(drainId));
  const fileFor = (environmentId: EnvironmentId, drainId: string, threadId: string) =>
    path.join(dirFor(environmentId, drainId), `thread-${encode(threadId)}.json`);
  return {
    write: (input) =>
      Effect.fn("DrainSink.write")(function* (input: {
        readonly environmentId: EnvironmentId;
        readonly drainId: string;
        readonly threadId: string;
        readonly body: string;
      }) {
        const target = fileFor(input.environmentId, input.drainId, input.threadId);
        yield* fs.makeDirectory(dirFor(input.environmentId, input.drainId), { recursive: true });
        // Write then rename: a retry must never accept a half-written copy as done.
        yield* fs.writeFileString(`${target}.partial`, input.body);
        yield* fs.rename(`${target}.partial`, target);
        return { bytes: new TextEncoder().encode(input.body).byteLength };
      })(input).pipe(
        Effect.mapError(
          (cause) => new FleetDrainStepError({ step: "write", message: String(cause) }),
        ),
      ),
    read: (input) =>
      fs
        .readFileString(fileFor(input.environmentId, input.drainId, input.threadId))
        .pipe(Effect.orElseSucceed(() => null)),
  };
};

const toJsonBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fromJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Reads the worker over its authenticated link: the shell snapshot lists what it
 * holds, and each thread's bounded snapshot plus history is the lossless copy.
 */
export const linkDrainSource = (input: {
  readonly resolve: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<{ readonly url: string; readonly token: string }, FleetDrainStepError>;
  readonly http: HttpClient.HttpClient;
}): DrainSource => {
  const http = input.http;
  const getJson = (environmentId: EnvironmentId, path: string) =>
    input.resolve(environmentId).pipe(
      Effect.flatMap((link) =>
        http.get(new URL(path, link.url), {
          headers: { authorization: `Bearer ${link.token}` },
        }),
      ),
      Effect.mapError(
        (cause) => new FleetDrainStepError({ step: "history", message: String(cause) }),
      ),
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.mapError(
            (cause) => new FleetDrainStepError({ step: "history", message: String(cause) }),
          ),
          Effect.flatMap((body) =>
            response.status < 200 || response.status >= 300
              ? Effect.fail(
                  new FleetDrainStepError({
                    step: "history",
                    message: `The worker answered ${response.status} for ${path}.`,
                  }),
                )
              : fromJsonBody(body).pipe(
                  Effect.mapError(
                    (cause) => new FleetDrainStepError({ step: "history", message: String(cause) }),
                  ),
                ),
          ),
        ),
      ),
    );
  return {
    shell: (environmentId) =>
      getJson(environmentId, "/api/orchestration/shell").pipe(
        Effect.map((snapshot) => {
          const shell = snapshot as {
            readonly threads?: ReadonlyArray<DrainShellThread>;
            readonly archivedThreads?: ReadonlyArray<DrainShellThread>;
            readonly projects?: ReadonlyArray<{
              readonly workspaceRoot?: string;
              readonly path?: string;
            }>;
          };
          const shellThreads = [...(shell.threads ?? []), ...(shell.archivedThreads ?? [])];
          return {
            threads: shellThreads.flatMap((thread) => {
              const threadId = thread.threadId ?? thread.id;
              if (threadId === undefined) return [];
              // Liveness comes from the shell's own status, and an unreadable one
              // counts as live: removing a worker that is still writing loses work.
              const live =
                thread.status === undefined && thread.activityRunStatus === undefined
                  ? true
                  : isLiveSubagentShell({
                      status: thread.status ?? "idle",
                      activityRunStatus: thread.activityRunStatus ?? null,
                      pendingRuntimeRequest: thread.pendingRuntimeRequest ?? null,
                      pendingBackgroundTasks: thread.pendingBackgroundTasks ?? null,
                    } as never);
              return [{ threadId, live }];
            }),
            projects: (shell.projects ?? []).flatMap((project) => {
              const workspaceRoot = project.workspaceRoot ?? project.path;
              return workspaceRoot === undefined ? [] : [{ workspaceRoot }];
            }),
          };
        }),
      ),
    threadHistory: Effect.fn("DrainSource.threadHistory")(function* (request: {
      readonly environmentId: EnvironmentId;
      readonly threadId: string;
    }) {
      const encoded = encode(request.threadId);
      const snapshot = (yield* getJson(
        request.environmentId,
        `/api/orchestration/threads/${encoded}/bounded`,
      )) as { readonly historyCursor?: string | null; readonly hasMoreHistory?: boolean };
      // The page endpoint needs the worker's own cursor: a page size is rejected,
      // and a truncated history is not a drain (spec section 7.2).
      const pages: unknown[] = [];
      let cursor = snapshot.historyCursor ?? null;
      let hasMore = snapshot.hasMoreHistory === true;
      while (hasMore && cursor !== null) {
        const page = (yield* getJson(
          request.environmentId,
          `/api/orchestration/threads/${encoded}/history?cursor=${encode(cursor)}`,
        )) as { readonly nextCursor?: string | null; readonly hasMoreHistory?: boolean };
        pages.push(page);
        hasMore = page.hasMoreHistory === true;
        cursor = page.nextCursor ?? null;
      }
      const body = yield* toJsonBody({ threadId: request.threadId, snapshot, pages }).pipe(
        Effect.mapError(
          (cause) => new FleetDrainStepError({ step: "history", message: String(cause) }),
        ),
      );
      return { body };
    }),
  };
};

/** Pushes a worker checkout and its checkpoint refs from inside the sandbox. */
export const execDrainGitPush = (input: {
  readonly exec: (
    sandboxName: string,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    FleetDrainStepError
  >;
}): DrainGitPush => ({
  push: ({ sandboxName, workspaceRoot }) =>
    // Branches alone are not the work: checkpoints under refs/t3 hold uncommitted
    // state, so both namespaces are pushed explicitly.
    input.exec(sandboxName, [
      "git",
      "-C",
      workspaceRoot,
      "push",
      "origin",
      "refs/heads/*:refs/heads/*",
      "refs/t3/*:refs/t3/*",
    ]),
});
