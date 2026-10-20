import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { AsyncResult } from "effect/reactivity";
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { useTheme } from "../hooks/useTheme";
import { applyThemeColorPreview, getStandardThemeColors } from "../themePalette";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { MarkdownFindContext } from "./chat/markdownFindContext";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
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
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

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
import { serializeTableElementToCsv, chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { captureAssistantTextSelection } from "../lib/assistantTextSelection";

const roots: Root[] = [];

beforeEach(() => {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  CSS.highlights.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
  };
}

async function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return (await render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />)).container;
}

function linkTexts(container: HTMLElement) {
  return [...container.querySelectorAll("a")].map((link) => link.textContent);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

function fileOptions(container: HTMLElement) {
  return [...container.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label?.startsWith("File options for "));
}

describe("ChatMarkdown theme drafts", () => {
  afterEach(() => {
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
  });

  it.each(["dark", "light"] as const)(
    "previews opposite syntax colors and restores saved %s colors on cancel",
    async (savedAppearance) => {
      let selection: ReturnType<typeof useTheme>;
      function Preview() {
        const theme = useTheme();
        useEffect(() => {
          selection = theme;
        }, [theme]);
        return <ChatMarkdown cwd={undefined} text={"```typescript\nconst answer = 42;\n```"} />;
      }
      await getSyntaxHighlighterPromise("typescript");
      const { container } = await render(<Preview />);
      await act(async () => {
        selection.setTheme(savedAppearance);
        selection.setAppearanceMode(savedAppearance);
      });
      const keywordColor = () =>
        container.querySelector<HTMLElement>(".chat-markdown-shiki .line span")?.style.color;
      await vi.waitFor(() => expect(keywordColor()).toBeTruthy());
      const savedColor = keywordColor();
      const savedStorage = Object.fromEntries(Object.entries(localStorage));
      const draftAppearance = savedAppearance === "dark" ? "light" : "dark";

      await act(async () =>
        applyThemeColorPreview(getStandardThemeColors(draftAppearance), draftAppearance),
      );
      await vi.waitFor(() => {
        expect(keywordColor()).toBeTruthy();
        expect(keywordColor()).not.toBe(savedColor);
      });
      expect(document.documentElement.classList.contains("dark")).toBe(draftAppearance === "dark");
      expect(selection!).toMatchObject({
        theme: savedAppearance,
        resolvedTheme: savedAppearance,
        appearanceMode: savedAppearance,
      });
      expect(Object.fromEntries(Object.entries(localStorage))).toEqual(savedStorage);

      await act(async () => selection.refreshTheme());
      await vi.waitFor(() => expect(keywordColor()).toBe(savedColor));
      expect(document.documentElement.classList.contains("dark")).toBe(savedAppearance === "dark");
      expect(Object.fromEntries(Object.entries(localStorage))).toEqual(savedStorage);
    },
  );
});

describe("ChatMarkdown table layout", () => {
  it.each([
    { width: 36, timeline: true, fits: true },
    { width: 48, timeline: true, fits: true },
    { width: 35, timeline: true, fits: false },
    { width: 48, timeline: false, fits: false },
  ])(
    "wraps expanded cells with fit=$fits in a $width rem container (timeline=$timeline)",
    async ({ width, timeline, fits }) => {
      const { container } = await render(
        <div style={{ width: `${width}rem` }}>
          <div className={timeline ? "@container/chat-lane chat-content-lane overflow-x-clip" : ""}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "| Change summary | Reason details | Verification status | Release impact | Followup actions |",
                "| --- | --- | --- | --- | --- |",
                "| Keep the complete explanation readable when the table is expanded in the conversation. | Allow each column to wrap its prose within the available space in the current chat lane. | Collapse and expand the table again to check that the text still fits and remains readable. | Keep the existing layout for narrow chat lanes and file previews. | Check the table again after resizing the conversation lane. |",
              ].join("\n")}
            />
          </div>
        </div>,
      );
      const table = container.querySelector("table")!;
      const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      const cell = table.tBodies[0]!.rows[0]!.cells[0]!;
      const collapse = () => buttonsLabelled(container, "Collapse table cells")[0];
      if (collapse()) await act(async () => collapse()!.click());

      const collapsedWidth = table.getBoundingClientRect().width;
      const collapsedHeight = cell.getBoundingClientRect().height;
      expect(viewport.clientWidth).toBeGreaterThan(0);
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      expect(cell.scrollWidth).toBeGreaterThan(cell.clientWidth);

      await act(async () => buttonsLabelled(container, "Expand table cells")[0]!.click());
      const expandedWidth = table.getBoundingClientRect().width;
      const expandedHeight = cell.getBoundingClientRect().height;
      if (fits) {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
        expect(expandedWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
      } else {
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        viewport.scrollLeft = 100;
        expect(viewport.scrollLeft).toBeGreaterThan(0);
      }
      expect(expandedHeight).toBeGreaterThan(collapsedHeight);

      await act(async () => collapse()!.click());
      expect(table.getBoundingClientRect().width).toBeCloseTo(collapsedWidth, 0);
      expect(cell.getBoundingClientRect().height).toBeCloseTo(collapsedHeight, 0);
      await act(async () => buttonsLabelled(container, "Expand table cells")[0]!.click());
      expect(table.getBoundingClientRect().width).toBeCloseTo(expandedWidth, 0);
      expect(cell.getBoundingClientRect().height).toBeCloseTo(expandedHeight, 0);
    },
  );
});

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      const container = await renderText(
        `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`,
      );
      expect(container.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect(linkTexts(container)).toEqual(["the link"]);
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toContain(
        "The deferred move continues on B.",
      );
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      const container = await renderText(`See <a>label\n\n${closing}\n\nfinish`);
      expect(container.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", async () => {
    const container = await renderText("See <a>label<script><!-- </script> --></a>");
    expect(container.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      const container = await renderText(`Before <A>.\n\n${html}\n\nAfter.`);
      expect(container.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(container.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    const container = await renderText(
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>',
    );
    expect(linkTexts(container)).toEqual(["label", "", "docs"]);
    expect(container.querySelector("code")?.textContent).toBe("<A>");
    expect(container.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown Mermaid streaming", () => {
  it("reveals a completed fence while streaming and preserves it through later prose and stream end", async () => {
    let finishRender!: (label: string) => void;
    renderDiagram.mockReturnValue(
      new Promise<string>((resolve) => {
        finishRender = resolve;
      }),
    );
    const source = "flowchart LR\nA --> B";
    const open = `\`\`\`mermaid\n${source}`;
    const closed = `${open}\n\`\`\`\n\n`;
    const message = (text: string, isStreaming = true) => (
      <ChatMarkdown cwd={undefined} text={text} isStreaming={isStreaming} />
    );
    const { container, rerender } = await render(message(open));
    expect(container.querySelector("pre")?.textContent).toContain(source);
    expect(renderDiagram).not.toHaveBeenCalled();

    await rerender(message(closed));
    expect(renderDiagram).toHaveBeenCalledWith(expect.stringContaining(source));
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector(".chat-markdown-shiki")).toBeNull();
    const placeholder = container.querySelector("pre");
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder?.textContent).toContain(source);

    await act(async () => finishRender("Completed diagram"));
    const diagram = container.querySelector('svg[role="img"]');
    expect(diagram?.getAttribute("aria-label")).toBe("Completed diagram");
    for (const streaming of [true, false]) {
      await rerender(message(`${closed}The remaining explanation.`, streaming));
      expect(container.querySelector('svg[role="img"]')).toBe(diagram);
      expect(container.textContent).toContain("The remaining explanation.");
    }

    await act(async () => buttonsLabelled(container, "Show code")[0]!.click());
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain(source);
    await act(async () => buttonsLabelled(container, "Show diagram")[0]!.click());
    expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe(
      "Completed diagram",
    );
  });

  it.each([
    ["short tilde marker", "~~~~mermaid\nflowchart LR\nA --> B\n~~~", "\n~~~~"],
    [
      "overindented blockquote marker",
      "> ```mermaid\n> flowchart LR\n> A --> B\n>     ```",
      "\n> ```",
    ],
    [
      "overindented list marker",
      "- Diagram\n\n  ```mermaid\n  flowchart LR\n  A --> B\n      ```",
      "\n  ```",
    ],
  ])("keeps a %s in source until a real closer arrives", async (_, open, closing) => {
    const message = (text: string) => <ChatMarkdown cwd={undefined} text={text} isStreaming />;
    const { container, rerender } = await render(message(open));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(container.querySelector("pre")?.textContent).toContain("A --> B");

    await rerender(message(`${open}${closing}`));
    expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Diagram");
  });

  it("does not mistake a CRLF stream cut after CR for a closed fence", async () => {
    const open = "```mermaid\r\nflowchart LR\r\nA --> B\r\n\t```";
    const message = (text: string) => <ChatMarkdown cwd={undefined} text={text} isStreaming />;
    const { container, rerender } = await render(message(open));
    expect(renderDiagram).not.toHaveBeenCalled();
    await rerender(message(`${open}\r`));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(container.querySelector("pre")?.textContent).toContain("A --> B");

    await rerender(message(`${open}\r\n\`\`\``));
    expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Diagram");
  });

  it("falls back to source when a completed diagram fails during streaming", async () => {
    await getSyntaxHighlighterPromise("mermaid");
    renderDiagram.mockImplementation(() => {
      throw new Error("Invalid Mermaid diagram");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const container = await renderText("```mermaid\ninvalid diagram\n```", { isStreaming: true });
    expect(renderDiagram).toHaveBeenCalledWith(expect.stringContaining("invalid diagram"));
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("invalid diagram");
    expect(container.querySelector("pre")?.getAttribute("aria-hidden")).not.toBe("true");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    const { container, rerender } = await render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderContextReference={({ kind, label }) => (
          <button>
            {kind}: {label}
          </button>
        )}
      />,
    );
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "terminal: Terminal output",
      "image: Error image",
    ]);
    expect(container.querySelectorAll("img, a")).toHaveLength(0);
    await rerender(<ChatMarkdown cwd={undefined} text={text} />);
    expect(container.textContent).toBe("See Terminal output and Error image.");
    expect(container.querySelectorAll("img, a, button")).toHaveLength(0);
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    const seen: Array<string> = [];
    await render(
      <ChatMarkdown
        cwd={undefined}
        text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
        renderContextReference={({ kind, label }) => {
          seen.push(`${kind}: ${label}`);
          return <button>{label}</button>;
        }}
      />,
    );
    expect(new Set(seen)).toEqual(new Set(["terminal: Bold code"]));
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    const { container, rerender } = await render(markdown("https://example.com"));
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    const { container, rerender } = await render(message("```bash\necho hello\n```", true));
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    const { rerender } = await render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
    await vi.waitFor(() => expect(highlight).toHaveBeenCalled());
    highlight.mockClear();
    await rerender(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
    expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToHast = highlighter.codeToHast.bind(highlighter);
    let fail = true;
    vi.spyOn(highlighter, "codeToHast").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToHast(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container, rerender } = await render(
      <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
    );
    const codeBlock = container.querySelector<HTMLElement>('[data-language="text"]')!;
    const initialWrap = codeBlock.dataset.wrap === "true";
    await act(async () =>
      buttonsLabelled(container, initialWrap ? "Disable line wrap" : "Wrap lines")[0]!.click(),
    );
    expect(container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(0);

    fail = false;
    await rerender(
      <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1),
    );
    expect(container.querySelector('[data-language="text"]')).toBe(codeBlock);
    expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(async () => undefined);
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    const { container, rerender } = await render(
      <ChatMarkdown cwd="/tmp/project" text={text} isStreaming />,
    );
    const codeBlock = container.querySelector<HTMLElement>('[data-language="text"]')!;
    const initialWrap = codeBlock.dataset.wrap === "true";
    await act(async () => {
      buttonsLabelled(container, initialWrap ? "Disable line wrap" : "Wrap lines")[0]!.click();
      buttonsLabelled(container, "Copy code")[0]!.click();
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-markdown-details-summary]")!.click(),
    );
    const details = container.querySelector<HTMLElement>("[data-markdown-details]")!;
    expect(details.dataset.markdownDetailsOpen).toBe("true");
    expect(container.textContent).toContain("Details content");
    expect(writeText).toHaveBeenCalledWith("First code block\n");
    expect(highlight).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) {
      await rerender(<ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />);
    }

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-language="text"]')).toBe(codeBlock);
    expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
    expect(container.querySelector("[data-markdown-details]")).toBe(details);
    expect(details.dataset.markdownDetailsOpen).toBe("true");
    await rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text.replace("First code block", "Updated code block")}
        isStreaming
      />,
    );
    const copy = [
      ...buttonsLabelled(container, "Copied"),
      ...buttonsLabelled(container, "Copy code"),
    ][0]!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
    expect(highlight).toHaveBeenCalledTimes(2);
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    const rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    const text = "Use $2spec with a $20k budget.";
    const { container, rerender } = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    expect(container.textContent).not.toContain("2Spec");

    await rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        skills={[
          { name: "2spec", displayName: "2Spec" },
          { name: "20k", displayName: "MoneySkill" },
        ]}
      />,
    );
    expect(container.textContent).toContain("2Spec");
    expect(container.textContent).toContain("$20k budget");
    expect(container.textContent).not.toContain("MoneySkill");

    await rerender(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
    expect(container.textContent).not.toContain("2Spec");
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it.each([
    {
      cwd: "/school/courses/physics",
      path: "courses/physics/notes/a.md",
      indexedPath: "notes/a.md",
    },
    {
      cwd: "C:/school/courses/Physics",
      path: "courses/physics/notes/a.md",
      indexedPath: "Notes/A.md",
    },
  ])(
    "opens a repo-relative chip at its indexed path in $cwd",
    async ({ cwd, path, indexedPath }) => {
      workspaceSearch.mockResolvedValue(
        AsyncResult.success({
          entries: [
            { path: indexedPath, kind: "file" },
            { path, kind: "file" },
          ],
          truncated: false,
        }),
      );
      const openFile = vi
        .spyOn(useRightPanelStore.getState(), "openFile")
        .mockImplementation(() => {});
      const container = await renderText(`[Notes](${path}:7)`, { cwd, threadRef });

      await act(async () => container.querySelector("a")!.click());

      expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, indexedPath, 7);
    },
  );

  it("prefers an existing literal nested file over the stripped Windows match", async () => {
    filesystemMetadata.mockResolvedValue(
      AsyncResult.success({ entries: [{ kind: "file", byteLength: 10 }] }),
    );
    workspaceSearch.mockResolvedValue(
      AsyncResult.success({
        entries: [
          { path: "Notes/A.md", kind: "file" },
          { path: "Physics/Notes/A.md", kind: "file" },
        ],
        truncated: false,
      }),
    );
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const container = await renderText("[Notes](physics/notes/a.md)", {
      cwd: "C:/school/Physics",
      threadRef,
    });

    await act(async () => container.querySelector("a")!.click());

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "physics/notes/a.md", undefined);
  });

  it("keeps a literal file omitted by a truncated search", async () => {
    workspaceSearch.mockResolvedValue(
      AsyncResult.success({
        entries: [{ path: "notes/a.md", kind: "file" }],
        truncated: true,
      }),
    );
    filesystemMetadata.mockResolvedValue(
      AsyncResult.success({ entries: [{ kind: "file", byteLength: 10 }] }),
    );
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const container = await renderText("[Notes](physics/notes/a.md:7)", {
      cwd: "/school/physics",
      threadRef,
    });

    await act(async () => container.querySelector("a")!.click());

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "physics/notes/a.md", 7);
    expect(filesystemMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { paths: ["/school/physics/physics/notes/a.md"] },
    });
  });

  it.each([
    {
      kind: "absolute link",
      href: "/school/physics/physics/notes/a.md:7",
      imageBaseDir: undefined,
    },
    { kind: "nested preview", href: "notes/a.md:7", imageBaseDir: "/school/physics/physics" },
  ])(
    "keeps the literal target for a $kind when only its stripped twin exists",
    async ({ href, imageBaseDir }) => {
      workspaceSearch.mockResolvedValue(
        AsyncResult.success({
          entries: [{ path: "notes/a.md", kind: "file" }],
          truncated: false,
        }),
      );
      const openFile = vi
        .spyOn(useRightPanelStore.getState(), "openFile")
        .mockImplementation(() => {});
      const container = await renderText(`[Notes](${href})`, {
        cwd: "/school/physics",
        imageBaseDir,
        threadRef,
      });

      await act(async () => container.querySelector("a")!.click());

      expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "physics/notes/a.md", 7);
      expect(workspaceSearch).not.toHaveBeenCalled();
      expect(filesystemMetadata).not.toHaveBeenCalled();
    },
  );

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const container = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown file citations", () => {
  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    async (parseRawHtml) => {
      const container = await renderText(
        'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.',
        { lineBreaks: !parseRawHtml, parseRawHtml },
      );
      expect(container.textContent).not.toContain("codex-file-citation");
      expect(fileOptions(container)).toEqual(["File options for report.xlsx"]);
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", async () => {
    const container = await renderText(
      'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"',
      { isStreaming: true },
    );
    expect(container.textContent).toContain(":codex-file-citation");
    expect(fileOptions(container)).toEqual([]);
  });

  it.each([
    ':codex-file-citation{purpose="output"}',
    ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}',
  ])("leaves %s literal", async (text) => {
    const container = await renderText(text);
    expect(container.textContent).toContain(text.replace("\\", ""));
    expect(fileOptions(container)).toEqual([]);
  });

  it("preserves Codex file citation examples inside code", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const container = await renderText(
      `Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``,
    );
    expect(container.textContent?.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(fileOptions(container)).toEqual([]);
  });

  it("does not create a nested link for citations inside link text", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const container = await renderText(`[See ${directive}](https://example.com)`);
    expect(container.textContent).toContain("codex-file-citation");
    expect(fileOptions(container)).toEqual([]);
  });

  it("renders file citations created by over-indented list recovery", async () => {
    const container = await renderText(
      '-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}',
    );
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("li")?.textContent).toContain("Created ");
    expect(fileOptions(container)).toEqual(["File options for report.xlsx"]);
  });

  it("disambiguates Codex citations with the same basename", async () => {
    const container = await renderText(
      'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.',
    );
    expect(container.textContent).toContain("index.ts · project/src");
    expect(container.textContent).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", async () => {
    const malformed = await renderText(
      'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}',
    );
    expect(malformed.querySelector("li")?.textContent).toBe(
      'Bad :codex-file-citation{purpose="output"}',
    );
    const nestedLink = await renderText(
      'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)',
    );
    expect(nestedLink.textContent).toContain(
      'Bad :codex-file-citation{path="/tmp/project/report.xlsx"}',
    );
  });
});

