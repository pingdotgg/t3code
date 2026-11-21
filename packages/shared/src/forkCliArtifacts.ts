/**
 * Fork-only, dependency-free (every runtime imports it). The CLI ships as `lathe` and keeps
 * upstream's `t3` names because older CLIs, SSH runners and self-updating servers still fetch
 * `t3-*` archives and run `<runtime>/t3`. Drop `t3` only once every host runs a dual-name release,
 * and keep the `t3` executable fallback last, for runtimes unpacked before the rename.
 */
import { FORK_IDENTITY } from "./forkIdentity.ts";

/** Upstream's executable name and archive prefix, kept for pre-rename readers. */
const LEGACY_CLI_NAME = "t3";

/** Executable base names, the one to run first. */
const CLI_NAMES = [FORK_IDENTITY.cliBin, LEGACY_CLI_NAME] as const;

/** Either executable base name, as a regex group, for matching paths into a runtime directory. */
export const FORK_CLI_EXECUTABLE_NAME_PATTERN = `(?:${CLI_NAMES.join("|")})`;

/** The executable's file names in a runtime directory, the one to run first. */
export const forkCliExecutableNames = (platform: string): ReadonlyArray<string> =>
  CLI_NAMES.map((name) => (platform === "win32" ? `${name}.exe` : name));

/**
 * The executable to run in `dir`: the first name that exists, or the Lathe
 * name when the directory holds neither yet.
 */
export const forkCliExecutablePath = (
  dir: string,
  platform: string,
  join: (dir: string, name: string) => string,
  exists: (path: string) => boolean,
): string => {
  const candidates = forkCliExecutableNames(platform).map((name) => join(dir, name));
  return candidates.find((candidate) => exists(candidate)) ?? (candidates[0] as string);
};

/** Release asset names of one archive, the one to download first. */
export const forkCliArchiveFileNames = (
  version: string,
  platformKey: string,
): ReadonlyArray<string> => {
  const suffix = `${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
  return CLI_NAMES.map((name) => `${name}-${suffix}`);
};

/**
 * The archive to download from a release, judged by its checksum file: the
 * first name it lists, or the Lathe name when it lists neither (the caller
 * then reports that name as missing).
 */
export const forkCliArchiveFileNameIn = (
  checksums: ReadonlyMap<string, string>,
  version: string,
  platformKey: string,
): string => {
  const candidates = forkCliArchiveFileNames(version, platformKey);
  return candidates.find((name) => checksums.has(name)) ?? (candidates[0] as string);
};

/** The npm launcher's bin script inside the published package. */
export const FORK_NPM_LAUNCHER_SCRIPT = `bin/${FORK_IDENTITY.cliBin}.mjs`;

/**
 * `forkCliExecutablePath` as a POSIX shell expression for a non-Windows
 * runtime directory `dir` (a shell word such as `$LATHE_RUNTIME_DIR`). Expands to
 * `<dir>/lathe` when that is executable, otherwise `<dir>/t3`. Evaluate it
 * inside double quotes.
 */
export const forkCliExecutableShell = (dir: string): string =>
  `$(if [ -x "${dir}/${FORK_IDENTITY.cliBin}" ]; then printf %s "${dir}/${FORK_IDENTITY.cliBin}"; else printf %s "${dir}/${LEGACY_CLI_NAME}"; fi)`;

/**
 * `forkCliArchiveFileNameIn` as a POSIX shell expression. `checksumsFile` is
 * the downloaded SHA256SUMS and `suffix` the asset name after its prefix, for
 * example `$VERSION-$PLATFORM-$ARCH.tar.gz`; both are shell words. Evaluate it
 * inside double quotes.
 */
export const forkCliArchiveShell = (checksumsFile: string, suffix: string): string =>
  `$(for name in ${CLI_NAMES.join(" ")}; do if grep -q " \\*\\{0,1\\}$name-${suffix}$" "${checksumsFile}"; then printf %s "$name-${suffix}"; exit 0; fi; done; printf %s "${FORK_IDENTITY.cliBin}-${suffix}")`;
