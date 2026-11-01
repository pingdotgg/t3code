import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthOrchestrationReadScope,
  UsageDay,
  WS_METHODS,
  WsRpcGroup,
  type ServerConfig as ServerConfigSnapshot,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitNotices,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";

class UsageCommandError extends Schema.TaggedError<UsageCommandError>()("UsageCommandError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isUsageCommandError = Schema.is(UsageCommandError);
const CalendarDay = UsageDay.check(
  Schema.makeFilter(
    (day) => {
      const date = DateTime.make(`${day}T00:00:00Z`);
      return Option.isSome(date) && DateTime.formatIsoDate(date.value) === day;
    },
    { message: "Expected a valid calendar date (YYYY-MM-DD)." },
  ),
);

const runUsage = Effect.fn("cli.usage")(function* (
  name: "limits" | "tokens" | "cost",
  flags: CliAuthLocationFlags & {
    readonly since?: Option.Option<UsageDay>;
    readonly until?: Option.Option<UsageDay>;
  },
) {
  const today = UsageDay.make(DateTime.formatIsoDate(yield* DateTime.now));
  const sinceDay = flags.since ? Option.getOrElse(flags.since, () => today) : today;
  const untilDay = flags.until ? Option.getOrElse(flags.until, () => today) : today;
  if (name !== "limits" && sinceDay > untilDay) {
    return yield* new UsageCommandError({ message: "--since must not be after --until." });
  }
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(state)) {
    return yield* new UsageCommandError({
      message: "Usage requires a running T3 Code server. Start t3 or select its --base-dir.",
    });
  }
  const url = new URL("/ws", state.value.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const report = yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes: [AuthOrchestrationReadScope],
        label: "t3 usage cli",
        ttl: Duration.minutes(1),
      }),
      (session) =>
        Effect.gen(function* () {
          const socketLayer = Layer.succeed(
            Socket.WebSocketConstructor,
            (socketUrl, protocols) =>
              new NodeSocket.NodeWS.WebSocket(
                socketUrl,
                protocols as string | string[] | undefined,
                {
                  headers: { authorization: `Bearer ${session.token}` },
                },
              ) as unknown as globalThis.WebSocket,
          );
          const protocolLayer = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Socket.layerWebSocket(url.toString()).pipe(Layer.provide(socketLayer))),
            Layer.provide(RpcSerialization.layerJson),
          );
          return yield* Effect.gen(function* () {
            const client = yield* RpcClient.make(WsRpcGroup);
            if (name === "limits") {
              // Hub limits are only on the opted-in config stream, not getConfig.
              const result = yield* client[WS_METHODS.subscribeServerConfig]({
                usageLimitSources: true,
              }).pipe(
                Stream.scan(undefined as ServerConfigSnapshot | undefined, (snapshot, event) => {
                  if (event.type === "snapshot") return event.config;
                  if (!snapshot) return snapshot;
                  if (event.type === "settingsUpdated")
                    return { ...snapshot, settings: event.payload.settings };
                  if (event.type === "providerStatuses")
                    return { ...snapshot, providers: event.payload.providers };
                  if (event.type === "usageLimitSourcesUpdated")
                    return { ...snapshot, usageLimitSources: event.payload.sources };
                  return snapshot;
                }),
                Stream.filter(
                  (snapshot) =>
                    snapshot !== undefined &&
                    (!snapshot.environment.capabilities.usageLimitSources ||
                      (snapshot.usageLimitSources !== undefined &&
                        Object.entries(snapshot.settings.usageLimitSources).every(
                          ([id, source]) =>
                            !source.enabled ||
                            snapshot.usageLimitSources?.some((value) => value.id === id),
                        ))),
                ),
                Stream.runHead,
              );
              const snapshot = Option.getOrUndefined(result);
              if (!snapshot)
                return yield* new UsageCommandError({
                  message: "The server did not return a limits snapshot.",
                });
              const presentations = new Map([
                [
                  snapshot.environment.environmentId,
                  {
                    entry: { target: { label: snapshot.environment.label } },
                    serverConfig: snapshot,
                  },
                ],
              ]);
              return {
                readAt: DateTime.formatIso(yield* DateTime.now),
                cached: true,
                accounts: collectLimitAccounts(presentations).map((account) => ({
                  id: account.key,
                  driver: account.driver,
                  displayName: account.displayName,
                  email: account.email,
                  plan: account.plan,
                  sourceLabel: account.sourceLabel,
                  limits: {
                    checkedAt: account.limits.checkedAt,
                    windows: account.limits.windows.map((window) => ({
                      ...window,
                      remainingPercent: remainingPercent(window),
                    })),
                    ...(account.limits.resetCredits
                      ? {
                          resetCredits: {
                            availableCount: account.limits.resetCredits.availableCount,
                            nextExpiresAt: account.limits.resetCredits.nextExpiresAt,
                          },
                        }
                      : {}),
                  },
                })),
                notices: collectLimitNotices(presentations),
              };
            }
            const summary = yield* client[WS_METHODS.serverGetUsageSummary]({
              sinceDay,
              untilDay,
              timeZone: "UTC",
            });
            if (name === "cost")
              return {
                ...summary,
                costKind: "api-equivalent",
                costUsd: summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
                cacheSavingsUsd: summary.buckets.reduce(
                  (sum, bucket) => sum + bucket.cacheSavingsUsd,
                  0,
                ),
                unpricedRecords: summary.buckets.reduce(
                  (sum, bucket) => sum + bucket.unpricedRecords,
                  0,
                ),
              };
            const totals = {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            };
            for (const bucket of summary.buckets) {
              totals.uncachedInputTokens += bucket.totals.uncachedInputTokens;
              totals.cachedInputTokens += bucket.totals.cachedInputTokens;
              totals.cacheCreationTokens += bucket.totals.cacheCreationTokens;
              totals.outputTokens += bucket.totals.outputTokens;
              totals.reasoningTokens += bucket.totals.reasoningTokens;
            }
            return {
              ...summary,
              totals,
              totalTokens:
                totals.uncachedInputTokens +
                totals.cachedInputTokens +
                totals.cacheCreationTokens +
                totals.outputTokens,
            };
          }).pipe(
            Effect.scoped,
            Effect.provide(protocolLayer),
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              isUsageCommandError(cause)
                ? cause
                : new UsageCommandError({
                    cause,
                    message:
                      "Could not read usage from the running T3 Code server. Check that it is running and up to date.",
                  }),
            ),
          );
        }),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
      ),
    ),
    Effect.provideService(Logger.LogToStderr, true),
  );
  yield* Console.log(yield* encodeReport(report));
});

