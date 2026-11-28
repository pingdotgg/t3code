// Azure DevOps organization names: letters, digits and inner hyphens.
const ORGANIZATION_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
// git@ssh.dev.azure.com:v3/{org}/… and ssh://git@ssh.dev.azure.com/v3/{org}/…
const SSH_REMOTE =
  /^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\//iu;
const LEGACY_HOST = /^([a-z0-9-]+)\.visualstudio\.com$/u;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

const keyOf = (segment: string): string | null => {
  let name: string;
  try {
    name = decodeURIComponent(segment).toLowerCase();
  } catch {
    return null;
  }
  return ORGANIZATION_NAME.test(name) ? `dev.azure.com/${name}` : null;
};

/**
 * The key a token for an Azure DevOps Services organization is saved under,
 * `dev.azure.com/{organization}`, from a git remote, an API URL, or what a user types in settings
 * (`dev.azure.com/acme`, `https://dev.azure.com/acme/`, `acme.visualstudio.com`). `null` for
 * anything else, such as an on-premises server.
 */
export function azureDevOpsOrganizationKey(input: string): string | null {
  const trimmed = input.trim();
  const ssh = SSH_REMOTE.exec(trimmed);
  if (ssh !== null) return keyOf(ssh[1]!);
  // Parsed as a URL so the organization is the one a request to it reaches, after dot segments.
  const url = URL.parse(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url === null || url.protocol !== "https:" || url.port !== "") return null;
  if (url.hostname === "dev.azure.com") {
    const segment = url.pathname.split("/")[1];
    return segment ? keyOf(segment) : null;
  }
  const legacy = url.hostname === "vs-ssh.visualstudio.com" ? null : LEGACY_HOST.exec(url.hostname);
  return legacy === null ? null : keyOf(legacy[1]!);
}
