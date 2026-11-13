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

interface SavedTokens {
  readonly tokens: Readonly<Record<string, SettingsSecretValue>>;
  /** Organizations whose saved entry does not decode; they fail closed. */
  readonly malformed: ReadonlySet<string>;
  readonly secretProviders: ServerSettings["secretProviders"];
}

const NO_SAVED_TOKENS: SavedTokens = { tokens: {}, malformed: new Set(), secretProviders: {} };

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
  let lower = url.toLowerCase();
  // `uri_parse` gives the newer SSH remotes, which lack a scheme, one.
  if (
    !lower.startsWith("ssh:") &&
    (lower.includes("vs-ssh.visualstudio.com") || lower.includes("ssh.dev.azure.com"))
  ) {
    lower = `ssh://${lower}`;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1] ?? "";
  const rest = scheme.length === 0 ? lower : lower.slice(scheme.length + 1);
  const authority = rest.startsWith("//") ? (/^\/\/([^/?#]*)/.exec(rest)?.[1] ?? "") : null;
  if (authority === "github.com") return false;
  const path =
    (authority === null ? rest : rest.slice(authority.length + 2)).split(/[?#]/)[0] ?? "";
  return path.includes("/_git/") || path.includes("/_ssh/") || scheme === "ssh";
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
  const decodeEntries = (settings: ServerSettings): SavedTokens => {
    const tokens: Record<string, SettingsSecretValue> = {};
    const malformed = new Set<string>();
    for (const [organization, value] of Object.entries(savedEntries(settings))) {
      const decoded = readSourceControlHostSettings(AzureDevOpsClient.settings, {
        tokens: { [organization]: value },
      }).tokens[organization];
      if (decoded === undefined) malformed.add(organization);
      else tokens[organization] = decoded;
    }
    return { tokens, malformed, secretProviders: settings.secretProviders };
  };

  // Settings are read without secrets first: only a saved Azure DevOps token makes a secret store
  // failure this provider's. Once one is saved, any failure to read it fails closed.
  const savedTokens: Effect.Effect<SavedTokens, SettingsSecretUnresolvedError> =
    host.settings.getStored.pipe(
      Effect.map((settings) => Object.keys(savedEntries(settings)).length > 0),
      Effect.catch((error) =>
        // No cause: a settings decode error can quote a hand-edited token.
        Effect.logWarning("failed to read Azure DevOps tokens from settings", {
          operation: error.operation,
        }).pipe(Effect.as(false)),
      ),
      Effect.flatMap((saved) =>
        saved
          ? host.settings.getWithSecrets(kind).pipe(
              Effect.map(decodeEntries),
              Effect.mapError(
                (error) =>
                  new SettingsSecretUnresolvedError({
                    provider: error.providerInstanceId ?? "secret store",
                  }),
              ),
            )
          : Effect.succeed(NO_SAVED_TOKENS),
      ),
    );

  const tokenFor = (organization: string | null) =>
    organization === null
      ? Effect.succeedNone
      : savedTokens.pipe(
          Effect.flatMap(({ tokens, malformed, secretProviders }) =>
            malformed.has(organization)
              ? Effect.fail(new SettingsSecretUnresolvedError({ provider: "settings" }))
              : requireSettingsSecretLiteral(tokens[organization], secretProviders),
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
        const { tokens, malformed } = yield* savedTokens;
        // Most setups save no token; they should not pay for a git lookup on every az run.
        if (Object.keys(tokens).length === 0 && malformed.size === 0) return Option.none();
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
