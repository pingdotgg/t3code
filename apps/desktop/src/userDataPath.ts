import * as FS from "node:fs";
import * as Path from "node:path";

export function resolveDesktopBaseDirectory(input: {
  readonly configuredHome: string | undefined;
  readonly homeDirectory: string;
  readonly isDevAppFlavor: boolean;
}): string {
  const configuredHome = input.configuredHome?.trim();
  if (configuredHome) {
    return configuredHome;
  }

  return Path.join(input.homeDirectory, input.isDevAppFlavor ? ".t3-dev" : ".t3-alpha");
}

export function resolveUserDataPath(input: {
  readonly appDataDirectory: string;
  readonly canonicalDirectoryName: string;
  readonly legacyDirectoryName: string;
}): string {
  const canonicalPath = Path.join(input.appDataDirectory, input.canonicalDirectoryName);
  if (FS.existsSync(canonicalPath)) {
    return canonicalPath;
  }

  const legacyPath = Path.join(input.appDataDirectory, input.legacyDirectoryName);
  return FS.existsSync(legacyPath) ? legacyPath : canonicalPath;
}
