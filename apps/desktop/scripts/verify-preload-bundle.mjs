import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { parse } from "acorn";

const expectedDesktopBridgeApis = [
  "getClientPlatform",
  "getLocalEnvironmentBootstraps",
  "pickFolder",
];
const clerkPasskeysGlobal = "__clerk_internal_electron_passkeys";
const preloadExecutionTimeoutMs = 1_000;
const desktopPackage = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const electronVersion = desktopPackage.dependencies.electron;

const isSyntaxNode = (value) =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const inspectBundle = (source) => {
  const runtimeImports = [];
  const visit = (node) => {
    if (node.type === "ImportExpression") {
      throw new Error("Desktop preload bundle contains a dynamic import() call");
    }

    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      if (node.callee.name === "require") {
        const [argument] = node.arguments;
        if (node.arguments.length !== 1 || argument?.type !== "Literal") {
          throw new Error("Desktop preload bundle contains a dynamic require() call");
        }
        if (typeof argument.value !== "string") {
          throw new Error("Desktop preload bundle contains a dynamic require() call");
        }
        runtimeImports.push(argument.value);
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isSyntaxNode(item)) visit(item);
        }
      } else if (isSyntaxNode(child)) {
        visit(child);
      }
    }
  };

  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }));
  return runtimeImports;
};

const createSandboxModules = (exposedGlobals) => {
  const ipcRenderer = {
    invoke: () => Promise.resolve(undefined),
    on: () => undefined,
    removeListener: () => undefined,
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => exposedGlobals.set(name, api),
    },
    ipcRenderer,
  };

  return new Map([
    ["electron", electron],
    ["electron/common", electron],
    ["electron/renderer", electron],
    ["events", NodeEvents.default],
    ["node:events", NodeEvents.default],
    ["timers", NodeTimers.default],
    ["node:timers", NodeTimers.default],
    ["url", NodeURL.default],
    ["node:url", NodeURL.default],
  ]);
};

const executeBundle = (source, sandboxModules) => {
  const sandboxProcess = {
    contextIsolated: true,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone CI verifier supplies the preload's host platform without loading Effect.
    platform: process.platform,
    versions: { electron: electronVersion },
  };
  const requireSandboxModule = (moduleName) => {
    if (!sandboxModules.has(moduleName)) {
      throw new Error(
        `Unsupported sandbox module requested during preload execution: ${moduleName}`,
      );
    }
    return sandboxModules.get(moduleName);
  };

  NodeVM.runInNewContext(
    source,
    {
      process: sandboxProcess,
      require: requireSandboxModule,
    },
    {
      filename: "desktop-preload.cjs",
      timeout: preloadExecutionTimeoutMs,
    },
  );
};

export const verifyPreloadBundle = (source) => {
  const runtimeImports = inspectBundle(source);
  const exposedGlobals = new Map();
  const sandboxModules = createSandboxModules(exposedGlobals);
  const unsupportedImports = [...new Set(runtimeImports)]
    .filter((moduleName) => !sandboxModules.has(moduleName))
    .toSorted();

  if (unsupportedImports.length > 0) {
    throw new Error(
      `Desktop preload bundle contains unsupported sandbox imports: ${unsupportedImports.join(", ")}`,
    );
  }

  executeBundle(source, sandboxModules);

  const desktopBridge = exposedGlobals.get("desktopBridge");
  const missingApis = expectedDesktopBridgeApis.filter(
    (api) => typeof desktopBridge?.[api] !== "function",
  );
  if (!exposedGlobals.has("desktopBridge")) missingApis.unshift("desktopBridge exposure");
  if (!exposedGlobals.has(clerkPasskeysGlobal)) missingApis.push(`${clerkPasskeysGlobal} exposure`);

  if (missingApis.length > 0) {
    throw new Error(`Desktop preload bundle is missing executable APIs: ${missingApis.join(", ")}`);
  }
};

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const preloadUrl = new URL("../dist-electron/preload.cjs", import.meta.url);
  const source = await NodeFSP.readFile(preloadUrl, "utf8");
  verifyPreloadBundle(source);
}
