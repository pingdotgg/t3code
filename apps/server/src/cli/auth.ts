import {
  AuthAdministrativeScopes,
  AuthSessionId,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import { ServerConfig } from "../config.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

const runWithEnvironmentAuth = <A, E>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuthShape) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* run(environmentAuth);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer).pipe(
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.string("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
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
            scopes: AuthStandardClientScopes,
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
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
  id: Argument.string("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
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

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
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
            scopes: AuthAdministrativeScopes,
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
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.string("session-id").pipe(
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
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
