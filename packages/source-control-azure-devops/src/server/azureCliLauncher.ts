// @effect-diagnostics nodeBuiltinImport:off -- The interpreter sits beside the launcher it belongs to.
import * as Context from "effect/Context";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const exists = (filePath: string): boolean => {
  try {
    NodeFS.statSync(filePath);
    return true;
  } catch {
    return false;
  }
};

/** The `AZ_INSTALLER` value each launcher sets, which `az` only reads for its user agent. */
export type AzureCliInstaller = "MSI" | "ZIP";

export interface AzureCliInstall {
  /** The interpreter the launcher runs: `<install>\python.exe -IBm azure.cli`. */
  readonly interpreter: string;
  readonly installer: AzureCliInstaller;
}

const INSTALLERS_BY_LAUNCHER_DIRECTORY: Readonly<Record<string, AzureCliInstaller>> = {
  wbin: "MSI",
  bin: "ZIP",
};

/** The MSI and ZIP builds both launch the interpreter beside the install root, from `wbin` and `bin`. */
export const azureCliInstall = (
  launcherPath: string,
  pathExists: (filePath: string) => boolean = exists,
): AzureCliInstall | undefined => {
  const path = NodePath.win32;
  const extension = path.extname(launcherPath).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return undefined;
  const launcherDirectory = path.dirname(launcherPath);
  const installer =
    INSTALLERS_BY_LAUNCHER_DIRECTORY[path.basename(launcherDirectory).toLowerCase()];
  if (installer === undefined) return undefined;
  const install = path.dirname(launcherDirectory);
  // Another tool's `bin\az.cmd` beside a `python.exe` is not the CLI; the CLI ships its own packages.
  const cliPackage = path.join(install, "Lib", "site-packages", "azure", "cli");
  if (!pathExists(cliPackage)) return undefined;
  const interpreter = path.join(install, "python.exe");
  return pathExists(interpreter) ? { interpreter, installer } : undefined;
};

/** The launcher path comes from the host's PATH, so this reads the Windows layout it names. */
export const AzureCliInstallLocation = Context.Reference<
  (launcherPath: string) => AzureCliInstall | undefined
>("@t3tools/source-control-azure-devops/azureCliInstallLocation", {
  defaultValue: () => azureCliInstall,
});
