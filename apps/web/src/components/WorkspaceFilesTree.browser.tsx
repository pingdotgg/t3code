import "../index.css";

import { type EnvironmentApi, EnvironmentId } from "@forma/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  __resetWorkspaceFilesTreeSessionStateForTests,
  WorkspaceFilesTree,
} from "./WorkspaceFilesTree";

const environmentId = EnvironmentId.make("environment-local");

function setEnvironmentApiOverride(listEntries: ReturnType<typeof vi.fn>) {
  __setEnvironmentApiOverrideForTests(environmentId, {
    projects: {
      listEntries,
      createDirectory: vi.fn(),
      renameEntry: vi.fn(),
      deleteEntry: vi.fn(),
      getLocalAgentInventory: vi.fn(),
      readFile: vi.fn(),
      searchEntries: vi.fn(),
      writeFile: vi.fn(),
    },
  } as unknown as EnvironmentApi);
}

describe("WorkspaceFilesTree", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    __resetWorkspaceFilesTreeSessionStateForTests();
  });

  it("expanding one folder only requests that folder and not sibling directories", async () => {
    const listEntries = vi.fn(async ({ relativePath }: { relativePath?: string | null }) => {
      if (!relativePath) {
        return {
          entries: [
            { path: "src", kind: "directory" },
            { path: "docs", kind: "directory" },
          ],
        };
      }
      if (relativePath === "src") {
        return {
          entries: [{ path: "src/index.ts", kind: "file", parentPath: "src" }],
        };
      }
      if (relativePath === "docs") {
        return {
          entries: [{ path: "docs/readme.md", kind: "file", parentPath: "docs" }],
        };
      }
      return { entries: [] };
    });
    setEnvironmentApiOverride(listEntries);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilesTree
          cwd="/repo/project"
          environmentId={environmentId}
          sessionKey="workspace-tree-browser"
          resolvedTheme="dark"
          selectedFilePath={null}
          onCreateEntry={async ({ kind, relativePath }) => ({ kind, path: relativePath })}
          onRenameEntry={async ({ entry, nextRelativePath }) => ({
            fromPath: entry.path,
            toPath: nextRelativePath,
            kind: entry.kind,
          })}
          onDeleteEntry={async () => undefined}
          onCopyRelativePath={() => undefined}
          onCopyAbsolutePath={() => undefined}
          onOpenInExternalEditor={() => undefined}
          onRefresh={() => undefined}
          onSelectFile={() => undefined}
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("button", { name: /src/i })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: /src/i }));
    await expect.element(page.getByText("index.ts")).toBeInTheDocument();

    expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/project" });
    expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/project", relativePath: "src" });
    expect(listEntries).not.toHaveBeenCalledWith({
      cwd: "/repo/project",
      relativePath: "docs",
    });
  });

  it("cancels inline create on Escape without submitting", async () => {
    const listEntries = vi.fn(async () => ({ entries: [] }));
    const onCreateEntry = vi.fn();
    setEnvironmentApiOverride(listEntries);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilesTree
          cwd="/repo/project"
          environmentId={environmentId}
          sessionKey="workspace-tree-browser-escape"
          resolvedTheme="dark"
          selectedFilePath={null}
          requestedRootCreate={{ nonce: 1, kind: "file" }}
          onCreateEntry={onCreateEntry}
          onRenameEntry={async ({ entry, nextRelativePath }) => ({
            fromPath: entry.path,
            toPath: nextRelativePath,
            kind: entry.kind,
          })}
          onDeleteEntry={async () => undefined}
          onCopyRelativePath={() => undefined}
          onCopyAbsolutePath={() => undefined}
          onOpenInExternalEditor={() => undefined}
          onRefresh={() => undefined}
          onSelectFile={() => undefined}
        />
      </QueryClientProvider>,
    );

    const input = page.getByRole("textbox");
    await expect.element(input).toBeInTheDocument();
    await userEvent.type(input, "draft.ts");
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    expect(onCreateEntry).not.toHaveBeenCalled();
  });

  it("clicking cancel closes inline create without submitting", async () => {
    const listEntries = vi.fn(async () => ({ entries: [] }));
    const onCreateEntry = vi.fn();
    setEnvironmentApiOverride(listEntries);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilesTree
          cwd="/repo/project"
          environmentId={environmentId}
          sessionKey="workspace-tree-browser-cancel"
          resolvedTheme="dark"
          selectedFilePath={null}
          requestedRootCreate={{ nonce: 1, kind: "file" }}
          onCreateEntry={onCreateEntry}
          onRenameEntry={async ({ entry, nextRelativePath }) => ({
            fromPath: entry.path,
            toPath: nextRelativePath,
            kind: entry.kind,
          })}
          onDeleteEntry={async () => undefined}
          onCopyRelativePath={() => undefined}
          onCopyAbsolutePath={() => undefined}
          onOpenInExternalEditor={() => undefined}
          onRefresh={() => undefined}
          onSelectFile={() => undefined}
        />
      </QueryClientProvider>,
    );

    const input = page.getByRole("textbox");
    await expect.element(input).toBeInTheDocument();
    await userEvent.type(input, "draft.ts");
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    expect(onCreateEntry).not.toHaveBeenCalled();
  });
});
