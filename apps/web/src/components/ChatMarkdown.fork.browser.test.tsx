import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { splitMarkdownDocument } from "../markdown-document";
import { setMarkdownTaskChecked } from "@lathe/shared/markdownTaskEdits";

const { workspaceSearch, filesystemMetadata, renderMermaid } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
  renderMermaid: vi.fn<(source: string, theme: string) => Promise<string>>(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
// Mermaid layout is slow and not what these tests cover; a rendered diagram is its image.
vi.mock(import("@lathe/client-runtime/mermaid-renderer"), async (original) => ({
  ...(await original()),
  renderMermaid,
}));

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";

const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>A to B</text></svg>';

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderMermaid.mockReset().mockResolvedValue(DIAGRAM_SVG);
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

const diagramImage = (container: HTMLElement) =>
  container.querySelector('img[alt="Mermaid diagram"]');

describe("Mermaid chat diagrams", () => {
  it("waits for the closing fence, then renders while the rest of the response streams", async () => {
    setup();
    const message = (text: string) => <ChatMarkdown cwd={undefined} text={text} isStreaming />;
    await using screen = await render(message("```mermaid\ngraph TD; A-->B"));
    const { container, rerender } = screen;
    expect(container.textContent).toContain("Waiting for diagram");
    expect(renderMermaid).not.toHaveBeenCalled();

    await rerender(message("```mermaid\ngraph TD; A-->B\n```\nMore text"));
    await vi.waitFor(() => expect(diagramImage(container)).not.toBeNull());
    expect(container.textContent).toContain("More text");
  });

  it("keeps invalid source readable and offers the agent a repair", async () => {
    setup();
    renderMermaid.mockRejectedValueOnce(new Error("Parse error on line 2"));
    const onRepairMermaid = vi.fn();
    await using screen = await render(
      <ChatMarkdown
        cwd={undefined}
        text={"```mermaid\nbroken diagram\n```\nThe explanation still works."}
        onRepairMermaid={onRepairMermaid}
      />,
    );
    const { container } = screen;
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn’t render this diagram"));
    expect(container.textContent).toContain("broken diagram");
    expect(container.textContent).toContain("The explanation still works.");

    const repair = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Ask agent to fix",
    );
    await act(async () => repair!.click());
    expect(onRepairMermaid).toHaveBeenCalledOnce();
    expect(onRepairMermaid.mock.calls[0]![0]).toContain("broken diagram");
  });
});

describe("ChatMarkdown documents", () => {
  it("typesets a document's math even when chat math is off", async () => {
    setup();
    const text = "Energy is $E = mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$";
    await using document = await render(<ChatMarkdown cwd="/tmp/project" text={text} asDocument />);
    await vi.waitFor(() =>
      expect(document.container.querySelectorAll("[data-markdown-math]")).toHaveLength(2),
    );

    await using chat = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    expect(chat.container.querySelector("[data-markdown-math]")).toBeNull();
    expect(chat.container.textContent).toContain("$E = mc^2$");
  });

  it("anchors headings so the document's own links resolve", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"- [Phase 1](#phase-1-foundation)\n\n## Phase 1: Foundation"}
        asDocument
      />,
    );
    expect(screen.container.querySelector("h2")?.id).toBe("user-content-phase-1-foundation");
  });

  it("marks blocks with their source lines, including drawn code blocks", async () => {
    setup();
    const text = "Intro line\n\n```ts\nconst a = 1;\n```";
    await using document = await render(<ChatMarkdown cwd="/tmp/project" text={text} asDocument />);
    const intro = document.container.querySelector("p");
    expect(intro?.dataset.sourceStart).toBe("1");
    expect(intro?.dataset.sourceEnd).toBe("1");
    expect(
      document.container.querySelector('[data-source-start="3"][data-source-end="5"]'),
    ).not.toBeNull();

    await using chat = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    expect(chat.container.querySelector("[data-source-start]")).toBeNull();
  });

  it("numbers source lines from where a section starts in the file", async () => {
    setup();
    const file = "# Plan\n\nIntro\n\n## Later\n\nLater text\n";
    const section = splitMarkdownDocument(file, { wholeMaxLength: 0, sectionLength: 1 }).at(-1)!;
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text={section.text} documentSection={section} asDocument />,
    );
    const paragraph = [...screen.container.querySelectorAll("p")].find(
      (element) => element.textContent === "Later text",
    );
    expect(paragraph?.dataset.sourceStart).toBe("7");
  });

  it("edits a task in a later section of a long file at its place in the file", async () => {
    setup();
    const file = "# Plan\n\n- [ ] Earlier task\n\n## Later\n\n- [ ] Later task\n";
    const section = splitMarkdownDocument(file, { wholeMaxLength: 0, sectionLength: 1 }).at(-1)!;
    let editedFile: string | undefined;
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={section.text}
        documentSection={section}
        asDocument
        onTaskListChange={({ markerOffset, checked }) => {
          editedFile = setMarkdownTaskChecked(file, markerOffset, checked);
        }}
      />,
    );
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => checkbox!.click());

    expect(section.offset).toBeGreaterThan(0);
    expect(editedFile).toBe("# Plan\n\n- [ ] Earlier task\n\n## Later\n\n- [x] Later task\n");
  });

  it("highlights inline code that names its language", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="Call `const answer = 42{:ts}` first." asDocument />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-chat-markdown-inline-shiki]")).not.toBeNull(),
    );
    expect(screen.container.textContent).toContain("answer");
    expect(screen.container.textContent).not.toContain("{:ts}");
  });
});
