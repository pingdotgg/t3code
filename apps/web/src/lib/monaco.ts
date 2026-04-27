import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { getThemeMetadata, type ResolvedThemePreset } from "../theme";

type MonacoEnvironmentShape = {
  getWorker(_: string, label: string): Worker;
};

type MonacoCompilerOptions = {
  allowJs?: boolean;
  allowNonTsExtensions?: boolean;
  allowSyntheticDefaultImports?: boolean;
  checkJs?: boolean;
  esModuleInterop?: boolean;
  jsx?: number;
  module?: number;
  moduleResolution?: number;
  noEmit?: boolean;
  resolveJsonModule?: boolean;
  target?: number;
};

type MonacoDiagnosticsOptions = {
  diagnosticCodesToIgnore?: number[];
  noSemanticValidation?: boolean;
  noSyntaxValidation?: boolean;
  onlyVisible?: boolean;
};

type MonacoLanguageServiceDefaults = {
  addExtraLib(content: string, filePath?: string): { dispose(): void };
  setCompilerOptions(options: MonacoCompilerOptions): void;
  setDiagnosticsOptions(options: MonacoDiagnosticsOptions): void;
  setEagerModelSync(value: boolean): void;
};

type MonacoTypeScriptApi = {
  JsxEmit: {
    ReactJSX: number;
  };
  ModuleKind: {
    ESNext: number;
  };
  ModuleResolutionKind: {
    NodeJs: number;
  };
  ScriptTarget: {
    ESNext: number;
  };
  javascriptDefaults: MonacoLanguageServiceDefaults;
  typescriptDefaults: MonacoLanguageServiceDefaults;
};

let configured = false;
const monacoThemeSignatures = new Map<string, string>();
const diagnosticsToIgnore = [17004, 2307, 2792];
const reactJsxGlobalTypes = `
declare namespace JSX {
  interface Element {}
  interface ElementClass {}
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [elementName: string]: any;
  }
}
`;
const reactJsxRuntimeTypes = `
declare module "react/jsx-runtime" {
  export namespace JSX {
    interface Element {}
    interface IntrinsicElements {
      [elementName: string]: any;
    }
  }

  export const Fragment: unique symbol;
  export function jsx(type: any, props: any, key?: any): JSX.Element;
  export function jsxs(type: any, props: any, key?: any): JSX.Element;
}
`;
const reactJsxDevRuntimeTypes = `
declare module "react/jsx-dev-runtime" {
  export namespace JSX {
    interface Element {}
    interface IntrinsicElements {
      [elementName: string]: any;
    }
  }

  export const Fragment: unique symbol;
  export function jsxDEV(
    type: any,
    props: any,
    key: any,
    isStaticChildren: boolean,
    source: any,
    self: any,
  ): JSX.Element;
}
`;
const monacoTypeScript = monaco.languages.typescript as unknown as MonacoTypeScriptApi;

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHexChannel(value: number): string {
  return clampColorChannel(value).toString(16).padStart(2, "0");
}

function normalizeColorToHex(color: string): string | null {
  const normalized = color.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("#")) {
    return normalized;
  }
  const rgbaMatch = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*(?:\.\d+)?))?\s*\)$/i,
  );
  if (!rgbaMatch) {
    return null;
  }
  const red = rgbaMatch[1];
  const green = rgbaMatch[2];
  const blue = rgbaMatch[3];
  if (!red || !green || !blue) {
    return null;
  }
  const alpha = rgbaMatch[4];
  const alphaChannel = alpha === undefined ? "" : toHexChannel(Number.parseFloat(alpha) * 255);
  return `#${toHexChannel(Number.parseFloat(red))}${toHexChannel(Number.parseFloat(green))}${toHexChannel(Number.parseFloat(blue))}${alphaChannel}`;
}

function withAlpha(hexColor: string, alpha: number): string {
  const normalized = normalizeColorToHex(hexColor);
  if (!normalized) {
    return hexColor;
  }
  const base = normalized.slice(0, 7);
  return `${base}${toHexChannel(alpha * 255)}`;
}

function resolveThemeCssColor(
  targetDocument: Document,
  propertyName: string,
  fallback: string,
): string {
  const root = targetDocument.documentElement;
  const styles = getComputedStyle(root);
  const rawValue = styles.getPropertyValue(propertyName).trim();
  if (!rawValue) {
    return fallback;
  }

  const probe = targetDocument.createElement("div");
  probe.style.color = rawValue;
  probe.style.display = "none";
  root.append(probe);
  const resolved = normalizeColorToHex(getComputedStyle(probe).color) ?? fallback;
  probe.remove();
  return resolved;
}

