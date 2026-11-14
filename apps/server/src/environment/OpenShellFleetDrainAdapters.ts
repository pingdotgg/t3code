import {
  isLiveSubagentShell,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

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
  type DrainAttachmentManifestEntry,
  type DrainAttachments,
  type DrainGitBundle,
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
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(
          (entry): entry is DrainAttachmentManifestEntry =>
            typeof entry?.name === "string" &&
            typeof entry?.hash === "string" &&
            typeof entry?.size === "number",
        )
      : undefined;
    return {
      threadId: parsed.threadId,
      snapshotSequence:
        typeof parsed.snapshotSequence === "number" ? parsed.snapshotSequence : null,
      body: parsed.body,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(parsed.attachmentsSkipped === true ? { attachmentsSkipped: true } : {}),
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
      attachments: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ name: Schema.String, hash: Schema.String, size: Schema.Number }),
        ),
      ),
      attachmentsSkipped: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/** `stateDir/fleet-drain/<environment>/<drainId>/thread-<id>.json`. */
export const fileDrainSink = Effect.fn("DrainSink.make")(function* (input: {
  readonly stateDir: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { fs, path, stateDir } = input;
  // Attachment hashes come from the digest service; the sink is built once
  // per drain and carries it.
  const digest = yield* Digest.Digest;
  return {
    write: Effect.fn("DrainSink.write")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly drainId: string;
        readonly threadId: string;
        readonly body: string;
        readonly snapshotSequence: number | null;
        readonly attachments?: DrainAttachments;
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
        // Attachments land as sibling files so the manifest in the envelope stays
        // small; the hash keys the file name and is what read-back verifies.
        const manifest: Array<DrainAttachmentManifestEntry> = [];
        for (const file of input.attachments?.files ?? []) {
          const decoded = Base64.decode(file.bytes.replace(/\s/g, ""));
          if (Result.isFailure(decoded)) {
            return yield* new FleetDrainStepError({
              step: "write",
              message: `Attachment ${file.name} was not valid base64.`,
            });
          }
          const bytes = decoded.success;
          const hash = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
          yield* fs.writeFile(
            path.join(dir, `thread-${thread}-att-${hash.slice(0, 16)}.bin`),
            bytes,
          );
          manifest.push({ name: file.name, hash, size: bytes.byteLength });
        }
        // Write then rename: a retry must never accept a half-written copy as done.
        const envelope = yield* toEnvelope({
          threadId: input.threadId,
          snapshotSequence: input.snapshotSequence,
          body: input.body,
          ...(manifest.length === 0 ? {} : { attachments: manifest }),
          ...(input.attachments?.oversizeSkipped === true ? { attachmentsSkipped: true } : {}),
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
        if (raw === null) return null;
        const record = decodeEnvelope(raw);
        if (record === null) return null;
        // A manifest without its bytes is not a copy: verify each hash so a
        // corrupted attachment fails the ack instead of being imported later.
        for (const entry of record.attachments ?? []) {
          const bytes = yield* fs
            .readFile(
              path.join(path.dirname(file), `thread-${thread}-att-${entry.hash.slice(0, 16)}.bin`),
            )
            .pipe(Effect.orElseSucceed(() => null));
          if (bytes === null) return null;
          if (Hex.encode(yield* digest.digest(Digest.sha256, bytes)) !== entry.hash) return null;
        }
        return record;
      },
      Effect.mapError((cause) => new FleetDrainStepError({ step: "read", message: String(cause) })),
    ),
    copy: Effect.fn("DrainSink.copy")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly fromDrainId: string;
        readonly toDrainId: string;
        readonly threadId: string;
      }) {
        const environment = segmentOf(input.environmentId);
        const from = segmentOf(input.fromDrainId);
        const to = segmentOf(input.toDrainId);
        const thread = segmentOf(input.threadId);
        const fromDir =
          environment === null || from === null
            ? null
            : path.join(stateDir, "fleet-drain", environment, from);
        const toDir =
          environment === null || to === null
            ? null
            : path.join(stateDir, "fleet-drain", environment, to);
        if (fromDir === null || toDir === null || thread === null)
          return yield* new FleetDrainStepError({
            step: "write",
            message: `Refused a drain path segment for ${input.fromDrainId} / ${input.toDrainId}.`,
          });
        const name = `thread-${thread}.json`;
        const raw = yield* fs
          .readFileString(path.join(fromDir, name))
          .pipe(Effect.orElseSucceed(() => null));
        const record = raw === null ? null : decodeEnvelope(raw);
        if (record === null || raw === null) return false;
        yield* fs.makeDirectory(toDir, { recursive: true });
        // Attachment files are keyed by the manifest hash, so they travel with it.
        for (const entry of record.attachments ?? []) {
          const attachment = `thread-${thread}-att-${entry.hash.slice(0, 16)}.bin`;
          const bytes = yield* fs.readFile(path.join(fromDir, attachment)).pipe(
            Effect.mapError(
              (cause) =>
                new FleetDrainStepError({
                  step: "write",
                  message: `Attachment copy failed: ${cause}`,
                }),
            ),
          );
          yield* fs.writeFile(path.join(toDir, attachment), bytes).pipe(
            Effect.mapError(
              (cause) =>
                new FleetDrainStepError({
                  step: "write",
                  message: `Attachment copy failed: ${cause}`,
                }),
            ),
          );
        }
        yield* fs.writeFileString(`${path.join(toDir, name)}.partial`, raw);
        yield* fs.rename(`${path.join(toDir, name)}.partial`, path.join(toDir, name));
        return true;
      },
      Effect.mapError(
        (cause) => new FleetDrainStepError({ step: "write", message: String(cause) }),
      ),
    ),
  } satisfies DrainSink;
}, Effect.provide(Digest.layerWebCrypto));

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
        http.get(new URL(path, link.url).toString(), {
          // The orchestration endpoints require the protocol header; without it
          // the worker answers 400 and the drain would look empty.
          headers: {
            authorization: `Bearer ${link.token}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
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
      // Archived threads are drainable data: the worker lists them only on request.
      getJson(environmentId, "/api/orchestration/shell?includeArchived=1").pipe(
        Effect.flatMap((snapshot) =>
          Effect.gen(function* () {
            const shell = snapshot as {
              readonly threads?: ReadonlyArray<DrainShellThread>;
              readonly archivedThreads?: ReadonlyArray<DrainShellThread>;
              readonly projects?: ReadonlyArray<{
                readonly workspaceRoot?: string;
                readonly path?: string;
              }>;
            };
            // A body without both lists is an incomplete answer, not an empty
            // worker: an empty ack here would delete unconverted threads.
            if (!Array.isArray(shell.threads) || !Array.isArray(shell.projects))
              return yield* new FleetDrainStepError({
                step: "shell",
                message: "The worker's shell response is incomplete; nothing was acknowledged.",
              });
            const shellThreads = [...shell.threads, ...(shell.archivedThreads ?? [])];
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

/** Total decoded bundle bytes a checkout may export before the drain refuses it. */
const MAX_DRAIN_BUNDLE_BYTES = 256 * 1024 * 1024;

/** Exports a worker checkout and its checkpoint refs from inside the sandbox. */
export const execDrainGitBundle = (input: {
  readonly exec: (
    sandboxName: string,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    FleetDrainStepError
  >;
  /** Overridden in tests; the production cap keeps one drain off the OOM path. */
  readonly maxBytes?: number;
}): DrainGitBundle => ({
  bundle: Effect.fn("FleetDrainGitBundle.bundle")(
    // A worker cannot push: its origin is the read-only shared mirror, it holds
    // no credentials, and a branch behind origin rejects a push anyway. A
    // bundle carries the refs (branches and the refs/t3 checkpoints holding
    // uncommitted work) the mirror lacks, base64 so exec stdout stays text.
    ({ sandboxName, workspaceRoot }) =>
      Effect.gen(function* () {
        const maxBytes = input.maxBytes ?? MAX_DRAIN_BUNDLE_BYTES;
        const root = shellQuote(workspaceRoot);
        const revs = `HEAD --branches --glob='refs/t3/*'`;
        const exported = yield* input.exec(sandboxName, [
          "sh",
          "-c",
          // HEAD carries a detached commit; subtract only origin, so a commit
          // fetched from another remote is not a missing prerequisite.
          // An empty export means the mirror has everything and acks.
          `b="\${TMPDIR:-/tmp}/t3-fleet-drain-$$.bundle"; ` +
            `if [ "$(git -C ${root} rev-list --count ${revs} --not --remotes=origin)" -eq 0 ]; then exit 0; fi; ` +
            `git -C ${root} bundle create "$b" ${revs} --not --remotes=origin || exit $?; ` +
            // The cap is checked before base64, so an oversized bundle never
            // crosses exec as one string.
            // shortcut: without origin remote-tracking refs there is no
            // baseline, so a large checkout needs force removal.
            `if [ "$(wc -c <"$b" | tr -d '[:space:]')" -gt ${maxBytes} ]; then rm -f "$b"; exit 4; fi; ` +
            `base64 "$b"; rc=$?; rm -f "$b"; exit $rc`,
        ]);
        if (exported.exitCode === 4)
          return yield* new FleetDrainStepError({
            step: "bundle",
            message: `The checkout bundle of ${workspaceRoot} exceeds the drain size cap.`,
          });
        return exported;
      }),
  ),
});

/** Single-quotes a value for a shell command line. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Total decoded attachment bytes drained per thread before skipping the set. */
const MAX_DRAIN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Marks one attachment file's name and size on the listing command's stdout. */
const ATTACHMENT_LIST_FRAME = "==T3ATTL ";

/**
 * Attachment files over gateway exec (the worker's HTTP API serves no
 * attachment bytes): the worker lists the thread's files with their sizes
 * first, so an oversized set is skipped before any bytes cross exec, then each
 * file is read on its own. Files live flat as `<thread-segment>-<uuid><ext>`.
 */
export const execDrainAttachments = (input: {
  readonly exec: (
    sandboxName: string,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    FleetDrainStepError
  >;
  readonly maxBytes?: number;
}): NonNullable<DrainSource["attachments"]> => {
  const maxBytes = input.maxBytes ?? MAX_DRAIN_ATTACHMENT_BYTES;
  const attachmentsDir = `"\${T3CODE_HOME:-$HOME/.t3}/userdata/attachments"`;
  const listCommand = (segment: string) => [
    "sh",
    "-c",
    `d=${attachmentsDir}; if [ -d "$d" ]; then for f in "$d"/${segment}-*; do ` +
      `[ -f "$f" ] || continue; case "$f" in *.part) continue;; esac; ` +
      `printf '%s\\n' "${ATTACHMENT_LIST_FRAME}$(basename "$f") $(wc -c <"$f" | tr -d '[:space:]')"; ` +
      `done; fi`,
  ];
  const readCommand = (name: string) => [
    "sh",
    "-c",
    `base64 ${attachmentsDir}/${shellQuote(name)}`,
  ];
  return ({ sandboxName, threadId }) =>
    Effect.gen(function* () {
      const segment = toSafeThreadAttachmentSegment(threadId);
      if (segment === null) return { files: [], oversizeSkipped: false } as const;
      const listed = yield* input.exec(sandboxName, listCommand(segment));
      if (listed.exitCode !== 0) {
        return yield* new FleetDrainStepError({
          step: "attachments",
          message: `The worker did not list attachments for ${threadId} (exit ${listed.exitCode}).`,
        });
      }
      const entries: Array<{ name: string; size: number }> = [];
      for (const line of listed.stdout.split("\n")) {
        if (!line.startsWith(ATTACHMENT_LIST_FRAME)) continue;
        const rest = line.slice(ATTACHMENT_LIST_FRAME.length).trim();
        const separator = rest.lastIndexOf(" ");
        if (separator <= 0) continue;
        const name = rest.slice(0, separator);
        const size = Number(rest.slice(separator + 1));
        // The worker names files itself; anything else is not one of this thread's.
        if (!name.startsWith(`${segment}-`)) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
        if (!Number.isSafeInteger(size) || size < 0) continue;
        entries.push({ name, size });
      }
      if (entries.reduce((total, entry) => total + entry.size, 0) > maxBytes) {
        return { files: [], oversizeSkipped: true } as const;
      }
      const files: Array<{ name: string; bytes: string }> = [];
      for (const entry of entries) {
        const read = yield* input.exec(sandboxName, readCommand(entry.name));
        if (read.exitCode !== 0) {
          return yield* new FleetDrainStepError({
            step: "attachments",
            message: `The worker did not read attachment ${entry.name} of ${threadId} (exit ${read.exitCode}).`,
          });
        }
        files.push({ name: entry.name, bytes: read.stdout });
      }
      return { files, oversizeSkipped: false } as const;
    });
};