describe("ChatMarkdown Codex follow-up suggestions", () => {
  it.each([true, false])("renders the label with parseRawHtml=%s", async (parseRawHtml) => {
    const container = await renderText(
      'Done.\n\n- :codex-followup[Prepare print version]{prompt="Prepare the document for printing."}',
      { lineBreaks: !parseRawHtml, parseRawHtml },
    );
    expect(container.textContent).toContain("Prepare print version");
    expect(container.textContent).not.toContain("codex-followup");
    expect(container.textContent).not.toContain("Prepare the document for printing.");
  });

  it("keeps the label of a malformed follow-up created by over-indented list recovery", async () => {
    const container = await renderText("-       Next :codex-followup[Prepare print version]");
    expect(container.querySelector("li")?.textContent).toBe(
      "Next :codex-followup[Prepare print version]",
    );
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])(
    "offers the Codex template from its card with parseRawHtml=%s",
    async (parseRawHtml) => {
      const onUseArtifactTemplate = vi.fn();
      const container = await renderText(ARTIFACT_TEMPLATE_DIRECTIVE, {
        parseRawHtml,
        onUseArtifactTemplate,
      });
      expect(container.textContent).not.toContain("::artifact-template");
      expect(container.textContent).toContain("Hello World");
      expect(container.textContent).toContain("Document template");
      expect(container.querySelector("p div")).toBeNull();
      const use = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Use template",
      )!;
      await act(async () => use.click());
      expect(onUseArtifactTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          skillName: "artifact-template-hello-world",
          displayName: "Hello World",
        }),
      );
    },
  );

  it("renders a passive card outside a composer-backed timeline", async () => {
    const container = await renderText(ARTIFACT_TEMPLATE_DIRECTIVE);
    expect(container.textContent).toContain("Hello World");
    expect(container.textContent).not.toContain("Use template");
  });

  it.each([
    '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
    ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1),
    `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
    ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
  ])("leaves %s literal", async (text) => {
    const container = await renderText(text);
    expect(container.textContent).toContain("::artifact-template");
    expect(container.textContent).not.toContain("Document template");
  });

  it("preserves artifact-template examples inside code", async () => {
    const container = await renderText(
      `\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``,
    );
    expect(container.textContent?.match(/::artifact-template/g)).toHaveLength(2);
    expect(container.textContent).not.toContain("Document template");
  });
});

