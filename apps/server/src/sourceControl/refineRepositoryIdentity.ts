import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { parseGitRemote } from "@t3tools/shared/sourceControl";
import * as Effect from "effect/Effect";

import type { SourceControlProviderContext } from "./SourceControlProvider.ts";

/** The part of `SourceControlProviderRegistry.resolveHandle` the refinement reads. */
type ResolveProviderContext = (input: {
  readonly cwd: string;
  readonly context: SourceControlProviderContext;
}) => Effect.Effect<
  { readonly context: SourceControlProviderContext | null },
  SourceControlProviderError
>;

/**
 * Names the host of a repository whose remote hostname does not, by asking the signed-in
 * provider CLIs. A self-hosted GitLab becomes `gitlab`; a Forgejo, even one its hostname already
 * names, gets the web URL its SSH or sub-path remote cannot spell. Anything else is unchanged.
 */
export const refineRepositoryIdentity = Effect.fn("refineRepositoryIdentity")(function* (
  resolveHandle: ResolveProviderContext,
  identity: RepositoryIdentity,
) {
  const remote = parseGitRemote(identity.locator.remoteUrl);
  const recognised = identity.provider !== undefined && identity.provider !== "unknown";
  if (!remote || !identity.rootPath || (recognised && identity.provider !== "forgejo")) {
    return identity;
  }
  const handle = yield* resolveHandle({
    cwd: identity.rootPath,
    context: {
      provider: { kind: "unknown", name: "Unknown", baseUrl: "" },
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  const refined = handle.context?.provider;
  if (refined?.kind === "gitlab" && !recognised) return { ...identity, provider: "gitlab" };
  if (refined?.kind !== "forgejo") return identity;
  const baseUrl = refined.baseUrl.replace(/\/+$/, "");
  const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
  const path =
    !remote.ssh && basePath && remote.path.startsWith(`${basePath}/`)
      ? remote.path.slice(basePath.length + 1)
      : remote.path;
  return { ...identity, provider: "forgejo", webUrl: `${baseUrl}/${path}` };
});
