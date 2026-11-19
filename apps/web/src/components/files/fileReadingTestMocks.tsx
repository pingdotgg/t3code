// Module stand-ins for the right panel's reading tests. Each test file's `vi.mock` factories call
// these; this module imports nothing they replace, so a factory can load it while they load.
import type { AssetResource, EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { vi } from "vite-plus/test";

/** What the stand-ins read; `readingSetup` resets it for each test. */
export const state = {
  file: null as ProjectReadFileResult | null,
  files: {} as Record<string, ProjectReadFileResult>,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
  /** Asset URLs by absolute path or attachment id. */
  assets: {} as Record<string, string>,
};

export function resetState() {
  state.file = null;
  state.files = {};
  state.assets = {};
  state.optimistic = null;
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

const keyOf = (resource: AssetResource | null): string =>
  (resource !== null && "path" in resource
    ? resource.path
    : resource !== null && "attachmentId" in resource
      ? resource.attachmentId
      : undefined) ?? "";
const refreshers = new WeakMap<AssetResource, () => Promise<string | null>>();
const noResource = async () => null;

export const mockAssetUrls = (
  actual: typeof import("~/assets/assetUrls"),
): typeof import("~/assets/assetUrls") => ({
  ...actual,
  useAssetUrlState: (_environmentId, resource) => {
    const url = state.assets[keyOf(resource)];
    return url === undefined
      ? { _tag: "Loading" }
      : { _tag: "Success", url, expiresAt: Number.MAX_SAFE_INTEGER };
  },
  // The real hook keeps its function only while it gets the same resource object.
  useAssetUrlRefresh: (_environmentId, resource) => {
    if (resource === null) return noResource;
    let refresh = refreshers.get(resource);
    if (refresh === undefined) {
      const key = keyOf(resource);
      refresh = async () => state.assets[key] ?? null;
      refreshers.set(resource, refresh);
    }
    return refresh;
  },
});

/** Vite's worker transform adds a large inline source map; a blob of the raw file is the same code. */
export async function mockPdfWorkerUrl() {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return { default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })) };
}

/**
 * The Word engine compiles about 30 MB of WebAssembly per document. The stand-in lays out 40
 * blank pages in the real page list, which is what keeps a Word or PowerPoint reader's place.
 */
export async function mockWordDocument() {
  const { OfficePages } = await import("./office/OfficePages");
  const pages = Array.from({ length: 40 }, () => ({ width: 600, height: 800 }));
  const paint = async () => {};
  const ignore = () => {};
  return {
    default: () => <OfficePages pages={pages} paint={paint} kind="page" onError={ignore} />,
  };
}

export const mockRuntime = <T extends object>(actual: T) => ({
  ...actual,
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
});

export const mockSession = <T extends object>(actual: T) => ({
  ...actual,
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
});

export const mockFilesystem = <T extends object>(actual: T) => ({
  ...actual,
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
});

export const mockAtomCommand = <T extends object>(actual: T) => ({
  ...actual,
  useAtomCommand: (() => state.writeFile) as never,
});

const noConfig = Atom.make(null);
export const mockServer = (
  actual: typeof import("~/state/server"),
): typeof import("~/state/server") => ({
  ...actual,
  serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
});

export const mockRemoteOpen = <T extends object>(actual: T) => ({
  ...actual,
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
});

// Without the diff worker pool, Pierre highlights on the page, which has only the dark theme.
export const mockTheme = <T extends object>(actual: T) => ({
  ...actual,
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
  useRenderedAppearance: () => "dark" as never,
});

export const mockPanelParts = {
  mutationRefresh: () => ({ useWorkspaceMutationRefresh: vi.fn() }),
  breadcrumbs: () => ({ FileBreadcrumbs: () => <></> }),
  browser: () => ({ default: () => <div role="tree" /> }),
  diffWorkers: () => ({
    DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  }),
};

// The real query keeps its result while the file does not change, so memoized renders stay memoized.
const queries = new Map<ProjectReadFileResult | null, object>();
const fileQuery = (data: ProjectReadFileResult | null) => {
  let query = queries.get(data);
  if (query === undefined) {
    query = {
      data,
      error: null,
      isPending: false,
      readError: null,
      isNotFile: false,
      isFile: true,
      refresh: vi.fn(),
    };
    queries.set(data, query);
  }
  return query;
};

export const mockProjectFiles = <T extends object>(actual: T) => ({
  ...actual,
  useProjectFileQuery: (_environmentId: EnvironmentId, _cwd: string, path: string | null) =>
    fileQuery((path === null ? undefined : state.files[path]) ?? state.file) as never,
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
});