describe("ChatMarkdown headings", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    const container = await renderText("# Top\n\n## Section\n\n###### Fine print", {
      headingLevelOffset: 3,
    });
    expect(
      [...container.querySelectorAll("h1, h2, h6")].map((heading) => [
        heading.tagName,
        heading.getAttribute("aria-level"),
      ]),
    ).toEqual([
      ["H1", "4"],
      ["H2", "5"],
      ["H6", "6"],
    ]);
    const flat = await renderText("# Top");
    expect(flat.querySelector("h1")?.hasAttribute("aria-level")).toBe(false);
  });

  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    const container = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it.each([
    ["drive paths", "[Open](C:/Users/shawn/project/src/main.ts)"],
    ["backslashes", String.raw`[Open](C:\Users\shawn\project\src\main.ts)`],
    ["reference links", "[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"],
  ])("resolves %s to the workspace file", async (_, text) => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(text, parseRawHtml);
      expect(fileHrefs(container)).toEqual(["C:/Users/shawn/project/src/main.ts"]);
    }
  });

  it("keeps backslashes CommonMark would read as escapes", async () => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(
        String.raw`[settings](C:\Users\shawn\.claude\settings.json)`,
        parseRawHtml,
      );
      expect(fileHrefs(container)).toEqual(["C:/Users/shawn/.claude/settings.json"]);
    }
  });

  it("distinguishes same-named backslash paths but not the same file twice", async () => {
    for (const parseRawHtml of [true, false]) {
      const distinct = await renderWindows(
        String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`,
        parseRawHtml,
      );
      expect(distinct.textContent).toContain("index.ts · project/src");
      expect(distinct.textContent).toContain("index.ts · project/test");
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const same = await renderWindows(`[Source](${path}) and \`${path}\``, parseRawHtml);
      expect(fileHrefs(same)).toHaveLength(2);
      expect(same.textContent).not.toContain("main.ts ·");
    }
  });

  it("still rejects unsafe schemes", async () => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => {});
      const href = window.location.href;
      const container = await renderText(
        "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model",
        { parseRawHtml },
      );
      const headings = [...container.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.id)).toEqual([
        "user-content-1-operating-model",
        "user-content-1-operating-model-1",
      ]);
      const [tocLink, missingLink] = [...container.querySelectorAll("a")];
      await act(async () => tocLink!.click());
      expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);
      await act(async () => missingLink!.click());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(href);
    },
  );
});

