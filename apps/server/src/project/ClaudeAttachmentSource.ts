import { findClaudeTranscripts } from "../provider/Drivers/ClaudeTranscript.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off - this adapter owns positional reads on one open descriptor.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - native paths are used inside the filesystem adapter.
import * as NodePath from "node:path";
import {
  makePosixProcessTreeController,
  terminatePosixOwnedProcessTree,
} from "@t3tools/shared/posixProcessTree";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Session = Schema.Struct({
  procStart: Schema.optional(Schema.String),
  messagingSocketPath: Schema.optional(Schema.String),
  pid: Schema.Int,
  sessionId: Schema.String,
  cwd: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(Session));
const liveOwners = async (home: string, platform: NodeJS.Platform) => {
  const directory = NodePath.join(home, "sessions");
  const names = await NodeFSP.readdir(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return [];
    throw cause;
  });
  const controller = platform === "linux" ? makePosixProcessTreeController(platform) : undefined;
  const owners: Array<typeof Session.Type> = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let session;
    try {
      session = decodeSession(await NodeFSP.readFile(NodePath.join(directory, name), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    if (session.pid <= 0) throw new Error("Invalid session owner");
    try {
      process.kill(session.pid, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw cause;
    }
    if (controller) {
      const identity = controller.identity(session.pid);
      if (!identity) throw new Error("Cannot verify live process identity");
      if (identity.state === "Z" || (session.procStart && identity.startTime !== session.procStart))
        continue;
    }
    owners.push(session);
  }
  return owners;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const agentFile = /^agent-([a-zA-Z0-9_-]+)\.jsonl$/;
const CHUNK_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class ClaudeAttachmentSourceError extends Schema.TaggedError<ClaudeAttachmentSourceError>()(
  "ClaudeAttachmentSourceError",
  {
    operation: Schema.Literals(["discover", "read", "subagents", "handoff"]),
    reason: Schema.optional(
      Schema.Literals(["running", "unsupported-interruption", "interruption-failed"]),
    ),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    if (this.reason === "unsupported-interruption")
      return "Automatic interruption requires Linux process identity verification. Exit the source CLI and its agents, then use --wait.";
    if (this.reason === "interruption-failed")
      return "Could not stop the verified source process tree. The conversation has not transferred. Check the source CLI before retrying handoff.";
    if (this.operation === "handoff")
      return "Handoff requires the original Claude session to have exited after its agents finish. T3 will not stop a process based on transcript inactivity.";
    return `Could not ${this.operation} the Claude session. Check that it is running locally and its transcript is readable.`;
  }
}

const isSourceError = Schema.is(ClaudeAttachmentSourceError);

export interface TranscriptCursor {
  offset: number;
  identity?: string | undefined;
}
export class ClaudeAttachmentSource extends Context.Service<
  ClaudeAttachmentSource,
  {
    readonly interrupt: (
      home: string,
      sessionId: string,
      options?: { readonly verifyOnly: true },
    ) => Effect.Effect<void, ClaudeAttachmentSourceError>;
    readonly assertStopped: (
      home: string,
      sessionId: string,
    ) => Effect.Effect<void, ClaudeAttachmentSourceError>;
    readonly tail: (
      home: string,
      path: string,
    ) => Effect.Effect<
      {
        lines: ReadonlyArray<string>;
        offset: number;
        size: number;
        modifiedAt: number;
        identity?: string;
      },
      ClaudeAttachmentSourceError
    >;
    readonly discover: (
      home: string,
      query: string,
    ) => Effect.Effect<
      {
        sessionId: string;
        title: string;
        transcriptPath: string;
      },
      ClaudeAttachmentSourceError
    >;
    readonly children: (
      home: string,
      transcript: string,
    ) => Effect.Effect<
      ReadonlyArray<{ agentId: string; path: string }>,
      ClaudeAttachmentSourceError
    >;
    readonly read: (
      home: string,
      path: string,
      cursor: TranscriptCursor,
    ) => Effect.Effect<
      {
        cursor: TranscriptCursor;
        lines: ReadonlyArray<string>;
        caughtUp: boolean;
      },
      ClaudeAttachmentSourceError
    >;
  }
>()("t3/project/ClaudeAttachmentSource") {}

// Resolve both sides on every read: a replaced symlink must not escape the transcript directory.
async function checkedPath(home: string, file: string) {
  const root = await NodeFSP.realpath(NodePath.join(home, "projects"));
  const actual = await NodeFSP.realpath(file);
  const relative = NodePath.relative(root, actual);
  if (
    !relative ||
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("Transcript is outside Claude projects");
  }
  return actual;
}

export const layer = Layer.sync(ClaudeAttachmentSource, () => {
  const tailCache = new Map<
    string,
    {
      stamp: string;
      result: {
        lines: string[];
        offset: number;
        size: number;
        modifiedAt: number;
        identity: string;
      };
    }
  >();

  return ClaudeAttachmentSource.of({
    interrupt: Effect.fn("ClaudeAttachmentSource.interrupt")(function* (home, sessionId, options) {
      const platform = yield* HostProcess.Platform;
      if (platform !== "linux")
        return yield* new ClaudeAttachmentSourceError({
          operation: "handoff",
          reason: "unsupported-interruption",
          cause: "Unsupported process identity verification",
        });
      const owners = yield* Effect.tryPromise({
        try: async () => {
          const controller = makePosixProcessTreeController(platform);
          const owners = [];
          for (const session of await liveOwners(home, platform)) {
            if (session.sessionId !== sessionId) continue;
            if (!session.procStart || session.pid <= 1 || session.pid === process.pid)
              throw new Error("Cannot verify source process identity");
            const identity = controller.identity(session.pid);
            if (!identity || identity.startTime !== session.procStart) continue;
            const parent = controller.identity(identity.ppid);
            if (!parent) throw new Error("Cannot verify source parent identity");
            owners.push({
              controller,
              rootPid: session.pid,
              root: {
                value: {
                  ...identity,
                  parentStartTime: parent.startTime,
                  parentExecutable: parent.executable,
                },
              },
            });
          }
          return owners;
        },
        catch: (cause) =>
          new ClaudeAttachmentSourceError({
            operation: "handoff",
            reason: "interruption-failed",
            cause,
          }),
      });
      if (options?.verifyOnly) return;
      for (const owner of owners) {
        const identity = owner.root.value;
        const ledger = new Map([[`${identity.pid}:${identity.startTime}`, identity]]);
        yield* terminatePosixOwnedProcessTree({ ...owner, ledger, grace: "5 seconds" }).pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeAttachmentSourceError({
                operation: "handoff",
                reason: "interruption-failed",
                cause,
              }),
          ),
        );
      }
    }),
    assertStopped: Effect.fn("ClaudeAttachmentSource.assertStopped")(function* (home, sessionId) {
      const platform = yield* HostProcess.Platform;
      return yield* Effect.tryPromise({
        try: async () => {
          if ((await liveOwners(home, platform)).some((session) => session.sessionId === sessionId))
            throw new ClaudeAttachmentSourceError({
              operation: "handoff",
              reason: "running",
              cause: "The original session still has a live owner",
            });
        },
        catch: (cause) =>
          isSourceError(cause)
            ? cause
            : new ClaudeAttachmentSourceError({ operation: "handoff", cause }),
      });
    }),
    tail: Effect.fn("ClaudeAttachmentSource.tail")((home, path) =>
      Effect.tryPromise({
        try: async () => {
          const actual = await checkedPath(home, path);
          const file = await NodeFSP.open(actual, "r");
          try {
            const stat = await file.stat();
            const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
            const cached = tailCache.get(actual);
            if (cached?.stamp === stamp) return cached.result;
            const offset = Math.max(0, stat.size - 256 * 1024);
            const buffer = Buffer.alloc(stat.size - offset);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            const complete = buffer.subarray(0, bytesRead);
            const end = complete.lastIndexOf(10);
            const start = offset ? complete.indexOf(10) + 1 : 0;
            const completeLines =
              end >= start ? complete.subarray(start, end).toString("utf8").split("\n") : [];
            const omitted = completeLines.slice(0, -64);
            const result = {
              lines: completeLines.slice(-64),
              offset:
                offset +
                start +
                omitted.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0),
              identity: `${stat.dev}:${stat.ino}`,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            };
            if (tailCache.size >= 2048) tailCache.clear();
            tailCache.set(actual, { stamp, result });
            return result;
          } finally {
            await file.close();
          }
        },
        catch: (cause) => new ClaudeAttachmentSourceError({ operation: "read", cause }),
      }),
    ),
    discover: Effect.fn("ClaudeAttachmentSource.discover")((home, query) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const sessions = yield* Effect.tryPromise(() => liveOwners(home, platform));
        const matches = sessions.filter(
          (entry) => entry.sessionId === query || entry.name === query,
        );
        if (matches.length > 1) return yield* Effect.fail("Ambiguous session name" as const);
        const session = matches[0] ?? { sessionId: query, name: query };
        if (!matches.length && !uuid.test(query))
          return yield* Effect.fail("Use the exact live session name or session UUID" as const);
        const candidates = yield* findClaudeTranscripts(
          NodePath.join(home, "projects"),
          session.sessionId,
        );
        if (candidates.length !== 1)
          return yield* Effect.fail("Expected exactly one transcript for the session" as const);
        const transcriptPath = yield* Effect.tryPromise(() => checkedPath(home, candidates[0]!));
        return {
          sessionId: session.sessionId,
          title: session.name ?? session.sessionId,
          transcriptPath,
        };
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.mapError(
          (cause) => new ClaudeAttachmentSourceError({ operation: "discover", cause }),
        ),
      ),
    ),
    children: Effect.fn("ClaudeAttachmentSource.children")((home, transcript) =>
      Effect.tryPromise({
        try: async () => {
          const root = await checkedPath(home, transcript);
          const dir = NodePath.join(root.slice(0, -6), "subagents");
          let entries;
          try {
            entries = await NodeFSP.readdir(dir, { withFileTypes: true });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw cause;
          }
          return entries.flatMap((entry) => {
            const match = agentFile.exec(entry.name);
            return entry.isFile() && match
              ? [{ agentId: match[1]!, path: NodePath.join(dir, entry.name) }]
              : [];
          });
        },
        catch: (cause) => new ClaudeAttachmentSourceError({ operation: "subagents", cause }),
      }),
    ),
    read: Effect.fn("ClaudeAttachmentSource.read")((home, path, cursor) =>
      Effect.tryPromise({
        try: async () => {
          const actual = await checkedPath(home, path);
          const file = await NodeFSP.open(actual, "r");
          try {
            const stat = await file.stat();
            const identity = `${stat.dev}:${stat.ino}`;
            let offset =
              cursor.identity === identity && cursor.offset <= stat.size ? cursor.offset : 0;
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, stat.size - offset)));
            const chunks: Buffer[] = [];
            let length = 0;
            while (offset + length < stat.size) {
              const { bytesRead } = await file.read(buffer, 0, buffer.length, offset + length);
              if (bytesRead === 0) break;
              const chunk = Buffer.from(buffer.subarray(0, bytesRead));
              chunks.push(chunk);
              length += bytesRead;
              if (chunk.includes(10)) break;
              if (length >= MAX_LINE_BYTES)
                throw new Error("Transcript line exceeds the size limit");
            }
            const data = Buffer.concat(chunks, length);
            const end = data.lastIndexOf(10);
            if (end < 0) return { cursor: { offset, identity }, lines: [], caughtUp: true };
            const lines = data.subarray(0, end).toString("utf8").split("\n");
            offset += end + 1;
            return { cursor: { offset, identity }, lines, caughtUp: offset >= stat.size };
          } finally {
            await file.close();
          }
        },
        catch: (cause) => new ClaudeAttachmentSourceError({ operation: "read", cause }),
      }),
    ),
  });
});
