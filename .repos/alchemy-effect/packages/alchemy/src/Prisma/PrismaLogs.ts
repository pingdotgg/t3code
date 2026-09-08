import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { LogLine } from "../Provider.ts";
import type { PrismaManagementClient } from "./Client.ts";
import type { DeploymentLogsQuery } from "./Types.ts";

export class PrismaLogStreamError extends Data.TaggedError(
  "PrismaLogStreamError",
)<{
  message: string;
  cause?: unknown;
}> {}

interface PrismaDeploymentLogLine {
  type: "log";
  text: string;
  byteStart: number;
  byteEnd: number;
}

interface PrismaDeploymentTerminalLine {
  type: "terminal";
  kind: "end" | "error";
  code: string;
  message: string;
  retryable: boolean;
  cursor: string | null;
  details?: Record<string, unknown>;
}

export type PrismaDeploymentLogRecord =
  | PrismaDeploymentLogLine
  | PrismaDeploymentTerminalLine;

export type ParsedDeploymentLogRecord =
  | { _tag: "log"; line: LogLine; raw: PrismaDeploymentLogLine }
  | { _tag: "terminal"; raw: PrismaDeploymentTerminalLine };

const WEBSOCKET_HANDSHAKE_TIMEOUT = "10 seconds" as const;
const RECONNECT_BACKOFF_MS = 100;
const MAX_NO_PROGRESS_RECONNECTS = 3;
const LOG_QUEUE_CAPACITY = 64;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;

export const parseDeploymentLogRecord = (
  message: string,
  timestamp: Date,
): Effect.Effect<ParsedDeploymentLogRecord, PrismaLogStreamError> => {
  const byteLength = new TextEncoder().encode(message).byteLength;
  // The socket is opened with `maxPayload`, but not every runtime's `ws`
  // implementation enforces it (bun's ws shim delivers oversized frames), so
  // bound the frame here too — without retaining any of its contents.
  if (byteLength > MAX_WEBSOCKET_PAYLOAD_BYTES) {
    return Effect.fail(
      new PrismaLogStreamError({
        message: `Prisma deployment log record exceeds the ${MAX_WEBSOCKET_PAYLOAD_BYTES}-byte frame limit (${byteLength} bytes)`,
      }),
    );
  }
  let recordType: "log" | "terminal" | "unknown" | "invalid-json" =
    "invalid-json";
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(message) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        recordType = "unknown";
        throw new Error("Invalid Prisma deployment log record shape");
      }
      const raw = parsed as Partial<PrismaDeploymentLogRecord>;
      recordType =
        raw.type === "log" || raw.type === "terminal" ? raw.type : "unknown";
      if (
        raw.type === "log" &&
        typeof raw.text === "string" &&
        typeof raw.byteStart === "number" &&
        Number.isSafeInteger(raw.byteStart) &&
        raw.byteStart >= 0 &&
        typeof raw.byteEnd === "number" &&
        Number.isSafeInteger(raw.byteEnd) &&
        raw.byteEnd >= raw.byteStart
      ) {
        return {
          _tag: "log" as const,
          line: { timestamp, message: raw.text },
          raw: raw as PrismaDeploymentLogLine,
        };
      }
      if (
        raw.type === "terminal" &&
        (raw.kind === "end" || raw.kind === "error") &&
        typeof raw.code === "string" &&
        typeof raw.message === "string" &&
        typeof raw.retryable === "boolean" &&
        (raw.cursor === null || typeof raw.cursor === "string") &&
        (raw.details === undefined ||
          (raw.details !== null &&
            typeof raw.details === "object" &&
            !Array.isArray(raw.details)))
      ) {
        return {
          _tag: "terminal" as const,
          raw: raw as PrismaDeploymentTerminalLine,
        };
      }
      throw new Error("Invalid Prisma deployment log record shape");
    },
    catch: () =>
      new PrismaLogStreamError({
        message: `Failed to decode Prisma deployment log record (${byteLength} bytes; type: ${recordType})`,
      }),
  });
};