describe("ChatMarkdown thread find", () => {
  function FindProbe(props: {
    container: HTMLElement;
    query: string;
    activeOccurrence?: number;
    children: ReactElement;
  }) {
    useThreadFindHighlights({
      container: props.container,
      query: props.query,
      activeRowId: "row",
      activeOccurrence: props.activeOccurrence ?? 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={props.query !== ""}>{props.children}</MarkdownFindContext>
        </div>
      </div>
    );
  }
  const frame = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const activeHighlights = () =>
    [...(CSS.highlights.get("t3-thread-find-active") ?? [])].map((range) =>
      (range as Range).toString(),
    );

  it("opens a disclosure only when find selects a match inside it", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const markdown = (
      <ChatMarkdown
        cwd={undefined}
        text={[
          "Visible needle.",
          "<details><summary>Unrelated</summary><p>nothing here</p></details>",
          "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
        ].join("\n\n")}
      />
    );
    const show = (query: string, activeOccurrence: number) =>
      act(() =>
        root.render(
          <FindProbe container={container} query={query} activeOccurrence={activeOccurrence}>
            {markdown}
          </FindProbe>,
        ),
      );
    const openStates = () =>
      [...container.querySelectorAll<HTMLElement>("[data-markdown-details-open]")].map(
        (node) => node.dataset.markdownDetailsOpen,
      );

    await show("", 0);
    expect(container.textContent).not.toContain("nothing here");
    await show("needle", 0);
    await frame();
    expect(openStates()).toEqual(["false", "false", "false"]);
    expect(container.textContent).toContain("nothing here");
    expect(activeHighlights()).toEqual(["needle"]);
    expect(CSS.highlights.get("t3-thread-find")?.size ?? 0).toBe(0);

    await show("needle", 1);
    await frame();
    await frame();
    expect(openStates()).toEqual(["false", "true", "true"]);
    expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  });

  it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
    const show = (query: string) =>
      act(() =>
        root.render(
          <FindProbe container={container} query={query}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </FindProbe>,
        ),
      );
    const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;

    await show("Needle");
    await frame();
    expect(diagrams()).toBe(2);
    await show("Alpha");
    await frame();
    await frame();
    expect(diagrams()).toBe(1);
    await vi.waitFor(() => expect(activeHighlights()).toEqual(["Alpha"]));
  });

  it.each([
    {
      text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
      query: "SearchSourceAlpha",
      count: 1,
    },
    {
      text: "★ Insight ─────\nfirst line\nsecond line",
      query: "first line second",
      count: 0,
      lineBreaks: true,
    },
    { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
    { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
    { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
    { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
    { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
    {
      text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
      query: "Hidden needle",
      count: 1,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, withTemplate: true },
    {
      text: ARTIFACT_TEMPLATE_DIRECTIVE,
      query: "Document template",
      count: 1,
      withTemplate: true,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, withTemplate: true },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, withTemplate: true },
  ])(
    "highlights the indexed occurrences of $query in $text",
    async ({ text, query, count, lineBreaks, user, withTemplate }) => {
      const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
      const container = document.body.appendChild(document.createElement("div"));
      const root = createRoot(container);
      roots.push(root);
      await act(() =>
        root.render(
          <FindProbe container={container} query={query}>
            <ChatMarkdown
              text={text}
              cwd={undefined}
              skills={skills}
              lineBreaks={lineBreaks ?? false}
              parseRawHtml={!user}
              onUseArtifactTemplate={withTemplate ? () => undefined : undefined}
            />
          </FindProbe>,
        ),
      );
      await frame();
      // Lazy blocks such as Mermaid can swap their source text after the first frame,
      // emptying a range for a moment, so wait for the highlights to settle.
      await vi.waitFor(() => {
        const ranges = [...CSS.highlights.values()].flatMap((value) => [...value]);
        expect(ranges.map((range) => (range as Range).toString())).toEqual(
          Array.from({ length: count }, () => query),
        );
      });
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    },
  );
});

describe("ChatMarkdown math", () => {
  const renderMath = async (
    text: string,
    options: Partial<Parameters<typeof ChatMarkdown>[0]> = {},
  ) => {
    settingsOverrides.mathRenderingEnabled = true;
    const { container: host } = await render(
      <ChatMarkdown cwd="/tmp/project" text={text} {...options} />,
    );
    host.setAttribute("data-assistant-citation-source", "assistant");
    await act(async () => {
      await import("./chat/MathTypeset");
    });
    return { host };
  };

  it.each(["$x$", "$$x$$", "```math\nx\n```", "$\\notACommand{x}$"])(
    "keeps keyboard focus on the parent control in compact previews of %s",
    async (formula) => {
      settingsOverrides.mathRenderingEnabled = true;
      const { container } = await render(
        <>
          <button type="button">
            Preview <ChatMarkdown inline text={formula} cwd={undefined} />
          </button>
          <button type="button">After preview</button>
        </>,
      );
      await act(async () => {
        await import("./chat/MathTypeset");
      });
      const [preview, after] = container.querySelectorAll("button");
      preview!.focus();
      await act(() => userEvent.tab());
      expect(document.activeElement).toBe(after);
      if (formula.includes("notACommand")) {
        expect(page.getByRole("button", { name: /notACommand/ }).element()).toBe(preview);
      }
    },
  );

  it("keeps message formulas reachable by keyboard", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const { container } = await render(
      <>
        <button type="button">Before equation</button>
        <ChatMarkdown text="$x$" cwd={undefined} />
      </>,
    );
    container.querySelector("button")!.focus();
    await act(() => userEvent.tab());
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Scroll inline equation"]'),
    );
  });

  it("renders table formulas and exports their TeX instead of duplicate glyph text", async () => {
    const rendered = await renderMath(
      "| Name | Formula |\n| --- | --- |\n| Norm | $|x|$ and \\(\\|y\\|\\) |\n| Price | $5 and $10 |",
    );

    const table = rendered.host.querySelector("table")!;
    expect([...table.rows].map((row) => row.cells.length)).toEqual([2, 2, 2]);
    expect(table.querySelectorAll(".katex")).toHaveLength(2);
    const norm = table.querySelectorAll(".katex")[1]!;
    expect([...norm.querySelectorAll(".katex-mathml mi")].map((node) => node.textContent)).toEqual([
      "∥",
      "y",
      "∥",
    ]);
    expect(serializeTableElementToCsv(table)).toBe(
      "Name,Formula\nNorm,\\(|x|\\) and \\(\\|y\\|\\)\nPrice,$5 and $10",
    );
    const glyph = table.querySelector(".katex-mathml mi")!.firstChild!;
    const range = document.createRange();
    range.setStart(glyph, 0);
    range.setEnd(glyph, 1);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const payload = chatMarkdownClipboardPayload(selection)!;
    expect(payload.text).toBe("\\(|x|\\)");
    expect(payload.html).toContain("\\(|x|\\)");
    expect(payload.html).not.toContain("katex");
    expect(captureAssistantTextSelection(rendered.host, selection)?.selector.text).toBe(
      "\\(|x|\\)",
    );
  });

  it("renders explicit math fences and keeps unfinished streamed fences readable", async () => {
    const rendered = await renderMath("```math\nx_i^2\n```\n\n`$literal$`\n\n$unfinished");

    expect(rendered.host.querySelectorAll(".katex")).toHaveLength(1);
    expect(rendered.host.textContent).toContain("$literal$");
    expect(rendered.host.textContent).toContain("$unfinished");

    const streamed = await renderMath("```math\nx_i^2", { isStreaming: true });

    expect(streamed.host.querySelector(".katex")).toBeNull();
    expect(streamed.host.textContent).toContain("x_i^2");
  });

  it.each(["$$\nx^2\n", "\\[\nx^2\n"])(
    "keeps unfinished display %s and following prose readable while streaming",
    async (source) => {
      for (const text of [source, `${source}\nFollowing prose.`]) {
        const { host } = await renderMath(text, { isStreaming: true });
        expect(host.querySelector(".katex")).toBeNull();
        expect(host.querySelector("[data-markdown-math]")).toBeNull();
        expect(host.textContent).toContain("x^2");
        if (text.includes("Following prose."))
          expect(host.textContent).toContain("Following prose.");
      }
    },
  );

  it.each(["$$x^2$$", "$$\nx^2\n$$", "\\[\nx^2\n\\]", "```math\nx^2\n```"])(
    "renders completed %s while the response is streaming",
    async (source) => {
      const { host } = await renderMath(source, { isStreaming: true });
      expect(host.querySelectorAll(".katex")).toHaveLength(1);
      expect(host.querySelector('[data-markdown-math="display"]')).not.toBeNull();
    },
  );

  it("shows unsupported TeX as source and keeps active TeX commands inert", async () => {
    const rendered = await renderMath(
      "\\(\\notACommand{x}\\) and \\(\\href{https://example.com}{x}\\)",
    );

    expect(rendered.host.textContent).toContain("\\(\\notACommand{x}\\)");
    expect(rendered.host.querySelector('a[href="https://example.com"]')).toBeNull();
  });

  it("typesets only when enabled, keeping prices and task offsets intact", async () => {
    const text = "Area $\\pi r^2$ costs $5 and $10.\n\n\\[\nE = mc^2\n\\]\n\n- [ ] check \\(x\\)";
    const off = await renderText(text);
    expect(off.querySelector("[data-markdown-math]")).toBeNull();
    const html = await renderText('<code class="language-math math-inline">x</code>');
    expect(html.querySelector("[data-markdown-math]")).toBeNull();
    for (const parseRawHtml of [true, false]) {
      let editedText = text;
      const { host } = await renderMath(text, {
        parseRawHtml,
        onTaskListChange: ({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
        },
      });
      expect(
        [...host.querySelectorAll("[data-markdown-math]")].map((node) =>
          node.getAttribute("data-markdown-copy"),
        ),
      ).toEqual(["\\(\\pi r^2\\)", "\\[\nE = mc^2\n\\]\n\n", "\\(x\\)"]);
      await act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(editedText).toBe(text.replace("- [ ]", "- [x]"));
    }
    const { host } = await renderMath("-       intro\n\n        $$\n        x^2\n        $$");
    expect(
      [...host.querySelectorAll("[data-markdown-math]")].map((node) =>
        node.getAttribute("data-markdown-copy"),
      ),
    ).toEqual(["\\[\nx^2\n\\]\n\n"]);
  });
});
