import { DEFAULT_API_BASE_URL } from "@distilled.cloud/axiom/Credentials";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";

const STORAGE_KEY = "axiom-stored";

const options: Array<{
  value: AxiomAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: "AXIOM_TOKEN (or AXIOM_API_KEY) + optional AXIOM_ORG_ID, AXIOM_URL",
  },
  {
    value: "stored",
    label: "API Token or Personal Access Token",
    hint: "enter credentials interactively, stored in ~/.alchemy/credentials",
  },
];

export type AxiomAuthConfig =
  | { method: "env" }
  | { method: "stored"; credentialType: "apiToken" }
  | { method: "stored"; credentialType: "pat" };

export type AxiomStoredCredentials =
  | { type: "apiToken"; apiToken: string; apiBaseUrl?: string; orgId?: string }
  | { type: "pat"; apiToken: string; apiBaseUrl?: string; orgId: string };

export type AxiomResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      apiBaseUrl: string;
      orgId?: string;
      source: { type: AxiomAuthConfig["method"]; details?: string };
    }
  | {
      type: "pat";
      apiToken: Redacted.Redacted<string>;
      apiBaseUrl: string;
      orgId: string;
      source: { type: AxiomAuthConfig["method"]; details?: string };
    };

export const AXIOM_AUTH_PROVIDER_NAME = "Axiom";

const promptOrgId = (required: boolean) =>
  getEnv("AXIOM_ORG_ID").pipe(
    Effect.flatMap((envOrgId) =>
      Clank.text({
        message: required
          ? "Axiom Org ID (required for PAT)"
          : "Axiom Org ID (Enter to skip)",
        placeholder: envOrgId ?? "",
        defaultValue: envOrgId ?? "",
        validate: required
          ? (v) => (v.length === 0 ? "Required" : undefined)
          : undefined,
      }).pipe(retryOnce),
    ),
  );

/**
 * Layer that registers the Axiom {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Axiom
 * `providers()` layer so `alchemy login` can discover it.
 */
export const AxiomAuth = AuthProviderLayer<
  AxiomAuthConfig,
  AxiomResolvedCredentials
>()(
  AXIOM_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
      const credentialType = yield* Clank.select({
        message: "Axiom credential type",
        options: [
          {
            value: "apiToken" as const,
            label: "API Token",
            hint: "recommended — scoped to specific datasets/actions",
          },
          {
            value: "pat" as const,
            label: "Personal Access Token",
            hint: "full account control, requires Org ID",
          },
        ],
      }).pipe(retryOnce);

      const apiBaseUrlPrompt = yield* Clank.text({
        message: "Axiom API Base URL (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: DEFAULT_API_BASE_URL,
      }).pipe(retryOnce);
      const apiBaseUrl =
        apiBaseUrlPrompt && apiBaseUrlPrompt.length > 0
          ? apiBaseUrlPrompt
          : undefined;

      return yield* Match.value(credentialType).pipe(
        Match.when("apiToken", () =>
          Effect.gen(function* () {
            const apiToken = yield* Clank.password({
              message: "Axiom API Token",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(retryOnce);
            const orgId = yield* promptOrgId(false);

            yield* store.write<AxiomStoredCredentials>(
              profileName,
              STORAGE_KEY,
              {
                type: "apiToken",
                apiToken,
                apiBaseUrl,
                orgId: orgId && orgId.length > 0 ? orgId : undefined,
              },
            );
            yield* Clank.success("Axiom: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiToken" as const,
            };
          }),
        ),
        Match.when("pat", () =>
          Effect.gen(function* () {
            const apiToken = yield* Clank.password({
              message: "Axiom Personal Access Token",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(retryOnce);
            const orgId = yield* promptOrgId(true);

            yield* store.write<AxiomStoredCredentials>(
              profileName,
              STORAGE_KEY,
              { type: "pat", apiToken, apiBaseUrl, orgId },
            );
            yield* Clank.success("Axiom: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "pat" as const,
            };
          }),
        ),
        Match.exhaustive,
      );
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Axiom authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
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

    const resolveCredentials = (
      profileName: string,
      config: AxiomAuthConfig,
    ): Effect.Effect<AxiomResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fnUntraced(function* () {
            const apiToken =
              (yield* getEnvRedacted("AXIOM_TOKEN")) ??
              (yield* getEnvRedacted("AXIOM_API_KEY"));
            if (!apiToken) {
              return yield* new AuthError({
                message:
                  "Axiom env credentials not found. Set AXIOM_TOKEN (or AXIOM_API_KEY).",
              });
            }
            const apiBaseUrl =
              (yield* getEnv("AXIOM_URL")) ?? DEFAULT_API_BASE_URL;
            const orgId = yield* getEnv("AXIOM_ORG_ID");
            if (orgId) {
              return {
                type: "pat" as const,
                apiToken,
                apiBaseUrl,
                orgId,
                source: { type: "env" as const },
              };
            }
            return {
              type: "apiToken" as const,
              apiToken,
              apiBaseUrl,
              source: { type: "env" as const },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<AxiomStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Axiom stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : Effect.succeed(
                    Match.value(creds).pipe(
                      Match.when({ type: "apiToken" }, (c) => ({
                        type: "apiToken" as const,
                        apiToken: Redacted.make(c.apiToken),
                        apiBaseUrl: c.apiBaseUrl ?? DEFAULT_API_BASE_URL,
                        orgId: c.orgId,
                        source: { type: "stored" as const },
                      })),
                      Match.when({ type: "pat" }, (c) => ({
                        type: "pat" as const,
                        apiToken: Redacted.make(c.apiToken),
                        apiBaseUrl: c.apiBaseUrl ?? DEFAULT_API_BASE_URL,
                        orgId: c.orgId,
                        source: { type: "stored" as const },
                      })),
                      Match.exhaustive,
                    ),
                  ),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: AxiomAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Axiom: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AxiomAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .read<AxiomStoredCredentials>(profileName, STORAGE_KEY)
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

    const prettyPrint = (profileName: string, config: AxiomAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) =>
              Effect.all([
                Console.log(`  apiToken: ${displayRedacted(c.apiToken, 9)}`),
                Console.log(`  apiBaseUrl: ${c.apiBaseUrl}`),
                Console.log(`  orgId: ${c.orgId ?? "(none)"}`),
                Console.log(`  source: ${sourceStr}`),
              ]),
            ),
            Match.when({ type: "pat" }, (c) =>
              Effect.all([
                Console.log(`  apiToken: ${displayRedacted(c.apiToken, 9)}`),
                Console.log(`  apiBaseUrl: ${c.apiBaseUrl}`),
                Console.log(`  orgId: ${c.orgId}`),
                Console.log(`  source: ${sourceStr}`),
              ]),
            ),
            Match.exhaustive,
          );
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
      );

    return {
      configure: configureCredentials,
      logout,
      login,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