function buildAppMonacoTheme(
  preset: ResolvedThemePreset,
  targetDocument: Document,
): monaco.editor.IStandaloneThemeData {
  const metadata = getThemeMetadata(preset);
  const background = resolveThemeCssColor(targetDocument, "--background", metadata.chromeColor);
  const foreground = resolveThemeCssColor(targetDocument, "--foreground", metadata.foregroundColor);
  const card = resolveThemeCssColor(targetDocument, "--card", background);
  const border = resolveThemeCssColor(targetDocument, "--border", foreground);
  const primary = resolveThemeCssColor(targetDocument, "--primary", foreground);
  const muted = resolveThemeCssColor(targetDocument, "--muted", card);
  const mutedForeground = resolveThemeCssColor(targetDocument, "--muted-foreground", foreground);

  return {
    base: metadata.mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": withAlpha(mutedForeground, 0.7),
      "editorLineNumber.activeForeground": foreground,
      "editorCursor.foreground": primary,
      "editor.selectionBackground": withAlpha(primary, metadata.mode === "dark" ? 0.28 : 0.2),
      "editor.inactiveSelectionBackground": withAlpha(
        primary,
        metadata.mode === "dark" ? 0.16 : 0.12,
      ),
      "editor.lineHighlightBackground": withAlpha(card, metadata.mode === "dark" ? 0.45 : 0.65),
      "editorIndentGuide.background1": withAlpha(
        mutedForeground,
        metadata.mode === "dark" ? 0.18 : 0.12,
      ),
      "editorIndentGuide.activeBackground1": withAlpha(
        primary,
        metadata.mode === "dark" ? 0.32 : 0.22,
      ),
      "editorWhitespace.foreground": withAlpha(
        mutedForeground,
        metadata.mode === "dark" ? 0.18 : 0.14,
      ),
      "editorGutter.background": background,
      "editorGutter.modifiedBackground": primary,
      "editorGutter.addedBackground": withAlpha("#22c55e", 0.9),
      "editorGutter.deletedBackground": withAlpha("#ef4444", 0.9),
      "editorWidget.background": card,
      "editorWidget.border": withAlpha(border, metadata.mode === "dark" ? 0.6 : 0.8),
      "editorHoverWidget.background": card,
      "editorHoverWidget.border": withAlpha(border, metadata.mode === "dark" ? 0.6 : 0.8),
      "editorSuggestWidget.background": card,
      "editorSuggestWidget.border": withAlpha(border, metadata.mode === "dark" ? 0.6 : 0.8),
      "editorSuggestWidget.selectedBackground": withAlpha(
        muted,
        metadata.mode === "dark" ? 0.8 : 0.9,
      ),
      "scrollbarSlider.background": withAlpha(
        mutedForeground,
        metadata.mode === "dark" ? 0.18 : 0.12,
      ),
      "scrollbarSlider.hoverBackground": withAlpha(
        mutedForeground,
        metadata.mode === "dark" ? 0.28 : 0.2,
      ),
      "scrollbarSlider.activeBackground": withAlpha(
        mutedForeground,
        metadata.mode === "dark" ? 0.36 : 0.28,
      ),
    },
    rules: [],
  };
}

function createWorker(label: string): Worker {
  switch (label) {
    case "json":
      return new jsonWorker();
    case "css":
    case "scss":
    case "less":
      return new cssWorker();
    case "html":
    case "handlebars":
    case "razor":
      return new htmlWorker();
    case "typescript":
    case "javascript":
      return new tsWorker();
    default:
      return new editorWorker();
  }
}

function configureTypeScriptLanguageServices() {
  const compilerOptions: MonacoCompilerOptions = {
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: monacoTypeScript.JsxEmit.ReactJSX,
    module: monacoTypeScript.ModuleKind.ESNext,
    moduleResolution: monacoTypeScript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    resolveJsonModule: true,
    target: monacoTypeScript.ScriptTarget.ESNext,
  };

  monacoTypeScript.typescriptDefaults.setEagerModelSync(true);
  monacoTypeScript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monacoTypeScript.typescriptDefaults.setDiagnosticsOptions({
    diagnosticCodesToIgnore: diagnosticsToIgnore,
    noSemanticValidation: false,
    noSyntaxValidation: false,
    onlyVisible: true,
  });
  monacoTypeScript.typescriptDefaults.addExtraLib(
    reactJsxGlobalTypes,
    "file:///node_modules/@types/react/global.d.ts",
  );
  monacoTypeScript.typescriptDefaults.addExtraLib(
    reactJsxRuntimeTypes,
    "file:///node_modules/@types/react/jsx-runtime.d.ts",
  );
  monacoTypeScript.typescriptDefaults.addExtraLib(
    reactJsxDevRuntimeTypes,
    "file:///node_modules/@types/react/jsx-dev-runtime.d.ts",
  );

  monacoTypeScript.javascriptDefaults.setEagerModelSync(true);
  monacoTypeScript.javascriptDefaults.setCompilerOptions({
    ...compilerOptions,
    allowJs: true,
    checkJs: false,
  });
  monacoTypeScript.javascriptDefaults.setDiagnosticsOptions({
    diagnosticCodesToIgnore: diagnosticsToIgnore,
    noSemanticValidation: true,
    noSyntaxValidation: false,
    onlyVisible: true,
  });
  monacoTypeScript.javascriptDefaults.addExtraLib(
    reactJsxGlobalTypes,
    "file:///node_modules/@types/react/global.d.ts",
  );
  monacoTypeScript.javascriptDefaults.addExtraLib(
    reactJsxRuntimeTypes,
    "file:///node_modules/@types/react/jsx-runtime.d.ts",
  );
  monacoTypeScript.javascriptDefaults.addExtraLib(
    reactJsxDevRuntimeTypes,
    "file:///node_modules/@types/react/jsx-dev-runtime.d.ts",
  );
}

export function ensureMonacoConfigured(): void {
  if (configured) {
    return;
  }

  loader.config({ monaco });
  configureTypeScriptLanguageServices();
  Object.assign(globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentShape }, {
    MonacoEnvironment: {
      getWorker: (_workerId: string, label: string) => createWorker(label),
    } satisfies MonacoEnvironmentShape,
  });
  configured = true;
}

export function ensureAppMonacoTheme(
  preset: ResolvedThemePreset,
  targetDocument?: Document | null,
): string {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  if (!safeDocument) {
    return getThemeMetadata(preset).mode === "dark" ? "vs-dark" : "vs";
  }

  const themeName = `forma-${preset}`;
  const themeData = buildAppMonacoTheme(preset, safeDocument);
  const signature = JSON.stringify(themeData);
  if (monacoThemeSignatures.get(themeName) !== signature) {
    monaco.editor.defineTheme(themeName, themeData);
    monacoThemeSignatures.set(themeName, signature);
  }
  return themeName;
}
