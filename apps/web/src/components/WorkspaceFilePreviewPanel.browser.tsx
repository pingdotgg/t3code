import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId, TurnId, type EnvironmentApi } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createElement, type ReactNode } from "react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import type {
  WorkspaceFilePreviewReturnTarget,
  WorkspaceFilePreviewTarget,
} from "../workspaceFilePreview";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { WorkspaceFilePreviewPanel } from "./WorkspaceFilePreviewPanel";

const { fileRenderCalls, resolveEnvironmentHttpUrlMock } = vi.hoisted(() => ({
  fileRenderCalls: [] as Array<{
    file: { contents: string; lang?: string; cacheKey?: string };
    options?: { overflow?: string };
    selectedLines?: { start: number; end: number } | null;
  }>,
  resolveEnvironmentHttpUrlMock: vi.fn(
    (input: { pathname: string; searchParams?: Record<string, string> }) => {
      const url = new URL(`http://environment.test${input.pathname}`);
      if (input.searchParams) {
        url.search = new URLSearchParams(input.searchParams).toString();
      }
      return url.toString();
    },
  ),
}));

vi.mock("../environments/runtime", () => ({
  addSavedEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://environment.test"),
  getPrimaryEnvironmentConnection: vi.fn(() => null),
  getSavedEnvironmentRecord: vi.fn(() => null),
  getSavedEnvironmentRuntimeState: vi.fn(() => null),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: vi.fn(() => []),
  readEnvironmentConnection: vi.fn(() => null),
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(() => {
    throw new Error("Environment connection not found.");
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: resolveEnvironmentHttpUrlMock,
  startEnvironmentConnectionService: vi.fn(),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
  useSavedEnvironmentRegistryStore: vi.fn(() => ({})),
  useSavedEnvironmentRuntimeStore: vi.fn(() => ({})),
  waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");

  return {
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useWorkerPool: () => ({
      getDiffRenderOptions: () => ({ theme: "pierre-dark" }),
      setRenderOptions: vi.fn(async () => undefined),
    }),
    Virtualizer: ({
      children,
      className,
      contentClassName,
    }: {
      children: ReactNode;
      className?: string;
      contentClassName?: string;
    }) =>
      React.createElement(
        "div",
        {
          className,
          "data-testid": "workspace-file-virtualizer",
          style: { height: "100%", overflow: "auto" },
        },
        React.createElement("div", { className: contentClassName }, children),
      ),
    File: (props: {
      file: { contents: string; lang?: string; cacheKey?: string };
      options?: { overflow?: string };
      selectedLines?: { start: number; end: number } | null;
    }) => {
      fileRenderCalls.push(props);
      return React.createElement(
        "div",
        {
          "data-cache-key": props.file.cacheKey,
          "data-lang": props.file.lang,
          "data-overflow": props.options?.overflow,
          "data-testid": "workspace-file-render",
        },
        props.file.contents.split("\n").map((line, index) => {
          const lineNumber = index + 1;
          const selected =
            props.selectedLines !== null &&
            props.selectedLines !== undefined &&
            lineNumber >= props.selectedLines.start &&
            lineNumber <= props.selectedLines.end;

          return React.createElement(
            "div",
            {
              "data-line": lineNumber,
              "data-selected-line": selected ? "single" : undefined,
              key: lineNumber,
              style: { display: "grid", gridTemplateColumns: "3.5rem 1fr", height: 20 },
            },
            React.createElement("span", { "data-column-number": lineNumber }, String(lineNumber)),
            React.createElement("code", null, line.length > 0 ? line : " "),
          );
        }),
      );
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-file-preview-browser");
const DEFAULT_CONTENTS = "export const value = 1;\nconsole.log(value);\n";

function createMockEnvironmentApi(
  readFile: EnvironmentApi["projects"]["readFile"],
): EnvironmentApi {
  return {
    projects: {
      readFile,
      searchEntries: vi.fn(),
      writeFile: vi.fn(),
    },
  } as unknown as EnvironmentApi;
}

function createTarget(input: { relativePath: string; line?: number }): WorkspaceFilePreviewTarget {
  return {
    environmentId: ENVIRONMENT_ID,
    cwd: "/repo/project",
    displayPath: input.relativePath,
    relativePath: input.relativePath,
    ...(input.line ? { line: input.line } : {}),
  };
}

async function renderPreview(input: {
  contents?: string;
  line?: number;
  onReturn?: (target: WorkspaceFilePreviewReturnTarget) => void;
  relativePath?: string;
  returnTarget?: WorkspaceFilePreviewReturnTarget;
  sizeBytes?: number;
  truncated?: boolean;
}) {
  const contents = input.contents ?? DEFAULT_CONTENTS;
  const relativePath = input.relativePath ?? "src/App.tsx";
  const readFile = vi.fn(async () => ({
    relativePath,
    contents,
    sizeBytes: input.sizeBytes ?? new TextEncoder().encode(contents).byteLength,
    truncated: input.truncated ?? false,
  }));
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi(readFile));

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const host = document.createElement("div");
  host.style.height = "260px";
  host.style.width = "720px";
  document.body.append(host);

  const panelProps = {
    mode: "sidebar" as const,
    target: createTarget(
      input.line === undefined ? { relativePath } : { relativePath, line: input.line },
    ),
    ...(input.returnTarget ? { returnTarget: input.returnTarget } : {}),
    ...(input.onReturn ? { onReturn: input.onReturn } : {}),
  };

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        DiffWorkerPoolProvider,
        null,
        createElement(WorkspaceFilePreviewPanel, panelProps),
      ),
    ),
    { container: host },
  );

  await vi.waitFor(() => {
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo/project",
      relativePath,
    });
  });
  await vi.waitFor(() => {
    expect(document.querySelector("[data-testid='workspace-file-render']")).not.toBeNull();
  });

  return {
    readFile,
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

async function renderImagePreview(input: { relativePath?: string } = {}) {
  const relativePath = input.relativePath ?? "assets/chart.png";
  const readFile = vi.fn(async () => {
    throw new Error("Image previews should not read text file contents.");
  });
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi(readFile));

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const host = document.createElement("div");
  host.style.height = "260px";
  host.style.width = "720px";
  document.body.append(host);

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        DiffWorkerPoolProvider,
        null,
        createElement(WorkspaceFilePreviewPanel, {
          mode: "sidebar",
          target: createTarget({ relativePath }),
        }),
      ),
    ),
    { container: host },
  );

  await vi.waitFor(() => {
    expect(
      document.querySelector('img[src^="http://environment.test/api/workspace-image"]'),
    ).not.toBeNull();
  });

  return {
    readFile,
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("WorkspaceFilePreviewPanel", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    fileRenderCalls.length = 0;
    resolveEnvironmentHttpUrlMock.mockClear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders a small highlighted file through the file renderer", async () => {
    const mounted = await renderPreview({});
    try {
      const rendered = document.querySelector<HTMLElement>("[data-testid='workspace-file-render']");
      expect(rendered?.dataset.lang).toBe("tsx");
      expect(rendered?.dataset.cacheKey).toContain("file-preview");
      await expect.element(page.getByText("export const value = 1;")).toBeInTheDocument();
      expect(document.querySelector('[data-column-number="1"]')?.textContent).toBe("1");
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses plain text rendering for large files while keeping virtualization", async () => {
    const contents = `${"x".repeat(80)}\n`.repeat(4_000);
    const mounted = await renderPreview({
      contents,
      relativePath: "src/large.ts",
      sizeBytes: 300 * 1024,
      truncated: true,
    });
    try {
      const rendered = document.querySelector<HTMLElement>("[data-testid='workspace-file-render']");
      const virtualizer = document.querySelector<HTMLElement>(
        "[data-testid='workspace-file-virtualizer']",
      );
      expect(rendered?.dataset.lang).toBe("text");
      expect(virtualizer).not.toBeNull();
      await expect.element(page.getByText("Preview truncated. File size: 300 KB.")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects and scrolls near the requested target line", async () => {
    const contents = Array.from({ length: 160 }, (_, index) => `line ${index + 1}`).join("\n");
    const mounted = await renderPreview({ contents, line: 120, relativePath: "src/lines.ts" });
    try {
      const selected = document.querySelector<HTMLElement>('[data-line="120"]');
      const virtualizer = document.querySelector<HTMLElement>(
        "[data-testid='workspace-file-virtualizer']",
      );
      await vi.waitFor(() => {
        expect(selected?.dataset.selectedLine).toBe("single");
        expect(virtualizer?.scrollTop).toBeGreaterThan(0);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("copies full loaded contents and toggles word wrap", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const mounted = await renderPreview({ contents: DEFAULT_CONTENTS });
    try {
      expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("wrap");

      await page.getByRole("button", { name: "Copy file" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(DEFAULT_CONTENTS);
      });

      await page.getByRole("button", { name: "Disable word wrap" }).click();
      await vi.waitFor(() => {
        expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("scroll");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("calls the return handler when a diff return target is present", async () => {
    const onReturn = vi.fn();
    const returnTarget = {
      kind: "diff",
      diffTurnId: TurnId.make("turn-1"),
      diffFilePath: "src/App.tsx",
    } satisfies WorkspaceFilePreviewReturnTarget;
    const mounted = await renderPreview({
      contents: DEFAULT_CONTENTS,
      onReturn,
      returnTarget,
    });
    try {
      await page.getByRole("button", { name: "Back to diff" }).click();
      expect(onReturn).toHaveBeenCalledWith(returnTarget);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders image files through the workspace image route without reading them as text", async () => {
    const mounted = await renderImagePreview({ relativePath: "assets/chart.png" });
    try {
      const image = document.querySelector<HTMLImageElement>(
        'img[src^="http://environment.test/api/workspace-image"]',
      );
      expect(image?.alt).toBe("assets/chart.png preview");
      expect(image?.src).toBe(
        "http://environment.test/api/workspace-image?cwd=%2Frepo%2Fproject&relativePath=assets%2Fchart.png",
      );
      expect(mounted.readFile).not.toHaveBeenCalled();
      expect(resolveEnvironmentHttpUrlMock).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        pathname: "/api/workspace-image",
        searchParams: {
          cwd: "/repo/project",
          relativePath: "assets/chart.png",
        },
      });
      await expect.element(page.getByRole("button", { name: "Copy file" })).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Disable word wrap" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
