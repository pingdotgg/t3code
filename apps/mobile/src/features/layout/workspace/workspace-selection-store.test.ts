import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { getStateFromPath } = requireFromNative("@react-navigation/core") as {
  readonly getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};

const ENVIRONMENT_ID = "environment-1";
const MCP_THREAD_ID = "mcp:7b5c0f3e-2a41-4c8e-9d6b-1f2e3a4b5c6d";

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn() },
  Dimensions: { get: () => ({ width: 1180, height: 820 }) },
  Platform: { OS: "ios" },
}));
// The real createURL, configured as a development build with the dev scheme.
const expoLinking = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const packageJson = createRequire(import.meta.url).resolve("expo-linking/package.json");
  return {
    createURL: packageJson.replace(/package\.json$/, "build/createURL.js"),
    modulesCore: createRequire(packageJson).resolve("expo-modules-core"),
  };
});
vi.mock(expoLinking.modulesCore, () => ({
  Platform: { select: (options: { readonly ios?: unknown }) => options.ios },
}));
vi.mock("expo-constants", () => ({
  default: { executionEnvironment: "bare", expoConfig: { scheme: "t3code-dev" } },
  ExecutionEnvironment: { Bare: "bare", Standalone: "standalone", StoreClient: "storeClient" },
}));
vi.mock("expo/internal/bundle-origin", () => ({ getBundleOrigin: () => null }));
vi.mock("expo-linking", () => import(expoLinking.createURL));
vi.mock("../../../persistence/imperative", () => ({
  loadPreferences: async () => ({
    workspaceSelections: { threads: { environmentId: ENVIRONMENT_ID, threadId: MCP_THREAD_ID } },
  }),
  savePreferencesPatch: async () => undefined,
}));
vi.mock("../../../native/native-layout-metrics", () => ({
  currentNativeLayoutMetrics: () => null,
  firstNativeLayoutMetrics: async () => null,
}));
vi.mock("../../../native/NativeWorkspaceColumns", () => ({
  NATIVE_METRICS_TIMEOUT_MS: 0,
  nativeWorkspaceColumnsSupportedFor: () => true,
}));
vi.mock("../../../lib/layout", () => ({ deriveLayout: () => ({ usesSplitView: true }) }));
// The environment catalog and the chat's snapshot have not loaded yet, as on a cold start.
vi.mock("../../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: { isReady: false } },
}));
vi.mock("../../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../../state/atom-registry", () => ({
  appAtomRegistry: { get: (atom: unknown) => atom },
}));
vi.mock("../../../state/threads", () => ({
  environmentThreadShells: {},
  startOpeningEnvironmentThread: vi.fn(),
  threadEnvironment: { snapshotAtom: () => undefined },
}));

import { launchWorkspaceURL } from "./workspace-selection-store";

it("reopens a remembered chat whose id has reserved characters at that same chat", async () => {
  const url = await launchWorkspaceURL();
  expect(url).not.toBeNull();

  const state = getStateFromPath(url!.replace(/^t3code-dev:\/\//, ""), {
    screens: { Thread: "threads/:environmentId/:threadId" },
  });

  expect(state?.routes.at(-1)).toMatchObject({
    name: "Thread",
    params: { environmentId: ENVIRONMENT_ID, threadId: MCP_THREAD_ID },
  });
});
