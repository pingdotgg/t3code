import {
  AuthAccessReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatConnectDeviceList,
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authScopesFlag } from "./authScopes.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

class AuthServerUnreachableError extends Schema.TaggedError<AuthServerUnreachableError>()(
  "AuthServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ask the T3 Code server at ${this.origin} which sessions are connected; listing every session as disconnected.`;
  }
}

const LIVE_SERVER_TIMEOUT = Duration.seconds(10);
// Bounds how long the session outlives a CLI killed before it can revoke it.
const LIVE_SERVER_SESSION_TTL = Duration.minutes(1);

/**
 * Only the running server knows which sessions hold an open WebSocket, so ask
 * it with a short-lived session that is revoked before the list is read.
 * With no running server, including a runtime file left by a crash, nothing
 * can be connected.
 */
const connectedSessionIds = Effect.fn("auth.connectedSessionIds")(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState) || !isProcessAlive(runtimeState.value.pid)) {
    return new Set<AuthSessionId>();
  }
  const origin = runtimeState.value.origin;
  const clients = yield* Effect.acquireUseRelease(
    environmentAuth.issueSession({
      ttl: LIVE_SERVER_SESSION_TTL,
      scopes: [AuthAccessReadScope],
      subject: "auth-cli",
      label: "t3 auth cli",
    }),
    (issued) =>
      HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin }).pipe(
        Effect.flatMap((client) =>
          client.auth.clients({ headers: { authorization: `Bearer ${issued.token}` } }),
        ),
        Effect.timeout(LIVE_SERVER_TIMEOUT),
        Effect.mapError((cause) => new AuthServerUnreachableError({ origin, cause })),
      ),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );
  return new Set(clients.flatMap((client) => (client.connected ? [client.sessionId] : [])));
});

const runWithEnvironmentAuth = Effect.fn("auth.runWithEnvironmentAuth")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* run(environmentAuth);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime, FetchHttpClient.layer).pipe(
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withSchema(
    Schema.URLFromString.pipe(
      Schema.check(
        Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
          expected: "an http:// or https:// URL",
        }),
      ),
    ),
  ),
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.createPairingLink({
            scopes: flags.scopes,
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value.href } : {}),
          });
          yield* Console.log(output);
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const pairingLinks = yield* environmentAuth.listPairingLinks({
            excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const connectDeviceListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List T3 Connect devices waiting for approval and those already trusted.",
  ),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const waiting = (yield* environmentAuth.listPairingLinks()).flatMap((link) =>
            link.connectDeviceRequest ? [link.connectDeviceRequest] : [],
          );
          const trusted = yield* environmentAuth.listConnectDevices();
          yield* Console.log(formatConnectDeviceList({ waiting, trusted }, { json: flags.json }));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const verificationCodeArgument = Argument.String("code").pipe(
  Argument.withDescription("The code the device shows, such as `K7QM-2XFD`."),
);

const connectDeviceApproveCommand = Command.make("approve", {
  ...authLocationFlags,
  code: verificationCodeArgument,
}).pipe(
  Command.withDescription("Approve the waiting T3 Connect device that shows this code."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const approved = yield* environmentAuth.approveConnectDeviceByCode(flags.code);
        yield* Console.log(
          approved
            ? `Approved ${flags.code}. The device connects on its next try.\n`
            : `No device waiting for approval shows ${flags.code}.\n`,
        );
      }),
    ),
  ),
);

const connectDeviceRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  code: verificationCodeArgument,
}).pipe(
  Command.withDescription("Stop trusting a T3 Connect device and end its sessions."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const outcome = yield* environmentAuth.revokeConnectDeviceByCode(flags.code);
        yield* Console.log(
          outcome === "revoked"
            ? `Revoked ${flags.code}. If approval for new devices is off, it can connect again on its own.\n`
            : outcome === "ambiguous"
              ? `More than one trusted device shows ${flags.code}; revoke it from a client.\n`
              : `No trusted device shows ${flags.code}.\n`,
        );
      }),
    ),
  ),
);

const connectDeviceCommand = Command.make("connect-device").pipe(
  Command.withDescription("Approve and revoke devices that reach this host through T3 Connect."),
  Command.withSubcommands([
    connectDeviceListCommand,
    connectDeviceApproveCommand,
    connectDeviceRevokeCommand,
  ]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: flags.scopes,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const connected = yield* connectedSessionIds(environmentAuth).pipe(
            // Servers older than the clients endpoint answer 404; still list the sessions.
            Effect.catchTags({
              AuthServerUnreachableError: (error) =>
                Console.error(error.message).pipe(Effect.as(new Set<AuthSessionId>())),
            }),
          );
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(
            formatSessionList(
              sessions.map((session) => ({
                ...session,
                connected: connected.has(session.sessionId),
              })),
              { json: flags.json },
            ),
          );
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand, connectDeviceCommand]),
);
