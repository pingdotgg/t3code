import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

export interface DesktopLauncherMetadata {
  readonly version: 1;
  readonly executablePath: string;
  readonly serverEntryPath: string;
  readonly updatedAt: string;
}

interface ShellProfileOptions {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string | undefined;
  readonly homeDir?: string;
}

interface ManagedLauncherPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const DESKTOP_LAUNCHER_METADATA_FILE = "desktop-launcher.json";
const PATH_SNIPPET_START = "# >>> t3code launcher >>>";
const PATH_SNIPPET_END = "# <<< t3code launcher <<<";

function pathModuleForPlatform(platform: NodeJS.Platform): typeof Path.posix | typeof Path.win32 {
  return platform === "win32" ? Path.win32 : Path.posix;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = Path.extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = FS.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = Path.extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    FS.accessSync(filePath, FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function isWritableDirectory(directory: string): boolean {
  try {
    const stat = FS.statSync(directory);
    if (!stat.isDirectory()) return false;
    FS.accessSync(directory, FS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePreferredInstallDirCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): ReadonlyArray<string> {
  const pathModule = pathModuleForPlatform(platform);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const windowsCandidates = [
      localAppData ? pathModule.join(localAppData, "T3Code", "bin") : null,
      localAppData ? pathModule.join(localAppData, "Microsoft", "WindowsApps") : null,
      pathModule.join(homeDir, "AppData", "Local", "T3Code", "bin"),
    ].filter((candidate): candidate is string => candidate !== null);
    return Array.from(new Set(windowsCandidates));
  }

  const posixCandidates = [
    pathModule.join(homeDir, ".local", "bin"),
    pathModule.join(homeDir, "bin"),
    pathModule.join(homeDir, ".bun", "bin"),
    pathModule.join(homeDir, ".cargo", "bin"),
    pathModule.join(homeDir, ".t3", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return Array.from(new Set(posixCandidates));
}

export function resolveDefaultLauncherStateDir(homeDir = OS.homedir()): string {
  return Path.join(homeDir, ".t3", "userdata");
}

export function resolveDesktopLauncherMetadataPath(
  stateDir = resolveDefaultLauncherStateDir(),
): string {
  return Path.join(stateDir, DESKTOP_LAUNCHER_METADATA_FILE);
}

export function parseDesktopLauncherMetadata(raw: string): DesktopLauncherMetadata | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.executablePath !== "string" ||
      typeof parsed.serverEntryPath !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    const executablePath = parsed.executablePath.trim();
    const serverEntryPath = parsed.serverEntryPath.trim();
    const updatedAt = parsed.updatedAt.trim();
    if (!executablePath || !serverEntryPath || !updatedAt) {
      return null;
    }

    return {
      version: 1,
      executablePath,
      serverEntryPath,
      updatedAt,
    } satisfies DesktopLauncherMetadata;
  } catch {
    return null;
  }
}

export function readDesktopLauncherMetadata(
  stateDir = resolveDefaultLauncherStateDir(),
): DesktopLauncherMetadata | null {
  try {
    const raw = FS.readFileSync(resolveDesktopLauncherMetadataPath(stateDir), "utf8");
    return parseDesktopLauncherMetadata(raw);
  } catch {
    return null;
  }
}

export function writeDesktopLauncherMetadata(
  metadata: DesktopLauncherMetadata,
  stateDir = resolveDefaultLauncherStateDir(),
): void {
  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(
    resolveDesktopLauncherMetadataPath(stateDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export function resolveManagedLauncherBinDir(
  options: ManagedLauncherPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? OS.homedir();
  const pathModule = pathModuleForPlatform(platform);

  const preferredInstallDir = resolvePreferredInstallDirCandidates(platform, env, homeDir).find(
    (candidate) => isDirectoryOnPath(candidate, env, platform) && isWritableDirectory(candidate),
  );
  if (preferredInstallDir) {
    return preferredInstallDir;
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return pathModule.join(localAppData, "T3Code", "bin");
    }
    return pathModule.join(homeDir, "AppData", "Local", "T3Code", "bin");
  }

  return pathModule.join(homeDir, ".t3", "bin");
}

export function resolveManagedLauncherPath(
  options: ManagedLauncherPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const binDir = resolveManagedLauncherBinDir(options);
  return pathModuleForPlatform(platform).join(binDir, platform === "win32" ? "t3.cmd" : "t3");
}

export function resolveLegacyManagedLauncherPath(
  options: ManagedLauncherPathOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }

  const homeDir = options.homeDir ?? OS.homedir();
  return pathModuleForPlatform(platform).join(homeDir, ".t3", "bin", "t3");
}

export function resolveCompatibilityLauncherPaths(
  options: ManagedLauncherPathOptions = {},
): ReadonlyArray<string> {
  const canonicalPath = resolveManagedLauncherPath(options);
  const legacyPath = resolveLegacyManagedLauncherPath(options);
  if (!legacyPath || legacyPath === canonicalPath) {
    return [];
  }
  return [legacyPath];
}

export function isDirectoryOnPath(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathModule = pathModuleForPlatform(platform);
  const normalizedDirectory = pathModule.resolve(directory);
  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;

  const caseInsensitive = platform === "win32" || platform === "darwin";
  const comparePaths = caseInsensitive
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;

  return pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0)
    .some((entry) => comparePaths(pathModule.resolve(entry), normalizedDirectory));
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(Path.join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveShellProfilePath(options: ShellProfileOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }

  const shell = options.shell ?? process.env.SHELL ?? "";
  const homeDir = options.homeDir ?? OS.homedir();
  const shellName = Path.basename(shell || "");

  if (shellName === "fish") {
    return Path.join(homeDir, ".config", "fish", "config.fish");
  }
  if (shellName === "bash") {
    return Path.join(homeDir, platform === "darwin" ? ".bash_profile" : ".bashrc");
  }
  if (shellName === "zsh") {
    return Path.join(homeDir, platform === "darwin" ? ".zprofile" : ".zshrc");
  }

  return Path.join(homeDir, ".profile");
}

export function resolvePathUpdateTarget(options: ShellProfileOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return "your user PATH environment variable";
  }
  return resolveShellProfilePath(options);
}

export function buildPathExportSnippet(
  installDir: string,
  options: ShellProfileOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return "";
  }
  const profilePath = resolveShellProfilePath(options);
  const escapedInstallDir = installDir.replaceAll('"', '\\"');
  const body =
    profilePath?.includes(`${Path.sep}fish${Path.sep}`) === true
      ? `fish_add_path -m "${escapedInstallDir}"`
      : `export PATH="${escapedInstallDir}:$PATH"`;

  return `${PATH_SNIPPET_START}\n${body}\n${PATH_SNIPPET_END}\n`;
}

export function hasManagedPathSnippet(content: string): boolean {
  return content.includes(PATH_SNIPPET_START) && content.includes(PATH_SNIPPET_END);
}
