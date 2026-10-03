/** Read Azure repository coordinates without asking the Azure CLI to inspect a checkout. */
export function parseAzureDevOpsRemote(remote: string) {
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(remote);
  if (!remote.includes("://") && !scp) return null;
  let url: URL;
  try {
    url = new URL(remote.includes("://") ? remote : `ssh://${scp?.[1]}/${scp?.[2]}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  let organization: string | undefined;
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    if (parts.length !== 4 || parts.shift() !== "v3") return null;
    organization = parts.shift();
  } else {
    if (host === "dev.azure.com") organization = parts.shift();
    else if (host.endsWith(".visualstudio.com")) {
      organization = host.slice(0, -".visualstudio.com".length);
      if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
    } else return null;
    if (parts.length !== 3 || parts[1] !== "_git") return null;
    parts.splice(1, 1);
  }
  const [project, repository] = parts;
  if (!organization || !project || !repository) return null;
  return {
    organization: `https://dev.azure.com/${encodeURIComponent(organization)}`,
    project,
    repository,
  };
}

/** Prefer the same primary remote as repository identity discovery. */
export function azureDevOpsScopeFromConfig(output: string, remoteName?: string) {
  const remotes = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) remotes.set(match[1], match[2]);
  }
  const remote = remoteName
    ? remotes.get(remoteName)
    : (remotes.get("upstream") ??
      remotes.get("origin") ??
      [...remotes.entries()].sort(([a], [b]) => a.localeCompare(b))[0]?.[1]);
  return remote ? parseAzureDevOpsRemote(remote) : null;
}

export function scopeAzureDevOpsArgs(
  args: ReadonlyArray<string>,
  scope: NonNullable<ReturnType<typeof parseAzureDevOpsRemote>>,
) {
  const scoped = [...args];
  const detect = scoped.indexOf("--detect");
  if (detect === -1 || scoped[detect + 1] !== "true") return scoped;
  scoped[detect + 1] = "false";
  scoped.push("--organization", scope.organization);
  // PR IDs are organization-wide. Those commands and devops invoke do not accept --project.
  const repositoryCommand =
    args[0] === "repos" &&
    (args[1] === "show" ||
      args[1] === "create" ||
      (args[1] === "pr" && (args[2] === "list" || args[2] === "create")));
  if (repositoryCommand && !args.includes("--project") && !args.includes("-p")) {
    scoped.push("--project", scope.project);
  }
  if (
    repositoryCommand &&
    args[1] !== "create" &&
    !args.includes("--repository") &&
    !args.includes("-r")
  ) {
    scoped.push("--repository", scope.repository);
  }
  return scoped;
}
