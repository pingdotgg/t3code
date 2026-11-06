import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
        yield* fs.makeDirectory(dirFor(input.environmentId, input.drainId), { recursive: true });
        yield* fs.writeFileString(
          fileFor(input.environmentId, input.drainId, input.threadId),
          input.body,
        );
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
            readonly threads?: ReadonlyArray<{
              readonly id?: string;
              readonly threadId?: string;
            }>;
            readonly projects?: ReadonlyArray<{
              readonly workspaceRoot?: string;
              readonly path?: string;
            }>;
          };
          return {
            threads: (shell.threads ?? []).flatMap((thread) => {
              const threadId = thread.threadId ?? thread.id;
              return threadId === undefined ? [] : [{ threadId }];
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
      const [snapshot, history] = yield* Effect.all(
        [
          getJson(request.environmentId, `/api/orchestration/threads/${encoded}/bounded`),
          getJson(
            request.environmentId,
            `/api/orchestration/threads/${encoded}/history?limit=100000`,
          ),
        ],
        { concurrency: 2 },
      );
      const body = yield* toJsonBody({ threadId: request.threadId, snapshot, history }).pipe(
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
    input.exec(sandboxName, ["git", "-C", workspaceRoot, "push", "--all", "--force-with-lease"]),
});
