import { requireSettingsSecretLiteral, SettingsSecretUnresolvedError } from "@t3tools/contracts";
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
    /** The token saved for the organization `az --detect` resolves in a checkout. */
    readonly savedTokenForCheckout: (
      cwd: string,
    ) => Effect.Effect<Option.Option<SavedOrganizationToken>, SettingsSecretUnresolvedError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCredentials") {}

/**
 * The push URL `az --detect` reads from `git remote -v`: origin's when it looks like Azure DevOps,
 * otherwise the first other remote's that does. Mirrors the extension's `get_remote_url`.
 */
const azDetectedRemote = (remoteList: string): string | null => {
  const remotes = new Map<string, string>();
  for (const line of remoteList.split("\n")) {
    const [name, url, kind, ...rest] = line.trim().split(/\s+/);
    if (name && url && kind && rest.length === 0) remotes.set(name + kind, url);
  }
  const origin = remotes.get("origin(push)");
  if (origin !== undefined && isAzCandidate(origin)) return origin;
  for (const [key, url] of remotes) {
    if (key !== "origin(push)" && key.endsWith("(push)") && isAzCandidate(url)) return url;
  }
  return null;
};

// The extension's `is_vsts_url_candidate`, with Python's `urlparse` reduced to what it checks.
const isAzCandidate = (url: string): boolean => {
  const lower = url.toLowerCase();
  if (
    !lower.startsWith("ssh:") &&
    (lower.includes("vs-ssh.visualstudio.com") || lower.includes("ssh.dev.azure.com"))
  ) {
    return true;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1] ?? "";
  if (scheme === "ssh") return true;
  const rest = lower.slice(scheme.length === 0 ? 0 : scheme.length + 1);
  const authority = rest.startsWith("//") ? (/^\/\/([^/?#]*)/.exec(rest)?.[1] ?? "") : "";
  if (authority === "github.com") return false;
  const path = rest.slice(rest.startsWith("//") ? authority.length + 2 : 0).split(/[?#]/)[0] ?? "";
  return path.includes("/_git/") || path.includes("/_ssh/");
};

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
      // A token that exists but cannot be read must not pass for no token.
      error.operation === "read-secret"
        ? Effect.fail(
            new SettingsSecretUnresolvedError({
              provider: error.providerInstanceId ?? "secret store",
            }),
          )
        : // No cause: a settings decode error can quote a hand-edited token.
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

  const detectedRemote = (cwd: string) =>
    host.git
      .execute({ operation: "AzureDevOpsCredentials.remotes", cwd, args: ["remote", "-v"] })
      .pipe(
        Effect.map((output) => azDetectedRemote(output.stdout)),
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
        const remote = yield* detectedRemote(cwd);
        const organization = remote === null ? null : azureDevOpsOrganizationKey(remote);
        if (organization === null) return Option.none();
        const token = yield* tokenFor(organization);
        return Option.map(token, (value) => ({ organization, token: value }));
      },
    ),
  });
});

export const layer = Layer.effect(AzureDevOpsCredentials, make);
