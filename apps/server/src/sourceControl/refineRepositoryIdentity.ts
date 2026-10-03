import type { RepositoryIdentity } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Effect from "effect/Effect";

import * as ForgejoCli from "./ForgejoCli.ts";
import type * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const UNKNOWN_PROVIDER = { kind: "unknown", name: "Unknown", baseUrl: "" } as const;

/**
 * Settles the provider of an identity whose remote host does not name one, by asking the CLIs
 * signed in on this machine. A self-hosted GitLab or Forgejo is otherwise `unknown`, and
 * clients cannot build its change request URLs, so a bare `#123` has nowhere to point.
 */
export const refineRepositoryIdentity = (
  registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
) =>
  Effect.fn("refineRepositoryIdentity")(function* (identity: RepositoryIdentity) {
    const remote = ForgejoCli.parseForgejoRemote(identity.locator.remoteUrl);
    const unknown = identity.provider === undefined || identity.provider === "unknown";
    if (!remote || !identity.rootPath || (!unknown && identity.provider !== "forgejo"))
      return identity;
    // `glab` matches its logins against the provider name, which is the host for an unknown one.
    const detected = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
    const handle = yield* registry.resolveHandle({
      cwd: identity.rootPath,
      context: {
        provider: detected?.kind === "unknown" ? detected : { ...UNKNOWN_PROVIDER, name: remote.host },
        remoteName: identity.locator.remoteName,
        remoteUrl: identity.locator.remoteUrl,
      },
    });
    const provider = handle.context?.provider;
    if (unknown && provider?.kind === "gitlab") return { ...identity, provider: "gitlab" };
    if (provider?.kind !== "forgejo") return identity;
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
    const path =
      !remote.ssh && basePath && remote.path.startsWith(`${basePath}/`)
        ? remote.path.slice(basePath.length + 1)
        : remote.path;
    return { ...identity, provider: "forgejo", webUrl: `${baseUrl}/${path}` };
  });
