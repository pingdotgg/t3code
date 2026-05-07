import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type {
  DiscoveredColorTheme,
  EditorThemePreference,
  EditorThemeSource,
  ResolvedColorTheme,
  ThemeKind,
} from "@t3tools/contracts";
import {
  mapVscodeColorsToAppVariables,
  normalizeCssColor,
  normalizeThemeColors,
} from "@t3tools/shared/themeMapping";

interface EditorRoot {
  readonly source: EditorThemeSource;
  readonly extensionsPath: string;
  readonly settingsPath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindFromUiTheme(uiTheme: unknown): ThemeKind {
  if (uiTheme === "hc-light") return "high-contrast-light";
  if (uiTheme === "hc-black") return "high-contrast-dark";
  if (uiTheme === "vs") return "light";
  return "dark";
}

function readJsonOrJsoncFile(filePath: string): unknown | null {
  try {
    return parseJsonc(FS.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeResolveChild(root: string, relativePath: string): string | null {
  const resolved = Path.resolve(root, relativePath);
  const normalizedRoot = Path.resolve(root);
  if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${Path.sep}`)) {
    return resolved;
  }
  return null;
}

export function resolveEditorRoots(input: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly appData?: string;
}): readonly EditorRoot[] {
  const home = input.homedir;
  if (input.platform === "win32") {
    const appData = input.appData ?? Path.join(home, "AppData", "Roaming");
    return [
      {
        source: "vscode",
        extensionsPath: Path.join(home, ".vscode", "extensions"),
        settingsPath: Path.join(appData, "Code", "User", "settings.json"),
      },
      {
        source: "vscode-insiders",
        extensionsPath: Path.join(home, ".vscode-insiders", "extensions"),
        settingsPath: Path.join(appData, "Code - Insiders", "User", "settings.json"),
      },
      {
        source: "cursor",
        extensionsPath: Path.join(home, ".cursor", "extensions"),
        settingsPath: Path.join(appData, "Cursor", "User", "settings.json"),
      },
    ];
  }

  if (input.platform === "darwin") {
    return [
      {
        source: "vscode",
        extensionsPath: Path.join(home, ".vscode", "extensions"),
        settingsPath: Path.join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "settings.json",
        ),
      },
      {
        source: "vscode-insiders",
        extensionsPath: Path.join(home, ".vscode-insiders", "extensions"),
        settingsPath: Path.join(
          home,
          "Library",
          "Application Support",
          "Code - Insiders",
          "User",
          "settings.json",
        ),
      },
      {
        source: "cursor",
        extensionsPath: Path.join(home, ".cursor", "extensions"),
        settingsPath: Path.join(
          home,
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "settings.json",
        ),
      },
    ];
  }

  return [
    {
      source: "vscode",
      extensionsPath: Path.join(home, ".vscode", "extensions"),
      settingsPath: Path.join(home, ".config", "Code", "User", "settings.json"),
    },
    {
      source: "vscode-insiders",
      extensionsPath: Path.join(home, ".vscode-insiders", "extensions"),
      settingsPath: Path.join(home, ".config", "Code - Insiders", "User", "settings.json"),
    },
    {
      source: "cursor",
      extensionsPath: Path.join(home, ".cursor", "extensions"),
      settingsPath: Path.join(home, ".config", "Cursor", "User", "settings.json"),
    },
  ];
}

function resolveDefaultEditorRoots() {
  const input: { platform: NodeJS.Platform; homedir: string; appData?: string } = {
    platform: process.platform,
    homedir: OS.homedir(),
  };
  if (process.env.APPDATA) input.appData = process.env.APPDATA;
  return resolveEditorRoots(input);
}

function readEditorSettings(settingsPath: string): Record<string, unknown> {
  const parsed = readJsonOrJsoncFile(settingsPath);
  return isObject(parsed) ? parsed : {};
}

export function getEditorThemePreferences(
  roots = resolveDefaultEditorRoots(),
): readonly EditorThemePreference[] {
  return roots.map((root) => {
    const settings = readEditorSettings(root.settingsPath);
    const customizations = settings["workbench.colorCustomizations"];
    return {
      source: root.source,
      colorTheme:
        typeof settings["workbench.colorTheme"] === "string"
          ? settings["workbench.colorTheme"]
          : null,
      preferredLightColorTheme:
        typeof settings["workbench.preferredLightColorTheme"] === "string"
          ? settings["workbench.preferredLightColorTheme"]
          : null,
      preferredDarkColorTheme:
        typeof settings["workbench.preferredDarkColorTheme"] === "string"
          ? settings["workbench.preferredDarkColorTheme"]
          : null,
      autoDetectColorScheme: settings["window.autoDetectColorScheme"] === true,
      workbenchColorCustomizations: isObject(customizations) ? customizations : {},
      editorTokenColorCustomizations: settings["editor.tokenColorCustomizations"],
    };
  });
}

export function discoverEditorColorThemes(
  roots = resolveDefaultEditorRoots(),
): readonly DiscoveredColorTheme[] {
  const themes: DiscoveredColorTheme[] = [];

  for (const root of roots) {
    if (!FS.existsSync(root.extensionsPath)) continue;

    for (const entry of FS.readdirSync(root.extensionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const extensionDir = Path.join(root.extensionsPath, entry.name);
      const packagePath = Path.join(extensionDir, "package.json");
      const packageJson = readJsonOrJsoncFile(packagePath);
      if (!isObject(packageJson)) continue;

      const contributes = packageJson.contributes;
      const contributedThemes = isObject(contributes) ? contributes.themes : null;
      if (!Array.isArray(contributedThemes)) continue;

      for (const theme of contributedThemes) {
        if (!isObject(theme) || typeof theme.label !== "string" || typeof theme.path !== "string") {
          continue;
        }

        const themePath = safeResolveChild(extensionDir, theme.path);
        if (!themePath || !FS.existsSync(themePath)) continue;

        themes.push({
          id: `${root.source}:${entry.name}:${theme.label}`,
          source: root.source,
          extensionId: entry.name,
          extensionDisplayName:
            typeof packageJson.displayName === "string" ? packageJson.displayName : undefined,
          label: theme.label,
          kind: kindFromUiTheme(theme.uiTheme),
          themePath,
          packagePath,
          publisher: typeof packageJson.publisher === "string" ? packageJson.publisher : undefined,
        });
      }
    }
  }

  return themes.toSorted((a, b) => a.label.localeCompare(b.label));
}

function mergeWorkbenchOverrides(input: {
  readonly themeLabel: string;
  readonly themeColors: Record<string, string>;
  readonly customizations: Record<string, unknown>;
}) {
  const next = { ...input.themeColors };

  for (const [key, rawValue] of Object.entries(input.customizations)) {
    if (key.startsWith("[") && key.endsWith("]")) continue;
    const color = normalizeCssColor(rawValue);
    if (color) next[key] = color;
  }

  const scoped = input.customizations[`[${input.themeLabel}]`];
  if (isObject(scoped)) {
    for (const [key, rawValue] of Object.entries(scoped)) {
      const color = normalizeCssColor(rawValue);
      if (color) next[key] = color;
    }
  }

  return next;
}

export function loadEditorColorTheme(
  themeId: string,
  roots = resolveDefaultEditorRoots(),
): ResolvedColorTheme | null {
  const themes = discoverEditorColorThemes(roots);
  const theme = themes.find((entry) => entry.id === themeId);
  if (!theme) return null;

  const rawTheme = readJsonOrJsoncFile(theme.themePath);
  if (!isObject(rawTheme)) return null;

  const preferences = getEditorThemePreferences(roots);
  const preference = preferences.find((entry) => entry.source === theme.source);
  const colors = mergeWorkbenchOverrides({
    themeLabel: theme.label,
    themeColors: normalizeThemeColors(rawTheme.colors),
    customizations: preference?.workbenchColorCustomizations ?? {},
  });

  return {
    id: theme.id,
    label: theme.label,
    source: theme.source,
    kind: theme.kind,
    colors,
    tokenColors: rawTheme.tokenColors ?? [],
    semanticHighlighting:
      typeof rawTheme.semanticHighlighting === "boolean"
        ? rawTheme.semanticHighlighting
        : undefined,
    semanticTokenColors: rawTheme.semanticTokenColors,
    appVariables: mapVscodeColorsToAppVariables({ kind: theme.kind, colors }),
  };
}
