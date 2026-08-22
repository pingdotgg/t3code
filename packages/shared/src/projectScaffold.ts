// Helpers for the "create project" flow: a project name maps deterministically
// to a folder slug and a generated favicon, shared by the web client (path
// preview, collision check) and the server (scaffold service).

/** Folder that groups created projects under the add-project base directory. */
export const CREATED_PROJECTS_DIRECTORY_NAME = "t3-projects";

const MAX_PROJECT_SLUG_LENGTH = 64;

/**
 * Maps a human project name to a filesystem-safe folder name: lowercase,
 * alphanumeric runs joined by single dashes. Returns "" when nothing survives
 * (callers treat that as "no valid name yet").
 */
export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROJECT_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** FNV-1a, used to derive a stable hue from the project name. */
function hashProjectName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function projectFaviconLetter(name: string): string {
  const alphanumeric = /[\p{L}\p{N}]/u.exec(name);
  const letter = alphanumeric?.[0] ?? name.trim().at(0) ?? "?";
  return letter.toUpperCase();
}

/**
 * Deterministic project favicon: the first letter of the name in white on a
 * rounded square whose hue hashes from the name. Saturation/lightness are
 * fixed so every icon reads on the true-black sidebar at 16px.
 */
export function generateProjectFaviconSvg(name: string): string {
  const hue = hashProjectName(name) % 360;
  const letter = escapeXml(projectFaviconLetter(name));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">`,
    `<rect width="128" height="128" rx="24" fill="hsl(${hue} 65% 45%)"/>`,
    `<text x="64" y="64" font-family="system-ui, sans-serif" font-size="72" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${letter}</text>`,
    `</svg>`,
    ``,
  ].join("\n");
}

export function generateProjectReadme(name: string): string {
  return `# ${name}\n\nInitialized with T3 Code.\n`;
}