export const usageCommand = Command.make("usage").pipe(
  Command.withDescription(
    "Read usage and subscription limits as JSON from the running local server.",
  ),
  Command.withSubcommands([
    Command.make("limits", { baseDir: baseDirFlag }).pipe(
      Command.withDescription(
        "Read cached subscription limits, including their checked/reset times. Never consumes resets.",
      ),
      Command.withHandler((flags) => runUsage("limits", flags)),
    ),
    ...(["tokens", "cost"] as const).map((name) =>
      Command.make(name, {
        baseDir: baseDirFlag,
        since: Flag.String("since").pipe(
          Flag.withSchema(CalendarDay),
          Flag.withDescription("Inclusive first UTC day (YYYY-MM-DD). Defaults to today."),
          Flag.optional,
        ),
        until: Flag.String("until").pipe(
          Flag.withSchema(CalendarDay),
          Flag.withDescription("Inclusive last UTC day (YYYY-MM-DD). Defaults to today."),
          Flag.optional,
        ),
      }).pipe(
        Command.withDescription(
          name === "tokens"
            ? "Read token totals and per-model daily buckets."
            : "Read estimated API-equivalent cost, not subscription charges.",
        ),
        Command.withHandler((flags) => runUsage(name, flags)),
      ),
    ),
  ]),
);
