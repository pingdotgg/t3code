export interface WslDistro {
  readonly name: string;
  readonly isDefault: boolean;
  readonly version: 1 | 2;
}

export interface WslConfig {
  readonly distro: string | null;
}

// Literal space — \s would also match \n/\t/\r and corrupt UNC paths like \\wsl.localhost\<distro>\...
// Trailing char must also be \w so hand-edited config like "Ubuntu " / "Ubuntu-" / "Ubuntu." rejects.
export const DISTRO_NAME_PATTERN = /^\w(?:[\w \-.]*\w)?$/;

export function parseWslDistroList(stdout: Buffer): readonly WslDistro[] {
  const hasUtf16Bom = stdout.length >= 2 && stdout[0] === 0xff && stdout[1] === 0xfe;
  const likelyUtf16Le =
    hasUtf16Bom ||
    Array.from(stdout.subarray(0, Math.min(stdout.length, 80))).filter(
      (byte, index) => index % 2 === 1 && byte === 0,
    ).length > 10;
  let text = stdout.toString(likelyUtf16Le ? "utf16le" : "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const distros: WslDistro[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const isDefault = line.startsWith("*");
    const cleaned = isDefault ? line.slice(1).trim() : line.trim();
    const fields = cleaned.split(/\s{2,}/);
    if (fields.length < 3) continue;
    const name = fields[0]!.trim();
    const versionNum = parseInt(fields[2]!, 10);
    if (!name || (versionNum !== 1 && versionNum !== 2)) continue;
    distros.push({ name, isDefault, version: versionNum as 1 | 2 });
  }
  return distros;
}

// Recognizes \\wsl.localhost\<distro>\... and the legacy \\wsl$\<distro>\... so
// `wslpath` can be invoked inside the distro that actually owns the path,
// rather than whichever distro is configured for the desktop backend.
export function extractDistroFromUncPath(windowsPath: string): string | null {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)/i.exec(windowsPath);
  if (!match) return null;
  const candidate = match[1]!;
  return DISTRO_NAME_PATTERN.test(candidate) ? candidate : null;
}

export function wslUncPathToLinuxPath(windowsPath: string): string | null {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(windowsPath.trim());
  if (!match) return null;

  const distro = match[1]!;
  if (!DISTRO_NAME_PATTERN.test(distro)) return null;

  const rest = match[2] ?? "";
  if (rest.length === 0) return "/";

  return `/${rest.split("\\").filter(Boolean).join("/")}`;
}

export function resolveWslHomeUncPath(
  config: WslConfig,
  distros: readonly WslDistro[],
): string | null {
  const distroName = config.distro ?? distros.find((distro) => distro.isDefault)?.name ?? null;
  return distroName ? `\\\\wsl.localhost\\${distroName}\\home` : null;
}

export function resolveWslPickFolderDefaultPath(
  rawOptions: unknown,
  config: WslConfig,
  distros: readonly WslDistro[],
  // Absolute Linux path of the user's home dir inside the chosen distro
  // (e.g. "/home/josh"). When known, `~` and `~/...` expand against this so
  // we don't open the picker at a non-existent `/home/<rest>`. When null we
  // fall back to the `/home` parent — wrong directory but at least it exists.
  userHome: string | null = null,
): string | null {
  const homePath = resolveWslHomeUncPath(config, distros);
  if (typeof rawOptions !== "object" || rawOptions === null) {
    return homePath;
  }

  const { initialPath } = rawOptions as { initialPath?: unknown };
  if (typeof initialPath !== "string") {
    return homePath;
  }

  const trimmedPath = initialPath.trim();
  if (trimmedPath.length === 0) {
    return homePath;
  }
  if (trimmedPath.startsWith("\\\\")) {
    return trimmedPath;
  }

  const distroName = config.distro ?? distros.find((distro) => distro.isDefault)?.name ?? null;
  if (!distroName) {
    return homePath;
  }

  const toUncPath = (linuxPath: string) =>
    `\\\\wsl.localhost\\${distroName}${linuxPath.replaceAll("/", "\\")}`;

  const normalizedUserHome = userHome && userHome.startsWith("/") ? userHome : null;

  if (trimmedPath === "~") {
    return normalizedUserHome ? toUncPath(normalizedUserHome) : homePath;
  }
  if (trimmedPath.startsWith("~/")) {
    const remainder = trimmedPath.slice(2);
    if (normalizedUserHome) {
      return toUncPath(`${normalizedUserHome}/${remainder}`);
    }
    return homePath ? `${homePath}\\${remainder.replaceAll("/", "\\")}` : null;
  }
  if (trimmedPath.startsWith("/")) {
    return toUncPath(trimmedPath);
  }

  return homePath;
}

export function isValidDistroName(value: string): boolean {
  return DISTRO_NAME_PATTERN.test(value);
}
