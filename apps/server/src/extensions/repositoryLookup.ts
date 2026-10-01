import { ExtensionOperationError, type SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  configuredRepositoryOrigin,
  isSafeRepositoryIdentifier,
  isSafeRepositoryRemote,
  providerRepositoryHost,
  providerRepositoryPath,
  repositoryRemoteHost,
} from "../sourceControl/remoteValidation.ts";

const invalid = (detail: string) =>
  new ExtensionOperationError({ operation: "source-control.discovery", detail });

function withoutHttpsUserinfo(remote: string) {
  try {
    const url = new URL(remote);
    if (url.protocol !== "https:") return remote;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

/** Extension host policy; native user-initiated lookup remains trusted. */
export const lookupExtensionRepository = Effect.fn("Extensions.lookupRepository")(function* (
  registry: Pick<SourceControlProviderRegistry["Service"], "get" | "repositoryHosts">,
  input: {
    readonly provider: SourceControlProviderKind;
    readonly repository: string;
    readonly cwd: string;
  },
) {
  if (!isSafeRepositoryIdentifier(input.provider, input.repository))
    return yield* invalid("Use a valid provider repository path, such as owner/name.");
  const host = providerRepositoryHost(input.provider, input.repository);
  let origin: URL | null = null;
  if (host !== null) {
    const hosts = yield* registry.repositoryHosts(input.provider);
    // SSH transport ports do not change the authenticated provider authority.
    const sshLocator =
      input.repository.startsWith("ssh://") ||
      (!input.repository.includes("://") && input.repository.includes("@"));
    origin =
      hosts
        .map(configuredRepositoryOrigin)
        .find((url) => (sshLocator ? url?.hostname : url?.host)?.toLowerCase() === host) ?? null;
    if (origin === null)
      return yield* invalid("Choose a repository on an authenticated provider host.");
  }
  const provider = yield* registry.get(input.provider);
  const repository = providerRepositoryPath(input.provider, input.repository);
  if (repository === null) return yield* invalid("Use a valid provider repository path.");
  const raw = yield* provider.getRepositoryCloneUrls({
    cwd: input.cwd,
    repository:
      input.provider === "forgejo" && origin ? `${origin.origin}/${repository}` : repository,
    ...(host && (input.provider === "github" || input.provider === "gitlab") ? { host } : {}),
  });
  if (input.provider === "forgejo" && raw.repositoryHost === undefined)
    return yield* invalid("The provider did not return its authenticated repository origin.");
  const urls =
    input.provider === "bitbucket" || input.provider === "azure-devops"
      ? { ...raw, url: withoutHttpsUserinfo(raw.url) }
      : raw;
  // An unqualified path cannot select a host: the user's CLI default owns the
  // canonical HTTPS response. Forgejo also supplies its resolved login origin.
  const selectedOrigin = origin ?? configuredRepositoryOrigin(raw.repositoryHost ?? urls.url);
  const expectedHost = selectedOrigin?.hostname.toLowerCase() ?? null;
  const allowHttp = input.provider === "forgejo" && selectedOrigin?.protocol === "http:";
  if (expectedHost === null) return yield* invalid("The provider returned an unsafe clone URL.");
  for (const [protocol, remote] of [
    ["https", urls.url],
    ["ssh", urls.sshUrl],
  ] as const) {
    const remoteHost = repositoryRemoteHost(remote);
    const azureSshAlias =
      input.provider === "azure-devops" &&
      protocol === "ssh" &&
      (remote.startsWith("ssh://") || !remote.includes("://")) &&
      ((expectedHost === "dev.azure.com" && remoteHost === "ssh.dev.azure.com") ||
        (expectedHost.endsWith(".visualstudio.com") &&
          expectedHost !== "vs-ssh.visualstudio.com" &&
          remoteHost === "vs-ssh.visualstudio.com"));
    if (
      !isSafeRepositoryRemote(remote, allowHttp) ||
      (remoteHost !== expectedHost && !azureSshAlias)
    )
      return yield* invalid("The provider returned unsafe clone URLs or a different clone host.");
  }
  return {
    provider: input.provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
});
