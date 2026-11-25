import {
  AcpRegistryListSessionsResult,
  AcpRegistryOperationError,
  type AcpRegistrySession,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ompProtocolError, openOmpRpc, record, string } from "./rpc.ts";

const pageSize = 40;
const sessionFilename = /^\d{4}-\d{2}-\d{2}T[\dZ:.-]+_[\da-f-]{36}\.jsonl$/iu;
const decodeRecord = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const decodeHeader = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("session"),
      id: Schema.String,
      cwd: Schema.String,
      title: Schema.optional(Schema.String),
    }),
  ),
);

export const makeOmpSessionCatalog = Effect.fn("OmpSessionCatalog.make")(function* (options: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directoryFor = Effect.fnUntraced(
    function* (cwd: string) {
      const rpc = yield* openOmpRpc({
        ...options,
        cwd,
        args: ["--mode", "rpc", "--no-tools", "--no-extensions"],
      });
      const file = string(record(yield* rpc.request({ type: "get_state" })).sessionFile);
      if (!file || !path.isAbsolute(file))
        return yield* ompProtocolError("Oh My Pi did not report a session directory.");
      const directory = path.dirname(file);
      return {
        directory,
        realDirectory: yield* fs.realPath(directory),
        cwd: yield* fs.realPath(cwd),
      };
    },
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("8 seconds"),
    Effect.mapError(
      (cause) =>
        new AcpRegistryOperationError({
          reason: "session_list_unsupported",
          message: "Could not locate Oh My Pi sessions for this project.",
          cause,
        }),
    ),
  );

  const readSession = Effect.fnUntraced(
    function* (root: Effect.Success<ReturnType<typeof directoryFor>>, name: string) {
      const sessionId = path.join(root.directory, name);
      if (sessionId.length > 1024) return;
      const absolute = path.join(root.realDirectory, name);
      if ((yield* fs.realPath(absolute)) !== absolute) return;
      const info = yield* fs.stat(absolute);
      if (info.type !== "File") return;
      const file = yield* fs.open(absolute, {
        flag: "r",
        ...(platform === "win32" ? {} : { noFollow: true }),
      });
      const head = new Uint8Array(16 * 1024);
      const bytes = yield* file.read(head);
      const prefix = head.subarray(0, bytes);
      const firstEnd = prefix.indexOf(10);
      if (firstEnd < 0) return;
      const decoder = new TextDecoder();
      const firstLine = decoder.decode(prefix.subarray(0, firstEnd));
      const first = decodeRecord(firstLine);
      const slot = first._tag === "Some" ? record(first.value) : {};
      const titleSlot = slot.type === "title";
      const headerStart = titleSlot ? firstEnd + 1 : 0;
      const headerEnd = titleSlot ? prefix.indexOf(10, headerStart) : firstEnd;
      if (headerEnd < 0 || !prefix.subarray(headerEnd + 1).some((byte) => byte > 32)) return;
      const read = decodeHeader(
        titleSlot ? decoder.decode(prefix.subarray(headerStart, headerEnd)) : firstLine,
      );
      if (read._tag === "None") return;
      const header = read.value;
      if (
        !name.toLowerCase().endsWith(`_${header.id.toLowerCase()}.jsonl`) ||
        !path.isAbsolute(header.cwd)
      )
        return;
      if ((yield* fs.realPath(header.cwd)) !== root.cwd) return;
      return {
        sessionId,
        cwd: root.cwd,
        title: (titleSlot ? string(slot.title) : header.title)?.trim().slice(0, 1024) || null,
        updatedAt:
          info.mtime._tag === "Some"
            ? DateTime.formatIso(DateTime.makeUnsafe(info.mtime.value))
            : null,
        additionalDirectories: [],
        importedThreadId: null,
      } satisfies AcpRegistrySession;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );

  return {
    listSessions: Effect.fn("OmpSessionCatalog.listSessions")(function* ({
      cwd,
      cursor,
    }: {
      cwd: string;
      cursor?: string;
    }) {
      const root = yield* directoryFor(cwd);
      const entries = yield* fs.readDirectoryEntries(root.realDirectory).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_list_unsupported",
              message: "Could not read the Oh My Pi session directory.",
              cause,
            }),
        ),
      );
      const candidates = entries
        .filter(
          (entry) =>
            entry.type === "File" &&
            sessionFilename.test(entry.name) &&
            (cursor === undefined || entry.name < cursor),
        )
        .map((entry) => entry.name)
        .sort()
        .reverse();
      const page = candidates.slice(0, pageSize);
      const sessions = yield* Effect.forEach(page, (name) => readSession(root, name), {
        concurrency: 8,
      });
      return AcpRegistryListSessionsResult.make({
        sessions: sessions.filter((value) => value !== undefined),
        nextCursor: candidates.length > page.length ? (page.at(-1) ?? null) : null,
        canLoad: true,
        canResume: true,
        canDelete: false,
      });
    }),
    validateSession: Effect.fn("OmpSessionCatalog.validateSession")(function* ({
      cwd,
      sessionId,
    }: {
      cwd: string;
      sessionId: string;
    }) {
      const root = yield* directoryFor(cwd);
      const name = path.basename(sessionId);
      if (
        sessionFilename.test(name) &&
        sessionId === path.join(root.directory, name) &&
        (yield* readSession(root, name))
      )
        return;
      return yield* new AcpRegistryOperationError({
        reason: "session_import_failed",
        message: "This Oh My Pi session is unavailable in the selected project.",
      });
    }),
  };
});
