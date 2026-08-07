import type { ServerConfig, SourceControlRepositoryInfo } from "@t3tools/contracts";

export type CloudEnvironmentProvider = "render";

interface CloudEnvironmentLike {
  readonly displayUrl: string | null;
  readonly serverConfig: ServerConfig | null;
}

function isRenderHostname(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase().endsWith(".onrender.com");
  } catch {
    return false;
  }
}

export function cloudEnvironmentProvider(
  environment: CloudEnvironmentLike,
): CloudEnvironmentProvider | null {
  const advertisedProvider = environment.serverConfig?.environment.cloud?.provider;
  if (advertisedProvider === "render") {
    return advertisedProvider;
  }
  return environment.displayUrl && isRenderHostname(environment.displayUrl) ? "render" : null;
}

export function cloudEnvironmentWorkspaceRoot(environment: CloudEnvironmentLike): string | null {
  return environment.serverConfig?.environment.cloud?.workspaceRoot ?? null;
}

export function cloudEnvironmentProviderLabel(provider: CloudEnvironmentProvider): string {
  switch (provider) {
    case "render":
      return "Render";
  }
}

export function inferRepositoryDirectoryName(input: {
  readonly repository: SourceControlRepositoryInfo | null;
  readonly remoteUrl: string;
}): string | null {
  const candidate = input.repository?.nameWithOwner ?? input.remoteUrl;
  const withoutQuery = candidate.split(/[?#]/, 1)[0]?.replace(/[\\/]+$/, "") ?? "";
  const segment =
    withoutQuery
      .split(/[\\/:]/)
      .at(-1)
      ?.replace(/\.git$/i, "")
      .trim() ?? "";
  return segment.length > 0 && segment !== "." && segment !== ".." ? segment : null;
}

export function cloudCloneDestination(input: {
  readonly workspaceRoot: string;
  readonly repository: SourceControlRepositoryInfo | null;
  readonly remoteUrl: string;
}): string | null {
  const directoryName = inferRepositoryDirectoryName(input);
  if (!directoryName) {
    return null;
  }
  const workspaceRoot = input.workspaceRoot.trim().replace(/[\\/]+$/, "");
  return workspaceRoot.length > 0 ? `${workspaceRoot}/${directoryName}` : null;
}
