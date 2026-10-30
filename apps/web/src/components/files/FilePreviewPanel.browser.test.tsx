import "~/index.css";

import { render } from "../../../test/render";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: readFile,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true }) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("rendered-markdown-scroll");
const cwd = "/workspace";
const files: Record<string, string> = {
  "AGENTS.md": Array.from({ length: 200 }, (_, i) => `Agents paragraph ${i}.`).join("\n\n"),
  "README.md": Array.from({ length: 200 }, (_, i) => `Readme paragraph ${i}.`).join("\n\n"),
};

function panel(relativePath: string) {
  return (
    <div className="flex h-[400px] flex-col">
      <FilePreviewPanel
        environmentId={environmentId}
        cwd={cwd}
        projectName="workspace"
        relativePath={relativePath}
        threadRef={{ environmentId, threadId: ThreadId.make("thread") } as ScopedThreadRef}
        composerDraftTarget={
          { environmentId, threadId: ThreadId.make("thread") } as ScopedThreadRef
        }
        keybindings={[]}
        availableEditors={[]}
        openInShortcutEnabled={false}
        revealLine={null}
        revealRequestId={0}
        onOpenFile={() => {}}
        onNavigateFolder={() => {}}
        folderTrail={undefined}
        onPendingChange={() => {}}
        selectedFilePending={false}
        workspaceMutationId={null}
      />
    </div>
  );
}

function setup() {
  readFile.mockReset();
}

function viewport(container: HTMLElement) {
  const element = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]'),
  ).find((candidate) => candidate.textContent?.includes("paragraph 0."));
  if (!element) throw new Error("rendered markdown viewport is missing");
  return element;
}

describe("rendered markdown file preview", () => {
  // regression: #22300 switching file tabs reset the rendered markdown scroll to the top
  it("keeps each file's scroll position across file tab switches", async () => {
    setup();
    localStorage.setItem("t3code.renderMarkdown", "true");
    localStorage.setItem("t3code.fileExplorerOpen", "false");
    readFile.mockImplementation((_environmentId, _cwd, relativePath: string) => ({
      data: { contents: files[relativePath], truncated: false },
      error: null,
      readError: null,
      isNotFile: false,
      refresh: () => {},
    }));

    await using screen = await render(panel("AGENTS.md"));
    await expect.element(screen.getByText("Agents paragraph 199.")).toBeInTheDocument();
    const agents = viewport(screen.container);
    agents.scrollTop = 1800;
    agents.dispatchEvent(new Event("scroll"));

    await screen.rerender(panel("README.md"));
    await expect.element(screen.getByText("Readme paragraph 0.")).toBeInTheDocument();
    expect(viewport(screen.container).scrollTop).toBe(0);

    await screen.rerender(panel("AGENTS.md"));
    await expect.element(screen.getByText("Agents paragraph 0.")).toBeInTheDocument();
    await vi.waitFor(() => expect(viewport(screen.container).scrollTop).toBe(1800));
  });
});
