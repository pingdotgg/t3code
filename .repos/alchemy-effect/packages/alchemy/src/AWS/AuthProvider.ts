import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { ChildProcess } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  retryOnce,
} from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";

export const AWS_AUTH_PROVIDER_NAME = "AWS";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "stored" }
  | { method: "env" };

const options: Array<{
  value: AwsAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "sso",
    label: "SSO",
    hint: "aws sso login — credentials loaded from AWS SSO cache",
  },
  {
    value: "env",
    label: "Environment Variables",
    hint: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
  },
  {
    value: "stored",
    label: "Stored",
    hint: "stored in ~/.alchemy/credentials",
  },
];

export interface AwsStoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

export interface AwsResolvedCredentials {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  region?: string;
  source: {
    type: AwsAuthConfig["method"];
    details?: string;
  };
}

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
      yield* Effect.fail(
        new AuthError({
          message: `aws sso ${command} exited with code ${exit}`,
        }),
      );
    }
  }).pipe(Effect.scoped);

const loginSSO = (config: Extract<AwsAuthConfig, { method: "sso" }>) =>
  Clank.info(
    `AWS SSO: running 'aws sso login --profile ${config.ssoProfile}'...`,
  ).pipe(
    Effect.andThen(runSsoCommand("login", config.ssoProfile)),
    Effect.matchEffect({
      onSuccess: () => Clank.success("AWS SSO: login complete"),
      onFailure: (e) => Clank.warn(`AWS SSO: login faield: \`${e.message}\``),
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

/**
 * Layer that registers the AWS {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the AWS
 * `providers()` layer so `alchemy login` can discover it.
 */
export const AwsAuth = AuthProviderLayer<
  AwsAuthConfig,
  AwsResolvedCredentials
>()(
  AWS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
      const accessKeyId = yield* Clank.text({
        message: "AWS Access Key ID",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const secretAccessKey = yield* Clank.password({
        message: "AWS Secret Access Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const sessionToken = yield* Clank.text({
        message: "AWS Session Token (optional — press Enter or Esc to skip)",
        placeholder: "(none)",
      }).pipe(Effect.catch(() => Effect.succeed("")));

      const region = yield* Clank.text({
        message: "AWS Region",
        placeholder: "us-east-1",
        defaultValue: "us-east-1",
      }).pipe(retryOnce);

      yield* store.write<AwsStoredCredentials>(profileName, "aws", {
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
      });
      yield* Clank.success("AWS credentials saved.");

      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "AWS authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("sso", () =>
              Effect.gen(function* () {
                const ssoProfile = yield* Clank.text({
                  message: "AWS profile name (from ~/.aws/config)",
                  placeholder: "default",
                  defaultValue: "default",
                });

                const config = {
                  method: "sso" as const,
                  ssoProfile: ssoProfile ?? "default",
                };

                yield* loginSSO(config);

                return config;
              }),
            ),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when(
            { method: "env" },
            Effect.fnUntraced(function* () {
              const accessKeyId =
                yield* getEnvRedactedRequired("AWS_ACCESS_KEY_ID");
              const secretAccessKey = yield* getEnvRedactedRequired(
                "AWS_SECRET_ACCESS_KEY",
              );
              const sessionToken = yield* getEnvRedacted("AWS_SESSION_TOKEN");
              const region = yield* (
                getEnv("AWS_REGION") ??
                  getEnv("AWS_DEFAULT_REGION") ??
                  undefined
              );
              return {
                accessKeyId,
                secretAccessKey,
                sessionToken,
                region,
                source: { type: "env" as const },
              };
            }),
          ),
          Match.when({ method: "stored" }, () =>
            store.read<AwsStoredCredentials>(profileName, "aws").pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "AWS stored credentials not found. Run: alchemy-effect login --configure",
                      }),
                    )
                  : Effect.succeed({
                      accessKeyId: Redacted.make(creds.accessKeyId),
                      secretAccessKey: Redacted.make(creds.secretAccessKey),
                      sessionToken: creds.sessionToken
                        ? Redacted.make(creds.sessionToken)
                        : undefined,
                      region: creds.region,
                      source: { type: "stored" as const },
                    }),
              ),
            ),
          ),
          Match.when({ method: "sso" }, (config) =>
            Effect.gen(function* () {
              const auth = yield* DistilledAuth.Default;
              const creds = yield* auth
                .loadProfileCredentials(config.ssoProfile)
                .pipe(
                  Effect.mapError(
                    (e) =>
                      new AuthError({
                        message: "failed to load credentials",
                        cause: e,
                      }),
                  ),
                );
              const profile = yield* auth
                .loadProfile(config.ssoProfile)
                .pipe(Effect.catch(() => Effect.succeed(undefined)));
              return {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
                region: profile?.region,
                source: { type: "sso" as const, details: config.ssoProfile },
              };
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: AwsAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) =>
          Effect.all([
            Console.log(
              `  accessKeyId:     ${displayRedacted(creds.accessKeyId)}`,
            ),
            Console.log(
              `  secretAccessKey: ${displayRedacted(creds.secretAccessKey)}`,
            ),
            creds.sessionToken
              ? Console.log(
                  `  sessionToken:    ${displayRedacted(creds.sessionToken)}`,
                )
              : Effect.void,
            creds.region
              ? Console.log(`  region:          ${creds.region}`)
              : Effect.void,
            Console.log(
              //@ts-expect-error
              `  source: ${creds.source.details ? `${creds.source.type} - ${creds.source.details}` : creds.source.type}`,
            ),
          ]),
        ),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
      );

    const logout = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "sso" }, (config) =>
          Clank.info(
            `AWS: running 'aws sso logout --profile ${config.ssoProfile}'...`,
          ).pipe(
            Effect.zip(runSsoCommand("logout", config.ssoProfile)),
            Effect.zip(clearDistilledSsoCache(config.ssoProfile)),
            Effect.match({
              onSuccess: () => Clank.success("AWS: SSO logout complete"),
              onFailure: (e) =>
                Clank.warn(`AWS: SSO logout failed: \`${e.message}\``),
            }),
          ),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "aws")
            .pipe(
              Effect.andThen(Clank.success("AWS: stored credentials removed")),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "sso" }, (config) =>
            DistilledAuth.loadProfileCredentials(config.ssoProfile).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Clank.info(
                    `AWS: SSO profile '${config.ssoProfile}' already has valid credentials`,
                  ),
                onFailure: () => loginSSO(config),
              }),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<AwsStoredCredentials>(profileName, "aws")
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    return {
      configure: configureCredentials,
      login,
      logout,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