export const tailDeploymentLogs = (
  client: PrismaManagementClient,
  deploymentId: string,
  query?: DeploymentLogsQuery,
) =>
  Stream.callback<LogLine, PrismaLogStreamError>(
    (queue) =>
      Effect.gen(function* () {
        const WebSocket = yield* loadWebSocketConstructor;
        const sockets = new Set<WebSocket>();
        let latestCursor = query?.cursor;
        let latestByteEnd =
          query?.cursor !== undefined &&
          Number.isSafeInteger(Number(query.cursor)) &&
          Number(query.cursor) >= 0
            ? Number(query.cursor)
            : undefined;
        let noProgressReconnects = 0;
        let connectionCount = 0;
        let stopped = false;

        const end = () => {
          if (stopped) return;
          stopped = true;
          Queue.endUnsafe(queue);
        };
        const fail = (error: PrismaLogStreamError) => {
          if (stopped) return;
          stopped = true;
          Queue.failCauseUnsafe(queue, Cause.fail(error));
        };

        const connect = (
          cursor: string | undefined,
        ): Effect.Effect<void, PrismaLogStreamError> =>
          Effect.gen(function* () {
            if (stopped) return;
            const request = yield* client
              .getDeploymentLogsRequest(
                deploymentId,
                cursor === undefined ? query : { ...query, cursor },
              )
              .pipe(
                Effect.mapError(
                  () =>
                    new PrismaLogStreamError({
                      message:
                        "Failed to prepare the Prisma deployment log stream request",
                    }),
                ),
              );
            const auth = Redacted.value(request.headers.Authorization);
            const socket = yield* Effect.try({
              try: () =>
                new WebSocket(request.url, {
                  headers: { Authorization: auth },
                  maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
                }),
              catch: () =>
                new PrismaLogStreamError({
                  message: "Failed to open Prisma deployment log WebSocket",
                }),
            });
            if (stopped) {
              socket.close(1000, "tail stopped");
              return;
            }
            sockets.add(socket);
            const isReconnect = connectionCount > 0;
            connectionCount += 1;
            let terminalHandled = false;
            let madeProgress = false;
            let socketOpened = false;
            const connectionStartByteEnd = latestByteEnd;
            const opened = yield* Deferred.make<void, PrismaLogStreamError>();

            const scheduleReconnect = (
              reconnectCursor: string | undefined,
              code: string,
              closeMode: "close" | "terminate" | "already-closed",
            ) => {
              if (terminalHandled || stopped) return;
              terminalHandled = true;
              if (madeProgress) {
                noProgressReconnects = 0;
              } else if (isReconnect) {
                noProgressReconnects += 1;
              }
              if (noProgressReconnects >= MAX_NO_PROGRESS_RECONNECTS) {
                fail(
                  new PrismaLogStreamError({
                    message: `${code}: Prisma deployment log stream made no progress after ${MAX_NO_PROGRESS_RECONNECTS} reconnect attempts`,
                  }),
                );
                if (closeMode === "close") {
                  socket.close(1000, "reconnect progress limit reached");
                } else if (closeMode === "terminate") {
                  socket.terminate();
                }
                return;
              }
              if (closeMode === "close") {
                socket.close(1000, "reconnecting from latest log cursor");
              } else if (closeMode === "terminate") {
                socket.terminate();
              }
              Effect.runFork(
                Effect.sleep(
                  Duration.millis(
                    Math.min(
                      RECONNECT_BACKOFF_MS * 2 ** noProgressReconnects,
                      1_000,
                    ),
                  ),
                ).pipe(
                  Effect.andThen(connect(reconnectCursor)),
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      fail(error);
                    }),
                  ),
                ),
              );
            };

            socket.once("open", () => {
              if (terminalHandled || stopped) return;
              socketOpened = true;
              Deferred.doneUnsafe(opened, Effect.void);
            });

            socket.on("message", (raw) => {
              if (terminalHandled || stopped) return;
              const decoded = Effect.runSyncExit(
                parseDeploymentLogRecord(rawDataToString(raw), new Date()),
              );
              if (!Exit.isSuccess(decoded)) {
                terminalHandled = true;
                Queue.failCauseUnsafe(queue, decoded.cause);
                stopped = true;
                socket.close(1000, "decode failed");
                return;
              }
              const record = decoded.value;
              if (record._tag === "log") {
                if (
                  latestByteEnd !== undefined &&
                  record.raw.byteEnd <= latestByteEnd
                ) {
                  // Exact/older replay after reconnect: drop it and keep the
                  // no-progress budget intact.
                  return;
                }
                if (
                  latestByteEnd !== undefined &&
                  record.raw.byteStart < latestByteEnd
                ) {
                  terminalHandled = true;
                  fail(
                    new PrismaLogStreamError({
                      message:
                        "Prisma deployment log stream returned an overlapping byte range",
                    }),
                  );
                  socket.close(1000, "overlapping log range");
                  return;
                }
                madeProgress =
                  madeProgress ||
                  (connectionStartByteEnd === undefined
                    ? record.raw.byteEnd > record.raw.byteStart
                    : record.raw.byteEnd > connectionStartByteEnd);
                latestByteEnd = record.raw.byteEnd;
                latestCursor = String(record.raw.byteEnd);
                if (madeProgress) noProgressReconnects = 0;
                if (!Queue.offerUnsafe(queue, record.line)) {
                  terminalHandled = true;
                  fail(
                    new PrismaLogStreamError({
                      message: `Prisma deployment log consumer fell behind the ${LOG_QUEUE_CAPACITY}-record safety buffer`,
                    }),
                  );
                  socket.terminate();
                }
                return;
              }

              if (record.raw.retryable) {
                const reconnectCursor =
                  record.raw.cursor && record.raw.cursor.length > 0
                    ? record.raw.cursor
                    : latestCursor;
                scheduleReconnect(reconnectCursor, record.raw.code, "close");
                return;
              }

              terminalHandled = true;
              if (record.raw.kind === "error") {
                fail(
                  new PrismaLogStreamError({
                    message: `${record.raw.code}: ${record.raw.message}`,
                    cause: record.raw.details,
                  }),
                );
                socket.close(1000, "non-retryable terminal error");
                return;
              }

              end();
              socket.close(1000, "terminal record received");
            });
            socket.on("error", (cause) => {
              if (terminalHandled || stopped) return;
              const oversized =
                cause instanceof Error &&
                cause.message.includes("Max payload size exceeded");
              const error = new PrismaLogStreamError({
                message: "Prisma deployment log WebSocket failed",
              });
              if (!socketOpened || oversized) {
                terminalHandled = true;
                Deferred.doneUnsafe(opened, Effect.fail(error));
                fail(error);
                return;
              }
              scheduleReconnect(latestCursor, "transport_error", "terminate");
            });
            socket.on("close", () => {
              sockets.delete(socket);
              if (!terminalHandled && !stopped) {
                if (!socketOpened) {
                  terminalHandled = true;
                  const error = new PrismaLogStreamError({
                    message:
                      "Prisma deployment log WebSocket closed before opening",
                  });
                  Deferred.doneUnsafe(opened, Effect.fail(error));
                  fail(error);
                  return;
                }
                scheduleReconnect(
                  latestCursor,
                  "transport_closed",
                  "already-closed",
                );
              }
            });

            yield* Deferred.await(opened).pipe(
              Effect.timeoutOrElse({
                duration: WEBSOCKET_HANDSHAKE_TIMEOUT,
                orElse: () => {
                  const error = new PrismaLogStreamError({
                    message: `Prisma deployment log WebSocket handshake timed out after ${WEBSOCKET_HANDSHAKE_TIMEOUT}`,
                  });
                  return Effect.sync(() => {
                    terminalHandled = true;
                    sockets.delete(socket);
                    try {
                      socket.terminate();
                    } catch {
                      // The socket may have closed concurrently with the timeout.
                    }
                    fail(error);
                  }).pipe(Effect.andThen(Effect.fail(error)));
                },
              }),
            );
          });

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stopped = true;
            for (const socket of sockets) {
              try {
                if (
                  socket.readyState === WebSocket.CONNECTING ||
                  socket.readyState === WebSocket.CLOSING
                ) {
                  socket.terminate();
                } else if (socket.readyState === WebSocket.OPEN) {
                  socket.close(1000, "tail stopped");
                }
              } catch {
                // Cleanup must never turn cancellation into a finalizer defect.
              }
            }
            sockets.clear();
          }),
        );

        yield* connect(query?.cursor);
      }),
    { bufferSize: LOG_QUEUE_CAPACITY, strategy: "dropping" },
  );

const loadWebSocketConstructor = Effect.tryPromise({
  try: () => import("ws").then((module) => module.default),
  catch: (cause) =>
    new PrismaLogStreamError({
      message:
        "Prisma deployment log tailing requires the optional `ws` package.",
      cause,
    }),
});

const rawDataToString = (raw: RawData): string => {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (Array.isArray(raw)) return raw.map(rawDataToString).join("");
  return raw.toString();
};
