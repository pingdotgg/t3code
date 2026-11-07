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
  type DrainSinkRecord,
  type DrainSource,
} from "./OpenShellFleetDrain.ts";

const encode = (value: string) => encodeURIComponent(value);

/** Percent-encoding is collision-free ("thread:a" keeps its %3A, so "threada"
 * stays distinct, and "thread/b" cannot hop directories because its "/" becomes
 * %2F), so the encoding survives whole: refuse only empty names and the relative
 * hops "." and "..", which encode to themselves. */
const segmentOf = (value: string): string | null => {
  const encoded = encodeURIComponent(value);
  return encoded === "" || encoded === "." || encoded === ".." ? null : encoded;
};

const decodeEnvelope = (raw: string): DrainSinkRecord | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<DrainSinkRecord>;
    if (typeof parsed.threadId !== "string" || typeof parsed.body !== "string") return null;
    return {
      threadId: parsed.threadId,
      snapshotSequence:
        typeof parsed.snapshotSequence === "number" ? parsed.snapshotSequence : null,
      body: parsed.body,
    };
  } catch {
    return null;
  }
};

const toEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      snapshotSequence: Schema.NullOr(Schema.Number),
      body: Schema.String,
    }),
  ),
);

/** `stateDir/fleet-drain/<environment>/<drainId>/thread-<id>.json`. */
export const fileDrainSink = (input: {
  readonly stateDir: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}): DrainSink => {
  const { fs, path, stateDir } = input;
  return {
    write: Effect.fn("DrainSink.write")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly drainId: string;
        readonly threadId: string;
        readonly body: string;
        readonly snapshotSequence: number | null;
      }) {
        const environment = segmentOf(input.environmentId);
        const drain = segmentOf(input.drainId);
        const thread = segmentOf(input.threadId);
        if (environment === null || drain === null || thread === null) {
          return yield* new FleetDrainStepError({
            step: "write",
            message: `Refused a drain path segment for ${input.environmentId} / ${input.drainId} / ${input.threadId}.`,
          });
        }
        const dir = path.join(stateDir, "fleet-drain", environment, drain);
        const target = path.join(dir, `thread-${thread}.json`);
        yield* fs.makeDirectory(dir, { recursive: true });
        // Write then rename: a retry must never accept a half-written copy as done.
        const envelope = yield* toEnvelope({
          threadId: input.threadId,
          snapshotSequence: input.snapshotSequence,
          body: input.body,
        });
        yield* fs.writeFileString(`${target}.partial`, envelope);
        yield* fs.rename(`${target}.partial`, target);
        return { bytes: new TextEncoder().encode(envelope).byteLength };
      },
      Effect.mapError(
        (cause) => new FleetDrainStepError({ step: "write", message: String(cause) }),
      ),
    ),
    read: Effect.fn("DrainSink.read")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly drainId: string;
        readonly threadId: string;
      }) {
        const environment = segmentOf(input.environmentId);
        const drain = segmentOf(input.drainId);
        const thread = segmentOf(input.threadId);
        if (environment === null || drain === null || thread === null) {
          return yield* new FleetDrainStepError({
            step: "read",
            message: `Refused a drain path segment for ${input.environmentId} / ${input.drainId} / ${input.threadId}.`,
          });
        }
        const file = path.join(
          stateDir,
          "fleet-drain",
          environment,
          drain,
          `thread-${thread}.json`,
        );
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
        return raw === null ? null : decodeEnvelope(raw);
      },
      Effect.mapError((cause) => new FleetDrainStepError({ step: "read", message: String(cause) })),
    ),
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
    threadSequence: (request) =>
      getJson(
        request.environmentId,
        `/api/orchestration/threads/${encode(request.threadId)}/bounded`,
      ).pipe(
        Effect.map((snapshot) => ({
          snapshotSequence:
            typeof (snapshot as { snapshotSequence?: unknown }).snapshotSequence === "number"
              ? (snapshot as { snapshotSequence: number }).snapshotSequence
              : null,
        })),
      ),
    threadHistory: Effect.fn("DrainSource.threadHistory")(function* (request: {
      readonly environmentId: EnvironmentId;
      readonly threadId: string;
    }) {
      const encoded = encode(request.threadId);
      const snapshot = (yield* getJson(
        request.environmentId,
        `/api/orchestration/threads/${encoded}/bounded`,
      )) as {
        readonly snapshotSequence?: unknown;
        readonly historyCursor?: string | null;
        readonly hasMoreHistory?: boolean;
      };
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
      return {
        body,
        snapshotSequence:
          typeof snapshot.snapshotSequence === "number" ? snapshot.snapshotSequence : null,
      };
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
