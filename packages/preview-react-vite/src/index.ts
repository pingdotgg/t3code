import type { ServerResponse } from "node:http";
import path from "node:path";

import {
  PreviewManifest,
  type PreviewCaseManifest,
  type PreviewManifestEntry,
} from "@forma/contracts";
import type { FormaPreviewConfig, PreviewDefinition } from "@forma/preview-react";
import { Schema } from "effect";
import { glob } from "tinyglobby";
import type { Plugin, ViteDevServer } from "vite";
import { normalizePath } from "vite";

const DEFAULT_SCAN_INCLUDE = ["src/**/*.preview.tsx"] as const;
const DEFAULT_SCAN_EXCLUDE = ["**/*.test.*", "**/*.spec.*", "**/node_modules/**"] as const;

const MANIFEST_ROUTE = "/__forma/manifest";
const RENDER_ROUTE_PREFIX = "/__forma/render/";
const RENDER_RUNTIME_ROUTE = "/__forma/render-runtime.js";
const VIRTUAL_RENDER_RUNTIME_ID = "virtual:forma-preview-runtime";
const RESOLVED_VIRTUAL_RENDER_RUNTIME_ID = `\0${VIRTUAL_RENDER_RUNTIME_ID}`;

interface FormaPreviewVitePluginOptions {
  readonly configPath?: string | undefined;
  readonly globalWrapperImportPath?: string | undefined;
  readonly globalWrapperExportName?: string | undefined;
}

interface ScannedPreviewFile {
  readonly id: string;
  readonly label: string;
  readonly absolutePreviewPath: string;
  readonly previewPath: string;
  readonly componentPath: string;
}

interface LoadedPreviewDefinition {
  readonly file: ScannedPreviewFile;
  readonly definition: PreviewDefinition;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function capitalizeSegment(segment: string): string {
  if (segment.length === 0) {
    return segment;
  }
  return `${segment[0]!.toUpperCase()}${segment.slice(1)}`;
}

function formatDisplayLabel(rawValue: string): string {
  return rawValue
    .split(/[-_.\s/]+/g)
    .filter((segment) => segment.length > 0)
    .map(capitalizeSegment)
    .join(" ");
}

function previewComponentPath(previewPath: string): string {
  return previewPath.replace(/\.preview(\.[cm]?[jt]sx?)$/i, "$1");
}

function defaultPreviewLabel(componentPath: string): string {
  return formatDisplayLabel(path.basename(componentPath, path.extname(componentPath)));
}

function toViteFsPath(absolutePath: string): string {
  return `/@fs/${normalizePath(absolutePath)}`;
}

function respondJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.end(JSON.stringify(value, null, 2));
}

function respondJs(res: ServerResponse, statusCode: number, value: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.end(value);
}

function respondHtml(res: ServerResponse, statusCode: number, value: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.end(value);
}

function resolvePreviewPaths(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): {
  readonly configRoot: string;
  readonly appRoot: string;
  readonly scanInclude: readonly string[];
  readonly scanExclude: readonly string[];
} {
  const configRoot = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
  return {
    configRoot,
    appRoot: path.resolve(configRoot, previewConfig.appRoot),
    scanInclude: previewConfig.scan?.include ?? DEFAULT_SCAN_INCLUDE,
    scanExclude: previewConfig.scan?.exclude ?? DEFAULT_SCAN_EXCLUDE,
  };
}

