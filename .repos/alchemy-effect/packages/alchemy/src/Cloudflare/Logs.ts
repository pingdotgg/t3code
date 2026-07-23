import * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import type { LogLine, LogsInput } from "../Provider.ts";

const DEFAULT_LOOKBACK_MS = 1 * 60 * 60 * 1000;

export interface TelemetryFilter {
  key: string;
  operation:
    | "eq"
    | "neq"
    | "includes"
    | "not_includes"
    | "starts_with"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "not_in";
  type: "string" | "number" | "boolean";
  value?: string | number | boolean;
}

interface TailEventMessage {
  eventTimestamp?: number;
  wallTime: number;
  cpuTime: number;
  truncated: boolean;
  outcome: string;
  scriptName: string;
  exceptions: {
    name: string;
    message: string;
    stack: string;
    timestamp: string;
  }[];
  logs: {
    message: string[];
    level: string;
    timestamp: string;
  }[];
  event:
    | {
        request: { method: string; url: string };
        response?: { status: number };
      }
    | null
    | undefined;
}

const parseEvents = (
  response: workers.QueryObservabilityTelemetryResponse,
): LogLine[] => {
  const lines: LogLine[] = [];
  if (response.events?.events) {
    for (const event of response.events.events) {
      const ts = new Date(event.timestamp);
      const meta = event.$metadata;
      const msg =
        meta.message ??
        (meta.level === "error"
          ? `error: ${meta.error ?? "unknown"}`
          : `${meta.level ?? "log"}`);
      lines.push({ timestamp: ts, message: msg });
    }
  }
  return lines;
};

export const CloudflareLogs = Effect.gen(function* () {
  const queryTelemetry = yield* workers.queryObservabilityTelemetry;
  const createScriptTail = yield* workers.createScriptTail;
  const deleteScriptTail = yield* workers.deleteScriptTail;

  const queryLogs = (opts: {
    accountId: string;
    filters: TelemetryFilter[];
    options: LogsInput;
  }) =>
    Effect.gen(function* () {
      const now = Date.now();
      const limit = opts.options.limit ?? 100;

      if (opts.options.since) {
        const response = yield* queryTelemetry({
          accountId: opts.accountId,
          queryId: "events",
          view: "events",
          timeframe: { from: opts.options.since.getTime(), to: now },
          limit,
          parameters: {
            filters: opts.filters,
            // orderBy: { value: "timestamp", order: "desc" },
          },
        });
        return parseEvents(response);
      }

      const response = yield* queryTelemetry({
        accountId: opts.accountId,
        queryId: "events",
        view: "events",
        timeframe: { from: now - DEFAULT_LOOKBACK_MS, to: now },
        limit,
        parameters: {
          filters: opts.filters,
        },
      });

      return parseEvents(response);
    });

  /**
   * Open a real-time Workers tail session against `scriptName` and
   * surface its messages as a {@link LogLine} stream. The websocket is
   * automatically reconnected (with `Stream.repeat`) when Cloudflare
   * closes it after its idle window.
   */
  const tailScript = (opts: { accountId: string; scriptName: string }) => {
    const runTailSession = Effect.gen(function* () {
      const { id: tailId, url } = yield* createScriptTail({
        scriptName: opts.scriptName,
        accountId: opts.accountId,
        body: { filters: [] },
      });

      const socket = yield* Socket.makeWebSocket(url, {
        protocols: ["trace-v1"],
      });

      const queue = yield* Queue.make<LogLine, Cause.Done>();

      yield* socket
        .runRaw((raw) => {
          const text =
            typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const data: TailEventMessage = JSON.parse(text);
          const eventTs = new Date(data.eventTimestamp ?? Date.now());

          if (data.event && "request" in data.event) {
            const reqEvent = data.event;
            const pathname = (() => {
              try {
                return new URL(reqEvent.request.url).pathname;
              } catch {
                return reqEvent.request.url;
              }
            })();
            const status = reqEvent.response?.status ?? 500;
            Queue.offerUnsafe(queue, {
              timestamp: eventTs,
              message: `${reqEvent.request.method} ${pathname} > ${status} (cpu: ${Math.round(data.cpuTime)}ms, wall: ${Math.round(data.wallTime)}ms)`,
            });
          }

          for (const log of data.logs) {
            const msg = log.message.join(" ");
            Queue.offerUnsafe(queue, {
              timestamp: new Date(log.timestamp),
              message: log.level === "log" ? msg : `${log.level}: ${msg}`,
            });
          }

          for (const exception of data.exceptions) {
            Queue.offerUnsafe(queue, {
              timestamp: new Date(exception.timestamp),
              message: `${exception.name} ${exception.message}\n${exception.stack}`,
            });
          }
        })
        .pipe(
          Effect.ensuring(
            Effect.all([
              deleteScriptTail({
                scriptName: opts.scriptName,
                id: tailId,
                accountId: opts.accountId,
              }).pipe(Effect.ignore),
              Queue.end(queue),
            ]),
          ),
          Effect.ignore,
          Effect.forkChild(),
        );

      return Stream.fromQueue(queue);
    });

    return Stream.unwrap(runTailSession).pipe(
      Stream.repeat(Schedule.spaced("1 second")),
    );
  };

  const tailStream = (opts: {
    accountId: string;
    filters: TelemetryFilter[];
  }) => {
    const poll = (since: number): Stream.Stream<LogLine, any> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.sleep("2 seconds");
          const now = Date.now();

          const response = yield* queryTelemetry({
            accountId: opts.accountId,
            queryId: "events",
            view: "events",
            timeframe: { from: since, to: now },
            limit: 100,
            parameters: {
              filters: opts.filters,
              orderBy: { value: "timestamp", order: "asc" },
            },
          });

          const lines = parseEvents(response);
          const nextSince =
            lines.length > 0
              ? Math.max(...lines.map((l) => l.timestamp.getTime())) + 1
              : since;

          return Stream.concat(Stream.fromIterable(lines), poll(nextSince));
        }),
      );

    return poll(Date.now());
  };

  return { queryLogs, tailScript, tailStream };
});
