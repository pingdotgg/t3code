import * as Floci from "@alchemy.run/floci";
import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import type { CredentialsError } from "@distilled.cloud/aws/Credentials";
import {
  Credentials,
  ExpiredSSOToken,
  InvalidSSOToken,
} from "@distilled.cloud/aws/Credentials";
import * as STS from "@distilled.cloud/aws/sts";
import * as EffectConsole from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  reconfigureHint,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetailLine,
} from "../Auth/AuthProvider.ts";
import { displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  getEnvRequired,
  mapPromptCancellation,
} from "../Auth/Env.ts";
import {
  storedSecret,
  storedValueText,
  validateFieldValues,
} from "../Auth/StoredAuthProvider.ts";
import * as Interaction from "../Interaction.ts";
import * as Endpoint from "./Endpoint.ts";
import * as Region from "./Region.ts";

export const AWS_AUTH_PROVIDER_NAME = "AWS";
export const DEFAULT_LOCAL_ENDPOINT = `http://localhost:${Floci.DEFAULT_FLOCI_PORT}`;

/**
 * Dummy account stamped on every floci environment.
 * A custom `AWS_ENDPOINT_URL` on env/sso credentials does NOT use this —
 * those keep the real account from STS / `AWS_ACCOUNT_ID`.
 */
export const LOCAL_ACCOUNT_ID = "000000000000";

/**
 * distilled's SSO credential loader `Console.log`s its expired-token
 * diagnostic in addition to failing with the typed `ExpiredSSOToken`. The
 * typed error already carries the same message (and the profile UI surfaces
 * it as a reauth diagnostic), so the raw console write only smears over the
 * Interaction renderer. Provide this no-op Console on every distilled
 * `loadProfileCredentials` call so distilled has nowhere to print.
 */
const noop = () => {};
export const silentConsole: EffectConsole.Console = {
  assert: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  debug: noop,
  dir: noop,
  dirxml: noop,
  error: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  info: noop,
  log: noop,
  table: noop,
  time: noop,
  timeEnd: noop,
  timeLog: noop,
  trace: noop,
  warn: noop,
};

/** Typed values stored in an AWS provider profile document. */
export const AwsAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("sso"),
    ssoProfile: Schema.String,
    authorizationMethod: Schema.optional(
      Schema.Union([Schema.Literal("oauth"), Schema.Literal("device")]),
    ),
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    accountId: Schema.optional(Schema.String),
    accessKeyId: Schema.String,
    secretAccessKey: Schema.String,
    sessionToken: Schema.optional(Schema.String),
    region: Schema.String,
  }),
]);
export type AwsAuthConfig = typeof AwsAuthConfigSchema.Type;

const options: Array<{
  value: AwsAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "sso",
    label: "SSO",
    description: "sign in with an AWS IAM Identity Center profile",
  },
  {
    value: "stored",
    label: "Access Keys",
    description: "enter an access key and secret directly",
  },
];

/** `--set` fields for `--method stored` (static access keys, persisted). */
const keysFields: ReadonlyArray<ConfigureField> = [
  { name: "accessKeyId", label: "AWS Access Key ID" },
  { name: "secretAccessKey", label: "AWS Secret Access Key", secret: true },
  {
    name: "sessionToken",
    label: "AWS Session Token",
    secret: true,
    optional: true,
  },
  { name: "region", label: "AWS Region", placeholder: "us-east-1" },
];

/** `--set` fields for `--method sso` (nothing persisted; profile validated). */
const ssoFields: ReadonlyArray<ConfigureField> = [
  { name: "ssoProfile", label: "AWS profile name (from ~/.aws/config)" },
];

const configureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "stored", fields: keysFields },
  { method: "sso", fields: ssoFields },
];

export interface AwsResolvedCredentials {
  accountId: string;
  credentials: Effect.Effect<AwsCredentials, CredentialsError>;
  region: string;
  endpoint?: string;
  source: {
    type: AwsAuthConfig["method"] | "env";
    details?: string;
  };
}

interface AwsCredentials {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken: Redacted.Redacted<string> | undefined;
  region: string;
}

/**
 * An explicitly-set `AWS_REGION` env var wins over the region recorded in an
 * SSO profile (`~/.aws/config`) or in stored credentials. `AWS_DEFAULT_REGION`
 * deliberately does NOT override — it is a *default* for when no region is
 * configured anywhere, and the profile's region is explicit configuration.
 */
