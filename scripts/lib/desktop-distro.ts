/**
 * Public Munim distribution identity for personal-fork desktop builds.
 *
 * Set T3CODE_DESKTOP_DISTRO=munim when packaging installers for munimtech.com.
 * Default (unset) keeps the official T3 Code identity for the private SSH fleet.
 */

export type DesktopDistroId = "default" | "munim";

export interface DesktopDistroIdentity {
  readonly id: DesktopDistroId;
  readonly appId: string;
  readonly productName: string;
  readonly packageName: string;
  readonly artifactName: string;
  readonly description: string;
  readonly author: string;
  readonly updateRepository: string | undefined;
  readonly protocolSchemes: readonly string[];
  readonly protocolName: string;
  readonly linuxExecutableName: string;
  readonly linuxStartupWmClass: string;
  /** .deb control-file Maintainer. */
  readonly linuxMaintainer: string;
  readonly nsisShortcutName: string;
  readonly nsisInstallDirectoryName: string;
  /**
   * Windows .exe file name when it must differ from productName. Taskbar pins
   * and shortcuts point at the exe path, so a rename would break them.
   */
  readonly windowsExecutableName?: string;
}

const OFFICIAL: DesktopDistroIdentity = {
  id: "default",
  appId: "com.t3tools.t3code",
  productName: "T3 Code",
  packageName: "t3code",
  artifactName: "T3-Code-${version}-${arch}.${ext}",
  description: "T3 Code desktop build",
  author: "T3 Tools",
  updateRepository: undefined,
  protocolSchemes: ["t3code", "t3code-dev"],
  protocolName: "T3 Code",
  linuxExecutableName: "t3code",
  linuxStartupWmClass: "t3code",
  linuxMaintainer: "T3 Tools <hello@t3.codes>",
  nsisShortcutName: "T3 Code",
  nsisInstallDirectoryName: "t3code",
};

const MUNIM: DesktopDistroIdentity = {
  id: "munim",
  appId: "com.munim.mtcode",
  // Shown as T3 Code, exe included; ids, folders and schemes stay MT so an
  // existing install keeps its data and links.
  productName: "T3 Code",
  packageName: "mtcode",
  artifactName: "T3-Code-Fork-${version}-${arch}.${ext}",
  description: "T3 Code desktop build",
  author: "T3 Code fork",
  updateRepository: "munimtechnologies/mtcode",
  protocolSchemes: ["mtcode", "mtcode-dev"],
  protocolName: "T3 Code",
  linuxExecutableName: "mtcode",
  linuxStartupWmClass: "mtcode",
  linuxMaintainer: "Munim Technologies <support@munimtech.com>",
  nsisShortcutName: "T3 Code",
  nsisInstallDirectoryName: "mtcode",
};

export function resolveDesktopDistroId(
  raw: string | undefined | null = process.env.T3CODE_DESKTOP_DISTRO,
): DesktopDistroId {
  return raw?.trim() === "munim" ? "munim" : "default";
}

export function resolveDesktopDistroIdentity(
  raw: string | undefined | null = process.env.T3CODE_DESKTOP_DISTRO,
): DesktopDistroIdentity {
  return resolveDesktopDistroId(raw) === "munim" ? MUNIM : OFFICIAL;
}
