import {
  requireSettingsSecretLiteral,
  SettingsSecretUnresolvedError,
  type ServerSettings,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as AzureDevOpsClient from "../shared/definition.ts";
import { azureDevOpsOrganizationKey } from "../shared/organization.ts";

/**
 * Tokens the user saved per organization in Source Control settings. A saved token replaces
 * `AZURE_DEVOPS_EXT_PAT` and the `az login` accounts for its organization only.
 * A saved secret that cannot be read fails rather than passing for no token, so nothing falls
 * back to another account.
 */
export class AzureDevOpsCredentials extends Context.Service<
  AzureDevOpsCredentials,
  {
    /** The token saved for the organization a URL or git remote belongs to. */
    readonly savedToken: (
      urlOrRemote: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SettingsSecretUnresolvedError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCredentials") {}

interface SavedTokens {
  readonly tokens: Readonly<Record<string, SettingsSecretValue>>;
  /** Organizations whose saved entry does not decode; they fail closed. */
  readonly malformed: ReadonlySet<string>;
  readonly secretProviders: ServerSettings["secretProviders"];
  /** Stored nonempty entries must resolve to a token, even if the secret store lost its value. */
  readonly required: ReadonlySet<string>;
}

const NO_SAVED_TOKENS: SavedTokens = {
  tokens: {},
  malformed: new Set(),
  secretProviders: {},
  required: new Set(),
};

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;

  const kind = AzureDevOpsClient.definition.kind;
  const savedEntries = (settings: ServerSettings): Record<string, unknown> => {
    const tokens: unknown = (settings.sourceControlHosts[kind] as { tokens?: unknown } | undefined)
      ?.tokens;
    return tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)
      ? (tokens as Record<string, unknown>)
      : {};
  };

  // Each organization's entry decodes alone, so one malformed entry cannot hide the others.
  const decodeEntries = (settings: ServerSettings, required: ReadonlySet<string>): SavedTokens => {
    const tokens: Record<string, SettingsSecretValue> = {};
    const malformed = new Set<string>();
    for (const [organization, value] of Object.entries(savedEntries(settings))) {
      const decoded = readSourceControlHostSettings(AzureDevOpsClient.settings, {
        tokens: { [organization]: value },
      }).tokens[organization];
      if (decoded === undefined) malformed.add(organization);
      else tokens[organization] = decoded;
    }
    return { tokens, malformed, secretProviders: settings.secretProviders, required };
  };

  // Settings are read without secrets first: only a saved Azure DevOps token makes a secret store
  // failure this provider's. Once one is saved, any failure to read it fails closed.
  const savedTokens: Effect.Effect<SavedTokens, SettingsSecretUnresolvedError> =
    host.settings.getStored.pipe(
      // A failed stored-settings read cannot prove there is no saved account.
      Effect.mapError(() => new SettingsSecretUnresolvedError({ provider: "settings" })),
      Effect.flatMap((stored) => {
        const entries = Object.entries(savedEntries(stored));
        if (entries.length === 0) return Effect.succeed(NO_SAVED_TOKENS);
        const required = new Set(
          entries
            .filter(([, value]) => typeof value !== "string" || value.trim() !== "")
            .map(([organization]) => organization),
        );
        return host.settings.getWithSecrets(kind).pipe(
          Effect.map((settings) => decodeEntries(settings, required)),
          Effect.mapError(
            (error) =>
              new SettingsSecretUnresolvedError({
                provider: error.providerInstanceId ?? "secret store",
              }),
          ),
        );
      }),
    );

  const tokenFor = (organization: string | null) =>
    organization === null
      ? Effect.succeedNone
      : savedTokens.pipe(
          Effect.flatMap(({ tokens, malformed, secretProviders, required }) =>
            malformed.has(organization)
              ? Effect.fail(new SettingsSecretUnresolvedError({ provider: "settings" }))
              : requireSettingsSecretLiteral(tokens[organization], secretProviders).pipe(
                  Effect.filterOrFail(
                    (token) => Boolean(token) || !required.has(organization),
                    () => new SettingsSecretUnresolvedError({ provider: "secret store" }),
                  ),
                ),
          ),
          Effect.map((token) => (token ? Option.some(Redacted.make(token)) : Option.none())),
        );

  return AzureDevOpsCredentials.of({
    savedToken: Effect.fn("AzureDevOpsCredentials.savedToken")(function* (urlOrRemote) {
      return yield* tokenFor(azureDevOpsOrganizationKey(urlOrRemote));
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsCredentials, make);
