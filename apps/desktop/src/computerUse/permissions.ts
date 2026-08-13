// @effect-diagnostics nodeBuiltinImport:off - Sync Chrome preference reads for IPC must stay off the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  DesktopChromeExtensionStatus,
  DesktopComputerUsePermission,
  DesktopComputerUsePermissionsState,
  DesktopComputerUsePrivacyPane,
} from "@t3tools/contracts";
import * as Electron from "electron";

const CHROME_EXTENSION_ID = "kgdolgnijopbghhomnblabjkmjhnoage";

function platformTag(): DesktopComputerUsePermissionsState["platform"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

function screenRecordingStatus(): DesktopComputerUsePermission["status"] {
  try {
    const status = Electron.systemPreferences.getMediaAccessStatus("screen");
    switch (status) {
      case "granted":
        return "granted";
      case "denied":
      case "restricted":
        return "denied";
      case "not-determined":
        return "notDetermined";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

function accessibilityStatus(): DesktopComputerUsePermission["status"] {
  try {
    return Electron.systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

function chromeProfileRoots(): string[] {
  const home = NodeOS.homedir();
  switch (process.platform) {
    case "darwin":
      return [
        NodePath.join(home, "Library/Application Support/Google/Chrome"),
        NodePath.join(home, "Library/Application Support/Google/Chrome Beta"),
        NodePath.join(home, "Library/Application Support/Google/Chrome Canary"),
        NodePath.join(home, "Library/Application Support/Chromium"),
      ];
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? NodePath.join(home, "AppData", "Local");
      return [
        NodePath.join(local, "Google", "Chrome", "User Data"),
        NodePath.join(local, "Google", "Chrome Beta", "User Data"),
        NodePath.join(local, "Chromium", "User Data"),
      ];
    }
    default: {
      const config = process.env.XDG_CONFIG_HOME ?? NodePath.join(home, ".config");
      return [
        NodePath.join(config, "google-chrome"),
        NodePath.join(config, "google-chrome-beta"),
        NodePath.join(config, "chromium"),
      ];
    }
  }
}

function profileDirectories(root: string): string[] {
  try {
    return NodeFS.readdirSync(root, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }
        // Chrome uses "Default" plus "Profile N"; also pick up Guest/System if present.
        return (
          entry.name === "Default" ||
          entry.name.startsWith("Profile ") ||
          entry.name === "Guest Profile" ||
          entry.name === "System Profile"
        );
      })
      .map((entry) => NodePath.join(root, entry.name));
  } catch {
    return [];
  }
}

function chromeExtensionInstalledInPreferences(preferencesPath: string): boolean {
  try {
    const raw = NodeFS.readFileSync(preferencesPath, "utf8");
    const parsed = JSON.parse(raw) as {
      extensions?: {
        settings?: Record<
          string,
          {
            state?: number;
            location?: number;
            path?: string;
            disable_reasons?: unknown;
            was_installed_by_default?: boolean;
          }
        >;
      };
    };
    const entry = parsed.extensions?.settings?.[CHROME_EXTENSION_ID];
    if (!entry) return false;

    // Explicit disable reasons mean it is present but turned off.
    if (entry.disable_reasons !== undefined && entry.disable_reasons !== null) {
      const reasons = entry.disable_reasons;
      if (typeof reasons === "number" && reasons !== 0) return false;
      if (typeof reasons === "object" && Object.keys(reasons as object).length > 0) return false;
    }

    // Chromium: 0 = disabled, 1 = enabled. Unpacked installs often omit `state`
    // in Secure Preferences while still being active (location 4 = UNPACKED).
    if (typeof entry.state === "number") return entry.state === 1;
    if (typeof entry.path === "string" && entry.path.length > 0) return true;
    if (entry.location === 4) return true;
    return true;
  } catch {
    return false;
  }
}

function nativeHostRegistered(root: string): boolean {
  const hostPath = NodePath.join(root, "NativeMessagingHosts", "com.t3tools.t3code.desktop.json");
  try {
    return NodeFS.statSync(hostPath).isFile();
  } catch {
    return false;
  }
}

function resolveChromeExtensionStatus(): {
  status: DesktopChromeExtensionStatus;
  detail: string;
} {
  let sawChrome = false;
  let hostRegistered = false;

  for (const root of chromeProfileRoots()) {
    try {
      if (!NodeFS.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    sawChrome = true;
    if (nativeHostRegistered(root)) hostRegistered = true;

    for (const profile of profileDirectories(root)) {
      const preferenceFiles = [
        NodePath.join(profile, "Secure Preferences"),
        NodePath.join(profile, "Preferences"),
      ];
      for (const preferencesPath of preferenceFiles) {
        if (chromeExtensionInstalledInPreferences(preferencesPath)) {
          return {
            status: "installed",
            detail: "Browser extension installed",
          };
        }
      }
    }
  }

  if (!sawChrome) {
    return {
      status: "unknown",
      detail: "Chrome profile not found on this machine",
    };
  }
  if (hostRegistered) {
    return {
      status: "missing",
      detail: "Native host registered — load the unpacked extension in chrome://extensions",
    };
  }
  return {
    status: "missing",
    detail: "Browser extension not installed",
  };
}

export function readComputerUsePermissions(): DesktopComputerUsePermissionsState {
  const platform = platformTag();
  const chromeExtension = resolveChromeExtensionStatus();

  if (platform !== "darwin") {
    return {
      platform,
      permissions: [
        {
          kind: "accessibility",
          status: "notRequired",
          label: "Accessibility",
        },
        {
          kind: "screenRecording",
          status: "notRequired",
          label: "Screen Recording",
        },
      ],
      chromeExtension,
    };
  }

  return {
    platform,
    permissions: [
      {
        kind: "accessibility",
        status: accessibilityStatus(),
        label: "Accessibility",
      },
      {
        kind: "screenRecording",
        status: screenRecordingStatus(),
        label: "Screen Recording",
      },
    ],
    chromeExtension,
  };
}

function privacySettingsUrl(pane: DesktopComputerUsePrivacyPane): string {
  // Legacy Security preference pane anchors still open the right list on
  // modern macOS and are more reliable than the Settings app deep links.
  switch (pane) {
    case "accessibility":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    case "screenRecording":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  }
}

export async function openComputerUsePrivacySettings(
  pane: DesktopComputerUsePrivacyPane,
): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  // Prompting trust adds this app to the Accessibility list when missing.
  if (pane === "accessibility") {
    try {
      Electron.systemPreferences.isTrustedAccessibilityClient(true);
    } catch {
      // Still open Settings even if the prompt API fails.
    }
  }

  try {
    await Electron.shell.openExternal(privacySettingsUrl(pane));
    return true;
  } catch {
    return false;
  }
}
