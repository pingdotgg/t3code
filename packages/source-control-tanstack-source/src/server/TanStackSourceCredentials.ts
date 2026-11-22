import {
  requireSettingsSecretLiteral,
  type ServerSettings,
  type SettingsSecretUnresolvedError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as TanStackSource from "../shared/definition.ts";
import * as Hosts from "./tanStackSourceHosts.ts";

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);

export const TanStackSourceCredentialSource = Schema.Literals(["settings", "env", "src"]);
export type TanStackSourceCredentialSource = typeof TanStackSourceCredentialSource.Type;

export interface TanStackSourceCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: TanStackSourceCredentialSource;
}

export class TanStackSourceCliMissingError extends Schema.TaggedError<TanStackSourceCliMissingError>()(
  "TanStackSourceCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No TanStack Source credential for ${this.host}: save a token in Settings, set SRC_TOKEN, or install the src CLI and run \`src auth login --web\`.`;
  }
}

export class TanStackSourceNotSignedInError extends Schema.TaggedError<TanStackSourceNotSignedInError>()(
  "TanStackSourceNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No TanStack Source credential for ${this.host}: run \`src auth login --web --hostname ${this.host}\`.`
      : `No TanStack Source credential for ${this.account} on ${this.host}: run \`src auth login --web --hostname ${this.host}\` for that account or pick another in Settings → Source control & issues.`;
  }
}

export class TanStackSourceHostDisabledError extends Schema.TaggedError<TanStackSourceHostDisabledError>()(
  "TanStackSourceHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `TanStack Source host ${this.host} is turned off in Settings → Source control & issues.`;
  }
}

export class TanStackSourceCliFailedError extends Schema.TaggedError<TanStackSourceCliFailedError>()(
  "TanStackSourceCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The src CLI could not hand over a credential for ${this.host}. Check \`src auth status\` on the server.`;
  }
}

export class TanStackSourceCliTimeoutError extends Schema.TaggedError<TanStackSourceCliTimeoutError>()(
  "TanStackSourceCliTimeoutError",
  { host: Schema.String, timeoutMs: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The src CLI did not hand over a credential for ${this.host} within ${this.timeoutMs / 1000} seconds. The server may be overloaded; try again.`;
  }
}

export type TanStackSourceCredentialUnavailableError =
  | TanStackSourceCliMissingError
  | TanStackSourceNotSignedInError
  | TanStackSourceHostDisabledError
  | TanStackSourceCliFailedError
  | TanStackSourceCliTimeoutError
  | SettingsSecretUnresolvedError;

/** Where requests to a host get their token. The API layer asks; it never reads a source itself. */
export class TanStackSourceCredentials extends Context.Service<
  TanStackSourceCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<TanStackSourceCredential, TanStackSourceCredentialUnavailableError>;
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-tanstack-source/server/TanStackSourceCredentials") {}

/** `src` sends SRC_TOKEN only to SRC_HOST (default source.tanstack.com); so does T3. */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = env.SRC_HOST?.trim().toLowerCase() || TanStackSource.TANSTACK_SOURCE_HOST;
  if (configured !== normalizeHost(host)) return null;
  return env.SRC_TOKEN?.trim() || null;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const fromCli = (host: string, account: string | undefined) =>
    sourceControlHost.process
      .run({
        operation: "TanStackSourceCredentials.get",
        command: "src",
        args: [
          "auth",
          "token",
          "--hostname",
          host,
          ...(account === undefined ? [] : ["--user", account]),
        ],
        cwd: workingDirectory,
        // An inherited SRC_TOKEN would answer in place of the login asked for; it is read above.
        env: { SRC_TOKEN: "", SRC_NO_TELEMETRY: "1" },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new TanStackSourceCliMissingError({ host })
            : // src exits 1 with "no oauth token found" when it has no login for the host.
              error._tag === "VcsProcessExitError"
              ? new TanStackSourceNotSignedInError({
                  host,
                  ...(account === undefined ? {} : { account }),
                })
              : error._tag === "VcsProcessTimeoutError"
                ? new TanStackSourceCliTimeoutError({
                    host,
                    timeoutMs: error.timeoutMs,
                    cause: error,
                  })
                : new TanStackSourceCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () =>
            new TanStackSourceNotSignedInError({
              host,
              ...(account === undefined ? {} : { account }),
            }),
        ),
      );

  const readSettings = (settings: ServerSettings) =>
    readSourceControlHostSettings(
      TanStackSource.settings,
      settings.sourceControlHosts[TanStackSource.definition.kind],
    );

  const hostChoice = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => readSettings(settings).hosts[host]),
      Effect.orElseSucceed(() => undefined),
    );

  const savedToken = (host: string) =>
    sourceControlHost.settings.getWithSecrets(TanStackSource.definition.kind).pipe(
      Effect.map((settings) => ({
        token: readSettings(settings).tokens[host],
        secretProviders: settings.secretProviders,
      })),
      Effect.orElseSucceed(() => ({ token: undefined, secretProviders: {} })),
      Effect.flatMap(({ token, secretProviders }) =>
        requireSettingsSecretLiteral(token, secretProviders),
      ),
      Effect.map((token) => token.trim() || null),
    );

  const cacheKey = (host: string, account: string | undefined) =>
    account === undefined ? host : `${host}\u0000${account}`;

  const lookup = Effect.fn("TanStackSourceCredentials.lookup")(function* (key: string) {
    const [host = key, account] = key.split("\u0000");
    const fromEnv = environmentToken(host, environment);
    const token =
      fromEnv ??
      (yield* fromCli(host, account).pipe(
        Effect.catchTags({
          TanStackSourceNotSignedInError: (error) =>
            account === undefined ? Effect.fail(error) : fromCli(host, undefined),
        }),
      ));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv === null ? "src" : "env",
    } satisfies TanStackSourceCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 8,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists(
                (error) =>
                  error._tag === "TanStackSourceCliFailedError" ||
                  error._tag === "TanStackSourceCliTimeoutError",
              ),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return TanStackSourceCredentials.of({
    get: Effect.fn("TanStackSourceCredentials.get")(function* (rawHost) {
      const host = normalizeHost(rawHost);
      // Only Source's own hosts get a token, whatever host a remote or link names.
      if (Hosts.tanStackSourceHost(host) === null)
        return yield* new TanStackSourceNotSignedInError({ host });
      const choice = yield* hostChoice(host);
      if (choice?.enabled === false) return yield* new TanStackSourceHostDisabledError({ host });
      const saved = yield* savedToken(host);
      if (saved !== null) return { host, token: Redacted.make(saved), source: "settings" as const };
      return yield* Cache.get(cache, cacheKey(host, choice?.account));
    }),
    invalidate: Effect.fn("TanStackSourceCredentials.invalidate")(function (rawHost) {
      const host = normalizeHost(rawHost);
      return hostChoice(host).pipe(
        Effect.flatMap((choice) => Cache.invalidate(cache, cacheKey(host, choice?.account))),
      );
    }),
  });
});

export const layer = Layer.effect(TanStackSourceCredentials, make);