async function scanPreviewFiles(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<readonly ScannedPreviewFile[]> {
  const { configRoot, appRoot, scanInclude, scanExclude } = resolvePreviewPaths(
    previewConfig,
    configPath,
  );
  const files = await glob(scanInclude, {
    cwd: appRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [...scanExclude],
  });

  return files
    .map((absolutePreviewPath): ScannedPreviewFile => {
      const normalizedAbsolutePreviewPath = path.resolve(absolutePreviewPath);
      const previewPath = toPosixPath(path.relative(configRoot, normalizedAbsolutePreviewPath));
      const componentPath = toPosixPath(
        path.relative(configRoot, previewComponentPath(normalizedAbsolutePreviewPath)),
      );
      const id = toPosixPath(path.relative(appRoot, normalizedAbsolutePreviewPath));
      return {
        id,
        label: defaultPreviewLabel(componentPath),
        absolutePreviewPath: normalizedAbsolutePreviewPath,
        previewPath,
        componentPath,
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function isPreviewDefinition(value: unknown): value is PreviewDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const cases = record.cases;
  if (!cases || typeof cases !== "object") {
    return false;
  }
  return "default" in (cases as Record<string, unknown>);
}

async function loadPreviewDefinition(
  server: ViteDevServer,
  file: ScannedPreviewFile,
): Promise<LoadedPreviewDefinition> {
  const loadedModule = await server.ssrLoadModule(toViteFsPath(file.absolutePreviewPath));
  const definition = loadedModule?.default;
  if (!isPreviewDefinition(definition)) {
    throw new Error(
      `Preview file ${file.previewPath} must export a default definePreview({...}) result.`,
    );
  }
  if (!definition.cases.default) {
    throw new Error(`Preview file ${file.previewPath} must define a default case.`);
  }
  return {
    file: {
      ...file,
      label: definition.label?.trim() || file.label,
    },
    definition,
  };
}

async function buildPreviewManifest(
  server: ViteDevServer,
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<typeof PreviewManifest.Type> {
  const { appRoot } = resolvePreviewPaths(previewConfig, configPath);
  const files = await scanPreviewFiles(previewConfig, configPath);
  const entries: PreviewManifestEntry[] = [];

  for (const file of files) {
    const loaded = await loadPreviewDefinition(server, file);
    const caseEntries = Object.entries(loaded.definition.cases).map(
      ([caseId, previewCase]): PreviewCaseManifest => {
        const label = previewCase.label?.trim() || formatDisplayLabel(caseId);
        if (previewCase.viewport) {
          return {
            id: caseId,
            label,
            viewport: previewCase.viewport,
          };
        }
        return {
          id: caseId,
          label,
        };
      },
    );

    entries.push({
      id: loaded.file.id,
      label: loaded.file.label,
      componentPath: loaded.file.componentPath,
      previewPath: loaded.file.previewPath,
      defaultCaseId: "default",
      cases: caseEntries,
    });
  }

  return Schema.decodeUnknownSync(PreviewManifest)({
    generatedAt: new Date().toISOString(),
    appRoot: toPosixPath(
      path.relative(resolvePreviewPaths(previewConfig, configPath).configRoot, appRoot),
    ),
    entries: entries.toSorted((left, right) => left.label.localeCompare(right.label)),
  });
}

function renderDocument(scriptUrl: string): string {
  return `<!doctype html>
<html lang="en" data-forma-preview-root="true">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Forma Preview</title>
    <style>
      :root {
        color-scheme: light;
        --forma-preview-background: rgb(255, 255, 255);
        --forma-preview-content-width: 100%;
      }

      :root[data-forma-preview-theme="dark"] {
        color-scheme: dark;
        --forma-preview-background: rgb(14, 18, 24);
      }

      html,
      body,
      #root {
        height: 100%;
        margin: 0;
      }

      html[data-forma-preview-root="true"],
      html[data-forma-preview-root="true"] body,
      html[data-forma-preview-root="true"] #root {
        background: transparent !important;
      }

      html[data-forma-preview-root="true"] body::after {
        display: none !important;
      }
    </style>
    <script>
      (() => {
        const params = new URLSearchParams(window.location.search);
        const theme = params.get("theme") === "dark" ? "dark" : "light";
        const viewportWidth = Number.parseInt(params.get("viewportWidth") ?? "", 10);

        document.documentElement.dataset.formaPreviewTheme = theme;
        document.documentElement.classList.toggle("dark", theme === "dark");
        if (Number.isFinite(viewportWidth) && viewportWidth > 0) {
          document.documentElement.style.setProperty(
            "--forma-preview-content-width",
            viewportWidth + "px",
          );
        } else {
          document.documentElement.style.removeProperty("--forma-preview-content-width");
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${scriptUrl}"></script>
  </body>
</html>`;
}

function renderRuntimeModule(input: {
  readonly previewFile: ScannedPreviewFile;
  readonly requestedCaseId: string | null;
  readonly loadToken: string;
  readonly globalWrapperImportPath: string | undefined;
  readonly globalWrapperExportName: string | undefined;
}): string {
  const previewImportPath = toViteFsPath(input.previewFile.absolutePreviewPath);
  const globalWrapperImport = (() => {
    if (!input.globalWrapperImportPath) {
      return "const formaPreviewGlobalWrapper = null;\n";
    }

    const wrapperImportPath = JSON.stringify(
      toViteFsPath(path.resolve(input.globalWrapperImportPath)),
    );
    if (input.globalWrapperExportName && input.globalWrapperExportName !== "default") {
      return `import { ${input.globalWrapperExportName} as formaPreviewGlobalWrapper } from ${wrapperImportPath};\n`;
    }
    return `import formaPreviewGlobalWrapper from ${wrapperImportPath};\n`;
  })();

  return `
import React from "react";
import ReactDOM from "react-dom/client";
import previewDefinition from ${JSON.stringify(previewImportPath)};
${globalWrapperImport}
import { wrapPreviewNode } from "@forma/preview-react";

const previewId = ${JSON.stringify(input.previewFile.id)};
const requestedCaseId = ${JSON.stringify(input.requestedCaseId)};
const loadToken = ${JSON.stringify(input.loadToken)};
const initialViewportWidth = (() => {
  const rawValue = new URLSearchParams(window.location.search).get("viewportWidth");
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
})();
const globalWrapper = formaPreviewGlobalWrapper ?? null;
const preview = previewDefinition;

function postMessageToParent(payload) {
  window.parent?.postMessage(
    {
      source: "forma-preview",
      ...payload,
    },
    "*",
  );
}

function resolvePreviewCase(caseId) {
  const resolvedCase =
    (caseId && preview?.cases?.[caseId]) || preview?.cases?.default || null;
  const resolvedCaseId = caseId && preview?.cases?.[caseId] ? caseId : "default";
  return {
    previewCase: resolvedCase,
    resolvedCaseId,
  };
}

function setViewportWidth(viewportWidth) {
  if (viewportWidth && viewportWidth > 0) {
    document.documentElement.style.setProperty("--forma-preview-content-width", viewportWidth + "px");
  } else {
    document.documentElement.style.removeProperty("--forma-preview-content-width");
  }
}

function sanitizePreviewMessage(error) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Preview render failed.";
}

function isControlMessage(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value;
  return (
    record.source === "forma-preview-parent" &&
    record.type === "update" &&
    record.loadToken === loadToken &&
    typeof record.caseId === "string" &&
    record.caseId.trim().length > 0 &&
    (record.viewportWidth === null ||
      (typeof record.viewportWidth === "number" &&
        Number.isInteger(record.viewportWidth) &&
        record.viewportWidth > 0))
  );
}

class PreviewRootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    postMessageToParent({
      type: "error",
      loadToken,
      previewId,
      caseId: requestedCaseId ?? "default",
      message: sanitizePreviewMessage(error),
    });
  }

  render() {
    if (this.state.error) {
      return null;
    }
    return this.props.children;
  }
}

class PreviewCaseErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.caseId !== this.props.caseId && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error) {
    this.props.onError(sanitizePreviewMessage(error), this.props.caseId);
  }

  render() {
    if (this.state.error) {
      return null;
    }
    return this.props.children;
  }
}

function PreviewCaseFrame({ caseId, renderCase }) {
  React.useEffect(() => {
    postMessageToParent({
      source: "forma-preview",
      type: "ready",
      loadToken,
      previewId,
      caseId,
    });
  }, [caseId]);
  return renderCase();
}

function PreviewRoot() {
  const [activeCaseId, setActiveCaseId] = React.useState(requestedCaseId ?? "default");
  const [activeViewportWidth, setActiveViewportWidth] = React.useState(initialViewportWidth);

  React.useEffect(() => {
    setViewportWidth(activeViewportWidth);
  }, [activeViewportWidth]);

  React.useEffect(() => {
    const handleMessage = (event) => {
      if (!isControlMessage(event.data)) {
        return;
      }

      setActiveCaseId(event.data.caseId);
      setActiveViewportWidth(event.data.viewportWidth);
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const { previewCase, resolvedCaseId } = resolvePreviewCase(activeCaseId);

  if (!preview || !previewCase) {
    const message = requestedCaseId
      ? "Requested preview case was not found."
      : "Preview definition is missing a default case.";
    throw new Error(message);
  }

  return wrapPreviewNode(
    React.createElement(PreviewCaseErrorBoundary, {
      caseId: resolvedCaseId,
      onError: (message, caseId) => {
        postMessageToParent({
          source: "forma-preview",
          type: "error",
          loadToken,
          previewId,
          caseId,
          message,
        });
      },
      children: React.createElement(PreviewCaseFrame, {
        caseId: resolvedCaseId,
        renderCase: previewCase.render,
      }),
    }),
    [globalWrapper, preview.wrapper ?? null],
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Preview root element was not found.");
}

try {
  ReactDOM.createRoot(rootElement).render(
    React.createElement(
      PreviewRootErrorBoundary,
      null,
      React.createElement(PreviewRoot),
    ),
  );
} catch (error) {
  const message = sanitizePreviewMessage(error);
  postMessageToParent({
    source: "forma-preview",
    type: "error",
    loadToken,
    previewId,
    caseId: requestedCaseId ?? "default",
    message,
  });
  throw error;
}
`;
}

function buildRuntimeModuleId(input: {
  readonly previewId: string;
  readonly requestedCaseId: string | null;
  readonly loadToken: string;
}): string {
  const query = new URLSearchParams();
  query.set("previewId", input.previewId);
  if (input.requestedCaseId) {
    query.set("case", input.requestedCaseId);
  }
  query.set("token", input.loadToken);
  return `${VIRTUAL_RENDER_RUNTIME_ID}?${query.toString()}`;
}

function parseRuntimeModuleId(id: string): {
  readonly previewId: string;
  readonly requestedCaseId: string | null;
  readonly loadToken: string;
} | null {
  const rawId = id.startsWith(RESOLVED_VIRTUAL_RENDER_RUNTIME_ID)
    ? id.slice(RESOLVED_VIRTUAL_RENDER_RUNTIME_ID.length)
    : id.startsWith(VIRTUAL_RENDER_RUNTIME_ID)
      ? id.slice(VIRTUAL_RENDER_RUNTIME_ID.length)
      : null;
  if (rawId === null) {
    return null;
  }

  const queryString = rawId.startsWith("?") ? rawId.slice(1) : rawId;
  const params = new URLSearchParams(queryString);
  const previewId = params.get("previewId");
  const loadToken = params.get("token");
  if (!previewId || !loadToken) {
    return null;
  }

  return {
    previewId,
    requestedCaseId: params.get("case"),
    loadToken,
  };
}

function requestedPreviewId(url: URL): string | null {
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith(RENDER_ROUTE_PREFIX)) {
    return null;
  }
  const previewId = pathname.slice(RENDER_ROUTE_PREFIX.length);
  return previewId.length > 0 ? previewId : null;
}

export function formaPreviewVitePlugin(
  previewConfig: FormaPreviewConfig,
  options: FormaPreviewVitePluginOptions = {},
): Plugin {
  return {
    name: "forma-preview-vite",
    resolveId(id) {
      if (id.startsWith(VIRTUAL_RENDER_RUNTIME_ID)) {
        return `${RESOLVED_VIRTUAL_RENDER_RUNTIME_ID}${id.slice(VIRTUAL_RENDER_RUNTIME_ID.length)}`;
      }
      return null;
    },
    async load(id) {
      const runtimeModule = parseRuntimeModuleId(id);
      if (!runtimeModule) {
        return null;
      }

      const files = await scanPreviewFiles(previewConfig, options.configPath);
      const previewFile = files.find((entry) => entry.id === runtimeModule.previewId);
      if (!previewFile) {
        throw new Error(`Unknown preview id: ${runtimeModule.previewId}`);
      }

      return renderRuntimeModule({
        previewFile,
        requestedCaseId: runtimeModule.requestedCaseId,
        loadToken: runtimeModule.loadToken,
        globalWrapperImportPath: options.globalWrapperImportPath,
        globalWrapperExportName: options.globalWrapperExportName,
      });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = req.url ? new URL(req.url, "http://127.0.0.1") : null;
          if (!url) {
            next();
            return;
          }

          if (req.method === "OPTIONS" && url.pathname === MANIFEST_ROUTE) {
            respondJson(res, 200, {});
            return;
          }

          if (url.pathname === MANIFEST_ROUTE) {
            try {
              const manifest = await buildPreviewManifest(
                server,
                previewConfig,
                options.configPath,
              );
              respondJson(res, 200, manifest);
            } catch (error) {
              respondJson(res, 500, {
                message:
                  error instanceof Error ? error.message : "Failed to build preview manifest.",
              });
            }
            return;
          }

          if (url.pathname === RENDER_RUNTIME_ROUTE) {
            try {
              const previewId = url.searchParams.get("previewId");
              if (!previewId) {
                respondJs(
                  res,
                  400,
                  `throw new Error("Missing previewId query parameter for Forma preview runtime.");`,
                );
                return;
              }
              const transformed = await server.transformRequest(
                buildRuntimeModuleId({
                  previewId,
                  requestedCaseId: url.searchParams.get("case"),
                  loadToken: url.searchParams.get("token") ?? "preview-load",
                }),
              );
              if (!transformed) {
                respondJs(
                  res,
                  500,
                  `throw new Error("Failed to transform Forma preview runtime module.");`,
                );
                return;
              }
              respondJs(res, 200, transformed.code);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Failed to build Forma preview runtime.";
              respondJs(res, 500, `throw new Error(${JSON.stringify(message)});`);
            }
            return;
          }

          const previewId = requestedPreviewId(url);
          if (previewId) {
            const scriptUrl = new URL(RENDER_RUNTIME_ROUTE, "http://127.0.0.1");
            scriptUrl.searchParams.set("previewId", previewId);
            const caseId = url.searchParams.get("case");
            if (caseId) {
              scriptUrl.searchParams.set("case", caseId);
            }
            const token = url.searchParams.get("token");
            if (token) {
              scriptUrl.searchParams.set("token", token);
            }
            respondHtml(res, 200, renderDocument(scriptUrl.pathname + scriptUrl.search));
            return;
          }

          next();
        })().catch(next);
      });
    },
  };
}
