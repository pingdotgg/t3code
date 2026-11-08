// @effect-diagnostics nodeBuiltinImport:off - pre-ready distro resolution reads the packaged package.json synchronously before app services exist.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DesktopDistroId = "default" | "munim";

export interface RuntimeDesktopDistro {
  readonly id: DesktopDistroId;
  readonly baseName: string;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
  readonly defaultHomeDirName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
}

function readPackagedDistro(appPath: string | undefined): DesktopDistroId | null {
  if (!appPath) return null;
  try {
    const raw = readFileSync(join(appPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { t3DesktopDistro?: string };
    if (pkg.t3DesktopDistro === "munim") return "munim";
  } catch {
    // unpackaged / missing
  }
  return null;
}

export function resolveRuntimeDesktopDistroId(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly appPath?: string | undefined;
  readonly isDevelopment: boolean;
}): DesktopDistroId {
  if (input.env.T3CODE_DESKTOP_DISTRO?.trim() === "munim") return "munim";
  if (!input.isDevelopment) {
    const packaged = readPackagedDistro(input.appPath);
    if (packaged) return packaged;
  }
  return "default";
}

export function resolveRuntimeDesktopDistro(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly appPath?: string | undefined;
  readonly isDevelopment: boolean;
}): RuntimeDesktopDistro {
  const id = resolveRuntimeDesktopDistroId(input);
  if (id === "munim") {
    return {
      id,
      // Shown as T3 Code; the data dirs and ids below stay MT.
      baseName: "T3 Code",
      userDataDirName: input.isDevelopment ? "mt-dev" : "mt",
      legacyUserDataDirName: input.isDevelopment ? "MT Code (Dev)" : "MT Code (Alpha)",
      defaultHomeDirName: ".mt",
      appUserModelId: input.isDevelopment ? "com.munim.mtcode.dev" : "com.munim.mtcode",
      linuxDesktopEntryName: input.isDevelopment ? "mtcode-dev.desktop" : "mtcode.desktop",
      linuxWmClass: input.isDevelopment ? "mtcode-dev" : "mtcode",
    };
  }
  return {
    id,
    baseName: "T3 Code",
    userDataDirName: input.isDevelopment ? "t3code-dev" : "t3code",
    legacyUserDataDirName: input.isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    defaultHomeDirName: ".t3",
    appUserModelId: input.isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
    linuxDesktopEntryName: input.isDevelopment ? "t3code-dev.desktop" : "t3code.desktop",
    linuxWmClass: input.isDevelopment ? "t3code-dev" : "t3code",
  };
}

/**
 * The product name for messages the user reads, resolved from the running
 * build. Main-process code that only needs a name (an error dialog, a keyring
 * hint) can call this instead of threading DesktopEnvironment through.
 */
export function desktopAppDisplayName(
  env: NodeJS.ProcessEnv = process.env,
  appPath?: string,
): string {
  return resolveRuntimeDesktopDistro({
    env,
    ...(appPath === undefined ? {} : { appPath }),
    isDevelopment: false,
  }).baseName;
}
