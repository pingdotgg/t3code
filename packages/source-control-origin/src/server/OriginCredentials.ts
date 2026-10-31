import { settingsSecretLiteral } from "@t3tools/contracts";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import * as OriginClient from "../shared/definition.ts";
import { ORIGIN_REMOTE_HOST } from "./originHosts.ts";

const TOKEN_TTL = Duration.minutes(3);
const MISSING_TTL = Duration.seconds(10);

export interface OriginCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: "settings" | "env" | "origin";
}

export class OriginCliMissingError extends Schema.TaggedError<OriginCliMissingError>()(
  "OriginCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Origin credential for ${this.host}: install the Origin CLI (\`curl -fsSL https://downloads.cursor.com/origin/install.sh | sh\`) and run \`origin auth login\`, or set CURSOR_AUTH_TOKEN / CURSOR_API_KEY.`;
  }
}

export class OriginNotSignedInError extends Schema.TaggedError<OriginNotSignedInError>()(
  "OriginNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Origin credential for ${this.host}: run \`origin auth login\`, or set CURSOR_AUTH_TOKEN / CURSOR_API_KEY.`;
  }
}

export class OriginCliFailedError extends Schema.TaggedError<OriginCliFailedError>()(
  "OriginCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The Origin CLI could not hand over a credential for ${this.host}. Check \`origin auth status\` on the server.`;
  }
}

export type OriginCredentialUnavailableError =
  | OriginCliMissingError
  | OriginNotSignedInError
  | OriginCliFailedError;

export class OriginCredentials extends Context.Service<
  OriginCredentials,
  {
    readonly get: (
      host?: string,
    ) => Effect.Effect<OriginCredential, OriginCredentialUnavailableError>;
    readonly invalidate: (host?: string) => Effect.Effect<void>;
    readonly cliEnv: () => Effect.Effect<Readonly<Record<string, string>>>;
  }
>()("@t3tools/source-control-origin/server/OriginCredentials") {}

function tokenFromStdout(stdout: string): string | null {
  const line = stdout
    .trim()
    .split(/\r?\n/u)
    .find((entry) => entry.trim().length > 0);
  return line?.trim() || null;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const { process } = sourceControlHost;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const fromSettings = sourceControlHost.settings.getWithSecrets(OriginClient.definition.kind).pipe(
    Effect.map(
      (settings) =>
        settingsSecretLiteral(
          readSourceControlHostSettings(
            OriginClient.settings,
            settings.sourceControlHosts[OriginClient.definition.kind],
          ).token,
        ) || null,
    ),
    Effect.orElseSucceed(() => null),
  );

  const mintWith = (env: Readonly<Record<string, string>>) =>
    process
      .run({
        operation: "OriginCredentials.get",
        command: "origin",
        args: ["auth", "token"],
        cwd: workingDirectory,
        env,
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new OriginCliMissingError({ host: ORIGIN_REMOTE_HOST })
            : error._tag === "VcsProcessExitError"
              ? new OriginNotSignedInError({ host: ORIGIN_REMOTE_HOST })
              : new OriginCliFailedError({ host: ORIGIN_REMOTE_HOST, cause: error }),
        ),
        Effect.map((output) => tokenFromStdout(output.stdout)),
        Effect.filterOrFail(
          (token): token is string => token !== null,
          () => new OriginNotSignedInError({ host: ORIGIN_REMOTE_HOST }),
        ),
      );

  const lookup = Effect.fn("OriginCredentials.lookup")(function* (
    _host: string,
  ): Effect.fn.Return<OriginCredential, OriginCredentialUnavailableError> {
    const saved = yield* fromSettings;
    if (saved !== null) {
      const token = yield* mintWith({ CURSOR_API_KEY: saved });
      return { host: ORIGIN_REMOTE_HOST, token: Redacted.make(token), source: "settings" };
    }
    const authToken = environment.CURSOR_AUTH_TOKEN?.trim();
    if (authToken)
      return { host: ORIGIN_REMOTE_HOST, token: Redacted.make(authToken), source: "env" };
    const apiKey = environment.CURSOR_API_KEY?.trim();
    if (apiKey) {
      const token = yield* mintWith({ CURSOR_API_KEY: apiKey });
      return { host: ORIGIN_REMOTE_HOST, token: Redacted.make(token), source: "env" };
    }
    const token = yield* mintWith({});
    return { host: ORIGIN_REMOTE_HOST, token: Redacted.make(token), source: "origin" };
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "OriginCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return OriginCredentials.of({
    get: Effect.fn("OriginCredentials.get")(function () {
      return Cache.get(cache, ORIGIN_REMOTE_HOST);
    }),
    invalidate: Effect.fn("OriginCredentials.invalidate")(function () {
      return Cache.invalidate(cache, ORIGIN_REMOTE_HOST);
    }),
    cliEnv: Effect.fn("OriginCredentials.cliEnv")(function* () {
      const saved = yield* fromSettings;
      return saved === null ? {} : { CURSOR_API_KEY: saved };
    }),
  });
});

export const layer = Layer.effect(OriginCredentials, make);