export const applyEnvRegionOverride = <C extends { region: string }>(
  creds: C,
): Effect.Effect<C, AuthError> =>
  getEnv("AWS_REGION").pipe(
    Effect.map((envRegion) =>
      envRegion ? { ...creds, region: envRegion } : creds,
    ),
  );

/**
 * Layer that registers the AWS {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the AWS
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const AwsAuth = AuthProviderLayer<
  AwsAuthConfig,
  AwsResolvedCredentials
>()(
  AWS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const interaction = Interaction.accessors;
    const getAccountId = ({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
    }: {
      accessKeyId: Redacted.Redacted<string>;
      secretAccessKey: Redacted.Redacted<string>;
      sessionToken?: Redacted.Redacted<string>;
      region: string;
    }) =>
      STS.getCallerIdentity({}).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              Credentials,
              Effect.succeed({
                accessKeyId,
                secretAccessKey,
                sessionToken,
                region,
              }),
            ),
            // Provide Region directly from the resolved inputs. Relying on the
            // ambient Region provider (Region.fromEnvironment) here would
            // deadlock: it derives the region from AWSEnvironment, which is the
            // very service still being constructed by this STS call.
            Region.of(region),
            // Provide `Endpoint.none` rather than leaving it unset: falling
            // through to the ambient `Endpoint.fromEnvironment` reads it off
            // AWSEnvironment — the very service this STS call is
            // constructing — and deadlocks the fiber on its own in-flight
            // cache (no I/O, no timer, no output). Same reason as
            // `Region.of` above.
            Endpoint.none,
          ),
        ),
        Effect.flatMap((self) =>
          self.Account
            ? Effect.succeed(self.Account)
            : Effect.die(new Error("No account ID found")),
        ),
      );

    const loginStored = Effect.fn(function* (profileName: string) {
      const accessKeyId = yield* interaction.prompt
        .text({
          message: "AWS Access Key ID",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const secretAccessKey = yield* interaction.prompt
        .password({
          message: "AWS Secret Access Key",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const sessionToken = yield* interaction.prompt
        .password({
          message: "AWS Session Token (optional; press Enter to skip)",
          placeholder: "(none)",
        })
        .pipe(mapPromptCancellation);

      const region = yield* interaction.prompt
        .text({
          message: "AWS Region",
          placeholder: "us-east-1",
          defaultValue: "us-east-1",
        })
        .pipe(mapPromptCancellation);

      const accountId = yield* getAccountId({
        accessKeyId: Redacted.make(accessKeyId),
        secretAccessKey: Redacted.make(secretAccessKey),
        sessionToken: sessionToken ? Redacted.make(sessionToken) : undefined,
        region,
      });

      yield* interaction.output.success("AWS credentials saved.");

      return {
        method: "stored" as const,
        accountId,
        accessKeyId,
        secretAccessKey,
        sessionToken: sessionToken || undefined,
        region,
      };
    });

    const configureInteractive = (profileName: string) =>
      interaction.prompt
        .select({
          message: "AWS authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("sso", () =>
                Effect.gen(function* () {
                  const ssoProfile = yield* interaction.prompt.text({
                    message: "AWS profile name (from ~/.aws/config)",
                    placeholder: "default",
                    defaultValue: "default",
                  });
                  const authorizationMethod = yield* interaction.prompt.select({
                    message: "AWS SSO authorization method",
                    options: [
                      {
                        value: "oauth" as const,
                        label: "Browser OAuth",
                        description: "authorize in this device's browser",
                      },
                      {
                        value: "device" as const,
                        label: "Device code",
                        description:
                          "authorize with a short code on any device",
                      },
                    ],
                  });

                  const config = {
                    method: "sso" as const,
                    ssoProfile: ssoProfile ?? "default",
                    authorizationMethod,
                  };

                  yield* loginSSO(config, authorizationMethod);

                  return config;
                }),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    // The declared requirements are the union of the interactive path
    // (ChildProcessSpawner for `aws sso login`) and `configureWith`'s
    // (FileSystem/Path for ~/.aws/config probing) — the contract shares one
    // ConfigureReq type parameter between the two entry points.
    const configureCredentials = (
      profileName: string,
    ): Effect.Effect<
      AwsAuthConfig,
      AuthError,
      | ChildProcessSpawner
      | HttpClient.HttpClient
      | FileSystem.FileSystem
      | Path.Path
      | Interaction.Interaction
    > =>
      configureInteractive(profileName).pipe(
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message: "failed to configure credentials",
                cause: e,
              }),
        ),
      );

    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ) =>
      Match.value(input.method).pipe(
        Match.when("stored", () =>
          Effect.gen(function* () {
            const values = yield* validateFieldValues(
              AWS_AUTH_PROVIDER_NAME,
              keysFields,
              input.values,
            );
            // validateFieldValues guarantees the required fields are present.
            const accessKeyId = storedSecret(values.accessKeyId);
            const secretAccessKey = storedSecret(values.secretAccessKey);
            const sessionToken = storedSecret(values.sessionToken);
            const region = storedValueText(values.region) ?? "";
            if (accessKeyId === undefined || secretAccessKey === undefined) {
              return yield* Effect.fail(
                new AuthError({
                  message: "AWS: required key fields are missing.",
                }),
              );
            }
            const accountId = yield* getAccountId({
              accessKeyId,
              secretAccessKey,
              sessionToken,
              region,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message:
                      "AWS: failed to verify credentials via STS GetCallerIdentity.",
                    cause,
                  }),
              ),
            );
            return {
              method: "stored" as const,
              accountId,
              accessKeyId: Redacted.value(accessKeyId),
              secretAccessKey: Redacted.value(secretAccessKey),
              sessionToken:
                sessionToken === undefined
                  ? undefined
                  : Redacted.value(sessionToken),
              region,
            };
          }),
        ),
        Match.when("sso", () =>
          Effect.gen(function* () {
            const values = yield* validateFieldValues(
              AWS_AUTH_PROVIDER_NAME,
              ssoFields,
              input.values,
            );
            const ssoProfile = storedValueText(values.ssoProfile) ?? "";
            const auth = yield* DistilledAuth.Default;
            const profile = yield* auth
              .loadProfile(ssoProfile)
              .pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (profile == null) {
              return yield* Effect.fail(
                new AuthError({
                  message: `AWS SSO profile '${ssoProfile}' was not found in ~/.aws/config. Configure it with \`aws configure sso\` first, then log in. ${refreshHint(AWS_AUTH_PROVIDER_NAME, profileName)}`,
                }),
              );
            }
            // Nothing is persisted for SSO — credentials come from the AWS
            // SSO cache. `aws sso login` is interactive, so it is NOT run
            // here; the user runs `alchemy profile refresh` afterwards.
            return { method: "sso" as const, ssoProfile };
          }),
        ),
        Match.orElse(() =>
          Effect.fail(
            new AuthError({
              message: `AWS: unknown method '${input.method}'. Valid methods: stored, sso.`,
            }),
          ),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: AwsAuthConfig,
      updateConfig?: (config: AwsAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const reauth = refreshHint(AWS_AUTH_PROVIDER_NAME, profileName);
        return yield* Match.value(config)
          .pipe(
            Match.when({ method: "stored" }, (config) =>
              Effect.gen(function* () {
                const credentials: AwsCredentials = {
                  accessKeyId: Redacted.make(config.accessKeyId),
                  secretAccessKey: Redacted.make(config.secretAccessKey),
                  sessionToken:
                    config.sessionToken === undefined
                      ? undefined
                      : Redacted.make(config.sessionToken),
                  region: config.region,
                };
                const accountId =
                  config.accountId ?? (yield* getAccountId(credentials));
                if (
                  config.accountId === undefined &&
                  updateConfig !== undefined
                ) {
                  yield* updateConfig({ ...config, accountId });
                }
                return {
                  accountId,
                  credentials: Effect.succeed(credentials),
                  region: config.region,
                  source: { type: "stored" as const },
                } satisfies AwsResolvedCredentials;
              }),
            ),
            Match.when({ method: "sso" }, (config) =>
              Effect.gen(function* () {
                const auth = yield* DistilledAuth.Default;
                const profile = yield* auth
                  .loadProfile(config.ssoProfile)
                  .pipe(Effect.catch(() => Effect.succeed(undefined)));
                if (profile?.sso_account_id == null) {
                  const reconfigure = reconfigureHint(
                    AWS_AUTH_PROVIDER_NAME,
                    profileName,
                  );
                  return yield* Effect.fail(
                    new AuthError({
                      message:
                        profile == null
                          ? `AWS SSO profile '${config.ssoProfile}' was not found in ~/.aws/config. Configure it with \`aws configure sso\`. ${reconfigure}`
                          : `AWS SSO profile '${config.ssoProfile}' has no sso_account_id in ~/.aws/config. Add it. ${reconfigure}`,
                    }),
                  );
                }
                // `applyEnvRegionOverride` below only overrides an existing
                // region, so an env-provided region must be consulted here for
                // profiles that don't record one.
                const region = profile.region ?? (yield* getEnv("AWS_REGION"));
                if (!region) {
                  return yield* Effect.fail(
                    new AuthError({
                      message: `AWS SSO profile '${config.ssoProfile}' has no region in ~/.aws/config and AWS_REGION is not set.`,
                    }),
                  );
                }
                return {
                  accountId: profile.sso_account_id,
                  // Rewrite the message of an expired/invalid SSO token to the
                  // alchemy refresh hint, but PRESERVE the error tags: the inner
                  // effect must stay a `CredentialsError` for downstream
                  // consumers (AWSEnvironment), while `details` and other
                  // in-provider consumers match these tags to surface a typed
                  // `NeedsReauth` instead of a generic failure.
                  credentials: auth
                    .loadProfileCredentials(config.ssoProfile)
                    .pipe(
                      Effect.provideService(
                        EffectConsole.Console,
                        silentConsole,
                      ),
                      Effect.mapError((error) => {
                        if (error._tag === "Alchemy::AWS::ExpiredSSOToken") {
                          return new ExpiredSSOToken({
                            message: `AWS SSO credentials need to be refreshed. ${reauth}`,
                            profile: error.profile,
                          });
                        }
                        if (error._tag === "Alchemy::AWS::InvalidSSOToken") {
                          return new InvalidSSOToken({
                            message: `AWS SSO credentials need to be refreshed. ${reauth}`,
                            sso_session: error.sso_session,
                          });
                        }
                        return error;
                      }),
                    ),
                  region,
                  source: { type: "sso" as const, details: config.ssoProfile },
                } satisfies AwsResolvedCredentials;
              }),
            ),
            Match.exhaustive,
          )
          .pipe(
            // Pass diagnosable failures through untouched: NeedsReauth (stored
            // credentials missing) and the specific AuthErrors raised above
            // (missing SSO profile / sso_account_id / region) carry the real
            // diagnosis. Only genuinely unexpected failures (store I/O, the
            // STS accountId backfill) get wrapped.
            Effect.mapError((e) =>
              e._tag === "AuthError"
                ? e
                : new AuthError({
                    message: "failed to resolve AWS credentials",
                    cause: e,
                  }),
            ),
            Effect.flatMap(applyEnvRegionOverride),
            Effect.map((creds): AwsResolvedCredentials => ({
              ...creds,
              credentials: creds.credentials.pipe(
                Effect.map((credentials) => ({
                  ...credentials,
                  region: creds.region,
                })),
              ),
            })),
          );
      });

    const details = (
      profileName: string,
      config: AwsAuthConfig,
      updateConfig?: (config: AwsAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const creds = yield* resolveCredentials(
          profileName,
          config,
          updateConfig,
        );
        const reauth = refreshHint(AWS_AUTH_PROVIDER_NAME, profileName);
        // Resolve the live credentials. An expired/invalid SSO token only
        // surfaces here (the inner effect is lazy), so convert those tags
        // into a typed NeedsReauth instead of a generic error line.
        const { accessKeyId, secretAccessKey, sessionToken } =
          yield* creds.credentials.pipe(
            Effect.mapError((error) =>
              error._tag === "Alchemy::AWS::ExpiredSSOToken" ||
              error._tag === "Alchemy::AWS::InvalidSSOToken"
                ? new NeedsReauth({
                    provider: AWS_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message: `AWS SSO credentials need to be refreshed. ${reauth}`,
                    cause: error,
                  })
                : new AuthError({
                    message: "failed to load AWS credentials",
                    cause: error,
                  }),
            ),
          );
        const lines: Array<ProviderDetailLine> = [
          { key: "accessKeyId", value: displayRedacted(accessKeyId) },
          { key: "secretAccessKey", value: displayRedacted(secretAccessKey) },
        ];
        if (sessionToken) {
          lines.push({
            key: "sessionToken",
            value: displayRedacted(sessionToken),
          });
        }
        if (creds.region) {
          lines.push({ key: "region", value: creds.region });
        }
        const source = creds.source;
        lines.push({
          key: "source",
          value:
            "details" in source
              ? `${source.type} - ${source.details}`
              : source.type,
        });
        return { lines };
      });

    const logout = (_profileName: string, config: AwsAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "sso" }, (config) =>
          interaction.output
            .info(
              `AWS: running 'aws sso logout --profile ${config.ssoProfile}'...`,
            )
            .pipe(
              Effect.zip(runSsoCommand("logout", config.ssoProfile)),
              Effect.zip(clearDistilledSsoCache(config.ssoProfile)),
              Effect.match({
                onSuccess: () =>
                  interaction.output.success("AWS: SSO logout complete"),
                onFailure: (e) =>
                  interaction.output.warning(
                    `AWS: SSO logout failed: \`${e.message}\``,
                  ),
              }),
            ),
        ),
        Match.when({ method: "stored" }, () => Effect.void),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "sso" }, (config) =>
            loginSSO(config, config.authorizationMethod ?? "oauth"),
          ),
          Match.when({ method: "stored" }, (config) => Effect.succeed(config)),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const readEnvironment = Effect.gen(function* () {
      const accessKeyId = yield* getEnvRedactedRequired("AWS_ACCESS_KEY_ID");
      const secretAccessKey = yield* getEnvRedactedRequired(
        "AWS_SECRET_ACCESS_KEY",
      );
      const sessionToken = yield* getEnvRedacted("AWS_SESSION_TOKEN");
      const region = yield* getEnv("AWS_REGION").pipe(
        Effect.flatMap((value) =>
          value ? Effect.succeed(value) : getEnv("AWS_DEFAULT_REGION"),
        ),
      );
      if (!region) {
        return yield* new AuthError({
          message:
            "AWS CI region not found. Set AWS_REGION or AWS_DEFAULT_REGION.",
        });
      }
      const accountId = yield* getEnvRequired("AWS_ACCOUNT_ID").pipe(
        Effect.catch(() =>
          getAccountId({
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region,
          }),
        ),
      );
      return {
        accountId,
        credentials: Effect.succeed({
          accessKeyId,
          secretAccessKey,
          sessionToken,
          region,
        }),
        region,
        source: { type: "env" as const },
      } satisfies AwsResolvedCredentials;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof AuthError
          ? cause
          : new AuthError({
              message:
                "Failed to resolve AWS credentials from the CI environment.",
              cause,
            }),
      ),
    );

    return {
      configSchema: AwsAuthConfigSchema,
      configure: configureCredentials,
      configureWith,
      configureMethods,
      login,
      logout,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: "AWS_ACCESS_KEY_ID",
          required: true,
          secret: true,
        },
        {
          name: "AWS_SECRET_ACCESS_KEY",
          required: true,
          secret: true,
        },
        {
          name: "AWS_SESSION_TOKEN",
          required: false,
          secret: true,
          description: "Required when the access key is a temporary STS key.",
        },
        {
          name: "AWS_REGION",
          required: true,
          alternatives: ["AWS_DEFAULT_REGION"],
          description: "Region the stack deploys into.",
        },
        {
          name: "AWS_ACCOUNT_ID",
          required: false,
          description: "Derived via STS GetCallerIdentity when unset.",
        },
      ],
    };
  }),
);

const runSsoCommand = (command: "login" | "logout", ssoProfile: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      "aws",
      ["sso", command, "--profile", ssoProfile],
      {
        shell: false,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exit = yield* handle.exitCode;
    if (exit !== 0) {
      return yield* new AuthError({
        message: `aws sso ${command} exited with code ${exit}`,
      });
    }
  }).pipe(Effect.scoped);

const AwsSsoLoginOutput = Schema.Struct({
  url: Schema.optional(Schema.String),
  authUrl: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  verificationUri: Schema.optional(Schema.String),
  verificationUriComplete: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  userCode: Schema.optional(Schema.String),
});

export const parseAwsSsoLoginOutput = (output: string) => {
  try {
    const decoded = Schema.decodeUnknownOption(AwsSsoLoginOutput)(
      JSON.parse(output) as unknown,
    );
    if (Option.isSome(decoded)) {
      const event = decoded.value;
      return {
        url:
          event.authorizationUrl ??
          event.authUrl ??
          event.verificationUriComplete ??
          event.verificationUri ??
          event.url,
        code: event.userCode ?? event.code,
      };
    }
  } catch {
    // `sso login` accepts the global `--output json` option but current AWS
    // CLI releases still render this custom command's authorization prompt as
    // text. Keep accepting structured output if AWS starts honoring the flag.
  }
  return {
    url: output.match(/https?:\/\/[^\s]+/)?.[0],
    code: output.match(/Then enter the code:\s*([A-Z0-9-]+)/i)?.[1],
  };
};

const loginSSO = (
  config: Extract<AwsAuthConfig, { method: "sso" }>,
  authorizationMethod: "oauth" | "device" = "oauth",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const interaction = yield* Interaction.Interaction;
      const services = yield* Effect.context<ChildProcessSpawner>();
      const runOpenUrl = Effect.runPromiseWith(services);
      const authorizationUrl = yield* Deferred.make<string>();
      const deviceCode = yield* Deferred.make<string>();
      const stdout = yield* Ref.make("");
      const stderr = yield* Ref.make("");
      const handle = yield* ChildProcess.make(
        "aws",
        [
          "sso",
          "login",
          "--profile",
          config.ssoProfile,
          "--no-browser",
          "--output",
          "json",
          ...(authorizationMethod === "device" ? ["--use-device-code"] : []),
        ],
        {
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const collectStdout = handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const combined = yield* Ref.updateAndGet(
              stdout,
              (current) => current + chunk,
            );
            const { url, code } = parseAwsSsoLoginOutput(combined);
            if (url !== undefined) {
              yield* Deferred.succeed(authorizationUrl, url);
            }
            if (code !== undefined) {
              yield* Deferred.succeed(deviceCode, code);
            }
          }),
        ),
      );
      const collectStderr = handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderr, (current) => current + chunk),
        ),
      );
      const process = Effect.gen(function* () {
        const [exitCode] = yield* Effect.all(
          [handle.exitCode, collectStdout, collectStderr],
          { concurrency: 3 },
        );
        if (exitCode !== 0) {
          const detail = (yield* Ref.get(stderr)).trim();
          return yield* Effect.fail(
            new AuthError({
              message: `aws sso login exited with code ${exitCode}${detail === "" ? "" : `: ${detail}`}`,
            }),
          );
        }
      });
      const processFiber = yield* Effect.forkScoped(process);
      const url = yield* Deferred.await(authorizationUrl).pipe(
        Effect.raceFirst(
          Fiber.join(processFiber).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new AuthError({
                  message:
                    "AWS SSO login completed without providing an authorization URL.",
                }),
              ),
            ),
          ),
        ),
      );
      const code =
        authorizationMethod === "device"
          ? yield* Deferred.await(deviceCode).pipe(
              Effect.raceFirst(
                Fiber.join(processFiber).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      new AuthError({
                        message:
                          "AWS SSO device login completed without providing an authorization code.",
                      }),
                    ),
                  ),
                ),
              ),
            )
          : undefined;
      const openFailed = yield* Interaction.openUrl(url).pipe(
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      );
      yield* Fiber.join(processFiber).pipe(
        Effect.raceFirst(
          interaction.prompt
            .awaitExternal({
              message: "AWS authorization",
              waitingLabel:
                authorizationMethod === "device"
                  ? "waiting for device authorization (up to 5 minutes)…"
                  : "waiting for browser authorization (up to 5 minutes)…",
              url,
              code,
              openFailed,
              onOpen: () => runOpenUrl(Interaction.openUrl(url)),
              allowManualInput: false,
            })
            .pipe(Effect.asVoid),
        ),
      );
      yield* interaction.output.success("AWS SSO: login complete");
    }),
  );

/**
 * `aws sso logout` only clears AWS CLI's own caches — it does not know about the
 * `<sha1(sso_session)>.credentials.json` file that `@distilled.cloud/aws`
 * writes alongside the SSO token. Without this cleanup, `loadProfileCredentials`
 * short-circuits on the stale distilled cache file after logout and appears to
 * stay logged in until the role creds hit their TTL.
 */
const clearDistilledSsoCache = (ssoProfile: string) =>
  Effect.gen(function* () {
    const auth = yield* DistilledAuth.Default;
    const profile = yield* auth.loadProfile(ssoProfile);
    const ssoSession = (profile as { sso_session?: string }).sso_session;
    if (!ssoSession) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = NodeCrypto.createHash("sha1").update(ssoSession).digest("hex");
    const cacheFile = path.join(
      NodeOs.homedir(),
      ".aws",
      "sso",
      "cache",
      `${hash}.credentials.json`,
    );
    yield* fs.remove(cacheFile).pipe(Effect.catch(() => Effect.void));
  }).pipe(Effect.catch(() => Effect.void));
