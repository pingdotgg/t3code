import {
  requireSettingsSecretLiteral,
  type SettingsSecretUnresolvedError,
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

export interface SavedOrganizationToken {
  /** `dev.azure.com/{organization}`. */
  readonly organization: string;
  readonly token: Redacted.Redacted<string>;
}

/**
 * Tokens the user saved per organization in Source Control settings. A saved token takes
 * precedence over `AZURE_DEVOPS_EXT_PAT` and the `az login` account for its organization only.
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
    /** The token saved for the organization `az --detect` resolves in a checkout, from origin. */
    readonly savedTokenForCheckout: (
      cwd: string,
    ) => Effect.Effect<Option.Option<SavedOrganizationToken>, SettingsSecretUnresolvedError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCredentials") {}

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;

  const savedTokens = host.settings.getWithSecrets(AzureDevOpsClient.definition.kind).pipe(
    Effect.map((settings) => ({
      tokens: readSourceControlHostSettings(
        AzureDevOpsClient.settings,
        settings.sourceControlHosts[AzureDevOpsClient.definition.kind],
      ).tokens,
      secretProviders: settings.secretProviders,
    })),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read Azure DevOps tokens from settings", {
        operation: error.operation,
      }).pipe(
        Effect.as({
          tokens: readSourceControlHostSettings(AzureDevOpsClient.settings, {}).tokens,
          secretProviders: {},
        }),
      ),
    ),
  );

  const tokenFor = (organization: string | null) =>
    organization === null
      ? Effect.succeedNone
      : savedTokens.pipe(
          Effect.flatMap(({ tokens, secretProviders }) =>
            requireSettingsSecretLiteral(tokens[organization], secretProviders),
          ),
          Effect.map((token) => (token ? Option.some(Redacted.make(token)) : Option.none())),
        );

  const originUrl = (cwd: string) =>
    host.git.readConfigValue(cwd, "remote.origin.pushurl").pipe(
      Effect.filterOrElse(
        (pushUrl): pushUrl is string => pushUrl !== null,
        () => host.git.readConfigValue(cwd, "remote.origin.url"),
      ),
      Effect.orElseSucceed(() => null),
    );

  return AzureDevOpsCredentials.of({
    savedToken: Effect.fn("AzureDevOpsCredentials.savedToken")(function* (urlOrRemote) {
      return yield* tokenFor(azureDevOpsOrganizationKey(urlOrRemote));
    }),
    savedTokenForCheckout: Effect.fn("AzureDevOpsCredentials.savedTokenForCheckout")(
      function* (cwd) {
        const { tokens } = yield* savedTokens;
        // Most setups save no token; they should not pay for a git lookup on every az run.
        if (Object.keys(tokens).length === 0) return Option.none();
        const remote = yield* originUrl(cwd);
        const organization = remote === null ? null : azureDevOpsOrganizationKey(remote);
        if (organization === null) return Option.none();
        const token = yield* tokenFor(organization);
        return Option.map(token, (value) => ({ organization, token: value }));
      },
    ),
  });
});

export const layer = Layer.effect(AzureDevOpsCredentials, make);
