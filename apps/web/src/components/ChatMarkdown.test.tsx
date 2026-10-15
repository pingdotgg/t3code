// @vitest-environment jsdom

import { EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { createRoot } from "react-dom/client";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { MarkdownFindContext } from "./chat/markdownFindContext";
import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  captureAssistantTextSelection,
  resolveAssistantCitationRange,
} from "../lib/assistantTextSelection";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../markdown-clipboard";
import { GitHubIcon } from "./Icons";
import { Button } from "./ui/button";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("./chat/MermaidDiagram", () => ({
  // Real Mermaid needs layout APIs jsdom lacks; a rendered diagram is an SVG.
  MermaidDiagram: () => <svg aria-label="Diagram" />,
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
const settingsOverrides = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const defaults = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof defaults) => unknown) => {
      const settings = { ...defaults, ...settingsOverrides };
      return select ? select(settings) : settings;
    },
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

function codeButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props["aria-label"] === label);
  if (!button) throw new Error(`Missing code button: ${label}`);
  return button.props as ComponentProps<typeof Button>;
}

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    (token) => {
      const text = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />),
        "text/html",
      );

      expect(document.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
        "the link",
      ]);
      expect(document.querySelectorAll("li")).toHaveLength(2);
      expect(
        [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
      ).toContain("The deferred move continues on B.");
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    (closing) => {
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(
          <ChatMarkdown cwd="/tmp/project" text={`See <a>label\n\n${closing}\n\nfinish`} />,
        ),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", () => {
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <ChatMarkdown cwd="/tmp/project" text="See <a>label<script><!-- </script> --></a>" />,
      ),
      "text/html",
    );
    expect(document.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    (html) => {
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(
          <ChatMarkdown cwd="/tmp/project" text={`Before <A>.\n\n${html}\n\nAfter.`} />,
        ),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(document.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", () => {
    const text =
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />),
      "text/html",
    );

    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "label",
      "",
      "docs",
    ]);
    expect(document.querySelector("code")?.textContent).toBe("<A>");
    expect(document.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    try {
      await act(async () => {
        renderer = create(
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
      });
      expect(
        renderer!.root.findAllByType("button").map((button) => button.children.join("")),
      ).toEqual(["terminal: Terminal output", "image: Error image"]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType("a")).toHaveLength(0);
      await act(async () => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={text} />);
      });
      expect(renderer!.root.findAllByType("span").map((span) => span.children.join(""))).toEqual([
        "Terminal output",
        "Error image",
      ]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const seen: Array<string> = [];
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
            renderContextReference={({ kind, label }) => {
              seen.push(`${kind}: ${label}`);
              return <button>{label}</button>;
            }}
          />,
        );
      });
      expect(seen).toEqual(["terminal: Bold code"]);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    try {
      await act(async () => {
        renderer = create(markdown("https://example.com"));
      });
      expect(renderer!.root.findAllByType("img").map((image) => image.props.src)).toEqual([
        "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      ]);
      for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
        await act(async () => {
          renderer!.update(markdown(url));
        });
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      }
      await act(async () => {
        renderer!.update(markdown("https://example.com"));
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(1);
      // GitHub links draw the brand mark in currentColor instead of fetching a favicon.
      await act(async () => {
        renderer!.update(markdown("https://github.com/pingdotgg/t3code/pull/1"));
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType(GitHubIcon)).toHaveLength(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onRunShellCommand = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    try {
      await act(async () => {
        renderer = create(message("```bash\necho hello\n```", true));
      });
      const mounted = renderer!;
      expect(
        mounted.root
          .findAllByType(Button)
          .some((button) => button.props["aria-label"] === "Run in terminal"),
      ).toBe(false);

      await act(async () => {
        mounted.update(message("```bash\necho hello\n```"));
      });
      await act(async () => {
        codeButton(mounted, "Run in terminal").onClick?.({} as never);
      });
      expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

      for (const text of [
        "~~~bash\necho tilde\n~~~",
        "> ```bash\n> echo quote\n> ```",
        "````bash\necho four\n````",
      ]) {
        await act(async () => {
          mounted.update(message(text));
        });
        expect(codeButton(mounted, "Run in terminal")).toBeDefined();
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
        await act(async () => {
          mounted.update(message(text));
        });
        expect(
          mounted.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Run in terminal"),
        ).toBe(false);
      }
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      expect(highlight).toHaveBeenCalled();
      highlight.mockClear();
      await act(async () => {
        renderer!.update(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
      });
      expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
        );
      });
      const mounted = renderer!;
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
      });
      expect(mounted.root.findAllByProps({ className: "chat-markdown-shiki" })).toHaveLength(0);

      fail = false;
      await act(async () => {
        mounted.update(
          <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
        );
      });
      expect(mounted.root.findAllByProps({ className: "chat-markdown-shiki" })).toHaveLength(1);
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(codeBlock.props["data-wrap"]).toBe(String(!initialWrap));
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let renderer: ReactTestRenderer | undefined;
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

    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      const mounted = renderer!;
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      const copy = codeButton(mounted, "Copy code");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
        copy.onClick?.({} as Parameters<NonNullable<typeof copy.onClick>>[0]);
      });

      const detailsButton = mounted.root.find(
        (instance) =>
          instance.type === "button" && instance.props["data-markdown-details-summary"] === "",
      );
      await act(async () => {
        detailsButton.props.onClick({ nativeEvent: new Event("click") });
      });
      const details = mounted.root.findByProps({ "data-markdown-details": "" });
      expect(details.props["data-markdown-details-open"]).toBe("true");
      expect(writeText).toHaveBeenCalledWith("First code block\n");
      expect(highlight).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          mounted.update(<ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />);
        });
      }

      expect(highlight).toHaveBeenCalledTimes(1);
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(codeBlock.props["data-wrap"]).toBe(String(!initialWrap));
      expect(mounted.root.findByProps({ "data-markdown-details": "" })).toBe(details);
      expect(details.props["data-markdown-details-open"]).toBe("true");
      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text.replace("First code block", "Updated code block")}
            isStreaming
          />,
        );
      });
      const copyUpdated = codeButton(mounted, "Copied");
      await act(async () => {
        copyUpdated.onClick?.({} as Parameters<NonNullable<typeof copyUpdated.onClick>>[0]);
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
      expect(highlight).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    let editedText: string | undefined;
    const message = (text: string) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          renderer!.update(message(editedText));
        }}
      />
    );

    try {
      await act(async () => {
        renderer = create(message("- [ ] First\n- [ ] Second"));
      });
      const mounted = renderer!;
      const originalInput = mounted.root.findAllByType("input")[1]!;
      await act(async () => {
        mounted.update(message("- [ ] A longer first task\n- [ ] Second"));
      });

      const input = mounted.root.findAllByType("input")[1]!;
      const listItem = mounted.root.findAllByType("li")[1]!;
      const { onChange } = input.props as ComponentProps<"input">;
      if (!onChange) throw new Error("Task checkbox has no edit handler");
      await act(async () => {
        onChange({
          currentTarget: {
            checked: true,
            closest: () => ({
              dataset: { taskMarkerOffset: String(listItem.props["data-task-marker-offset"]) },
            }),
          },
        } as unknown as Parameters<typeof onChange>[0]);
      });

      expect(input).toBe(originalInput);
      expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
      expect(mounted.root.findAllByType("input")[1]!.props.checked).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
  });

  it("hides shell actions until the environment mode is resolved", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
  });

  it("hides shell actions when no environment owns the markdown", () => {
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("hasMarkdownFilePrimaryAction", () => {
  it("keeps the chip interactive when an editor, browser, or panel can open it", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: true,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });

  it("removes the link affordance when no primary action can open the file", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(false);
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "Use $2spec with a $20k budget.";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
      });
      const mounted = renderer!;
      const labels = (label: string) =>
        mounted.root.findAllByType("span").filter((node) => node.children.includes(label));
      expect(labels("2Spec")).toHaveLength(0);

      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text}
            skills={[
              { name: "2spec", displayName: "2Spec" },
              { name: "20k", displayName: "MoneySkill" },
            ]}
          />,
        );
      });
      expect(labels("2Spec")).toHaveLength(1);
      expect(labels("MoneySkill")).toHaveLength(0);

      await act(async () => {
        mounted.update(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
      });
      expect(labels("2Spec")).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).not.toContain("codex-file-citation");
      expect(html).toContain("chat-markdown-file-link");
      expect(html).toContain(
        'data-markdown-copy="[report.xlsx](/tmp/project/outputs/report.xlsx)"',
      );
      expect(html).toContain("report.xlsx");
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"'}
        isStreaming
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("leaves malformed and similarly named file directives literal", () => {
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain(text.replaceAll('"', "&quot;"));
      expect(html).not.toContain("chat-markdown-file-link");
    }
  });

  it("preserves Codex file citation examples inside code", () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );

    expect(html.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("preserves escaped Codex file citations as literal text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("does not create a nested link for citations inside link text", () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    const renderedText = html.replace(/<[^>]+>/g, "");

    expect(renderedText).toContain("codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("renders file citations created by over-indented list recovery", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).not.toContain("<pre>");
    expect(html).toContain("Created ");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("report.xlsx");
  });

  it("disambiguates Codex citations with the same basename", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );

    expect(html).toContain("index.ts · project/src");
    expect(html).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", () => {
    const malformedHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    const nestedLinkHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const nestedLinkText = nestedLinkHtml.replace(/<[^>]+>/g, "");

    expect(malformedHtml).toContain(
      "<li>Bad :codex-file-citation{purpose=&quot;output&quot;}</li>",
    );
    expect(nestedLinkText).toContain(
      "Bad :codex-file-citation{path=&quot;/tmp/project/report.xlsx&quot;}",
    );
  });
});

describe("ChatMarkdown Codex follow-up suggestions", () => {
  it.each([true, false])("renders the label with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Done.\n\n- :codex-followup[Prepare print version]{prompt="Prepare the document for printing."}'
        }
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain("Prepare print version");
    expect(html).not.toContain("codex-followup");
    expect(html).not.toContain("Prepare the document for printing.");
  });

  it("keeps the label of a malformed follow-up created by over-indented list recovery", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text="-       Next :codex-followup[Prepare print version]"
      />,
    );

    expect(html).toContain("<li>Next :codex-followup[Prepare print version]</li>");
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])("renders the Codex result card with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={ARTIFACT_TEMPLATE_DIRECTIVE}
        parseRawHtml={parseRawHtml}
        onUseArtifactTemplate={() => undefined}
      />,
    );

    expect(html).not.toContain("::artifact-template");
    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).toContain('data-artifact-kind="document"');
    expect(html).toContain('data-markdown-copy="Hello World (Document template)\n\n"');
    expect(html).toContain('data-skill-name="artifact-template-hello-world"');
    expect(html).toContain("Hello World");
    expect(html).toContain("Document template");
    expect(html).toContain("Use template");
    expect(html).not.toContain("<p><div");
  });

  it("renders a passive card outside a composer-backed timeline", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );

    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", () => {
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", () => {
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("preserves artifact-template examples inside code", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );

    expect(html.match(/::artifact-template/g)).toHaveLength(2);
    expect(html).not.toContain("data-chat-markdown-artifact-template");
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );

    expect(html).toContain('<h1 id="user-content-top" aria-level="4">Top</h1>');
    expect(html).toContain('<h2 id="user-content-section" aria-level="5">Section</h2>');
    expect(html).toContain('<h6 id="user-content-fine-print" aria-level="6">Fine print</h6>');
  });

  it("leaves heading levels alone when the markdown is not nested", () => {
    const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text="# Top" />);

    expect(html).toContain('<h1 id="user-content-top">Top</h1>');
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser when it is the only available primary action", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
  });

  it("preserves the normal editor and panel defaults for HTML files", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(false);
  });

  it("continues to open PDF files in the browser by default", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])(
    "keeps backslashes CommonMark would read as escapes with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[settings](C:\Users\shawn\.claude\settings.json)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain('href="C:/Users/shawn/.claude/settings.json"');
    },
  );

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain("index.ts · project/src");
      expect(html).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    (parseRawHtml) => {
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html.match(/chat-markdown-file-link/g)).toHaveLength(2);
      expect(html).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("still rejects unsafe schemes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("d:alert");
    expect(html).not.toContain("chat-markdown-file-link");
  });
});

type CitedParts = { prose: Text[]; formulas: Element[]; html: Element[] };

describe("ChatMarkdown math", () => {
  // A real assistant reply.
  const reply = [
    "**Your revised \\(G\\) value is reproducible.** Starting from the printed mean free path:",
    "",
    "\\[",
    "r_1=3.88781\\times10^{-5}\\frac{5772}{6000}",
    "=3.74007322\\times10^{-5}\\ \\mathrm m.",
    "\\]",
    "",
    "| Quantity | Calculated | Accepted |",
    "|---|---:|---:|",
    "| \\(G\\) | \\(6.74731\\times10^{-11}\\) | \\(6.67430\\times10^{-11}\\) |",
    "",
    "Your equations imply",
    "",
    "\\[",
    "\\sigma\\propto\\frac{1}{r_1T^4},\\qquad r_1\\propto T",
    "\\quad\\Rightarrow\\quad \\sigma\\propto T^{-5}.",
    "\\]",
  ].join("\n");

  async function renderMath(
    text: string,
    props: Partial<ComponentProps<typeof ChatMarkdown>> = {},
  ) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Resolving the lazy KaTeX module first lets its Suspense boundaries settle.
    await import("./chat/KatexMath");
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
    });
    const tex = (selector: string) =>
      [...container.querySelectorAll(selector)].map(
        (node) => node.querySelector('annotation[encoding="application/x-tex"]')?.textContent,
      );
    return { container, tex, unmount: () => act(async () => root.unmount()) };
  }

  it("renders \\(…\\) and \\[…\\] as math when math rendering is enabled", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(reply);
    try {
      expect(view.tex(".katex-display")).toEqual([
        "r_1=3.88781\\times10^{-5}\\frac{5772}{6000}\n=3.74007322\\times10^{-5}\\ \\mathrm m.",
        "\\sigma\\propto\\frac{1}{r_1T^4},\\qquad r_1\\propto T\n\\quad\\Rightarrow\\quad \\sigma\\propto T^{-5}.",
      ]);
      expect(view.tex("td .katex")).toEqual([
        "G",
        "6.74731\\times10^{-11}",
        "6.67430\\times10^{-11}",
      ]);
      expect(view.container.querySelector("strong .katex")).not.toBeNull();
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it.each([true, false])("renders math with parseRawHtml=%s", async (parseRawHtml) => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath("Inline \\(a_1\\) here.\n\n\\[\nb^2\n\\]", {
      parseRawHtml,
      lineBreaks: !parseRawHtml,
    });
    try {
      expect(view.tex(".katex")).toEqual(["a_1", "b^2"]);
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("renders a $$ block as math when enabled and keeps it as written when disabled", async () => {
    const source = "Before.\n\n$$\nb^2\n$$\n\nAfter.";
    settingsOverrides.mathRenderingEnabled = true;
    const enabled = await renderMath(source);
    try {
      expect(enabled.tex(".katex-display")).toEqual(["b^2"]);
      expect(enabled.container.textContent).not.toContain("$$");
    } finally {
      await enabled.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
    const disabled = await renderMath(source);
    try {
      expect(disabled.container.querySelector(".katex")).toBeNull();
      expect(disabled.container.textContent).toContain("$$\nb^2\n$$");
    } finally {
      await disabled.unmount();
    }
  });

  it("keeps code, escapes, currency, and unfinished formulas as written", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(
      [
        "Costs $5 and $10, and `\\(x\\)` stays code, as does \\\\(y\\\\).",
        "",
        "```tex",
        "\\[",
        "z",
        "\\]",
        "```",
        "",
        "Still streaming \\(w and a [link](https://x.test/a_\\(b\\))",
      ].join("\n"),
    );
    try {
      expect(view.container.querySelector(".katex")).toBeNull();
      expect(view.container.querySelector("code")?.textContent).toBe("\\(x\\)");
      expect(view.container.querySelector("pre code")?.textContent).toBe("\\[\nz\n\\]\n");
      expect(view.container.textContent).toContain("Costs $5 and $10");
      expect(view.container.querySelector("a")?.getAttribute("href")).toBe("https://x.test/a_(b)");
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("shows an unfinished display formula as source until its closing line arrives", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const unfinished = "Intro\n\n$$\nx = 1";
    const streaming = await renderMath(unfinished);
    try {
      expect(streaming.container.querySelector(".katex")).toBeNull();
      expect(streaming.container.querySelector("[data-markdown-math]")).toBeNull();
      const block = streaming.container.querySelector("pre");
      expect(block?.textContent).toContain("$$");
      expect(block?.textContent).toContain("x = 1");
    } finally {
      await streaming.unmount();
    }
    const finished = await renderMath(`${unfinished}\n$$`);
    try {
      expect(finished.tex(".katex-display")).toEqual(["x = 1"]);
    } finally {
      await finished.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("shows the source of TeX that KaTeX rejects and copies formulas as TeX", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath("Good \\(x^2\\), bad \\(\\frac{1\\).");
    try {
      expect(view.tex(".katex")).toEqual(["x^2"]);
      const copies = [...view.container.querySelectorAll("[data-markdown-copy]")].map((node) =>
        node.getAttribute("data-markdown-copy"),
      );
      expect(copies).toEqual(["\\(x^2\\)", "\\(\\frac{1\\)"]);
      expect(view.container.querySelector("code")?.textContent).toBe("\\frac{1");
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  describe("clipboard", () => {
    const displayTex = "r_1=3.88781\\times10^{-5}\\frac{5772}{6000}\n=3.74\\ \\mathrm m.";
    const source = `Intro \\(a_1\\) text.\n\n\\[\n${displayTex}\n\\]\n\nOutro.`;

    async function copyFrom(select: (container: HTMLElement, range: Range) => void) {
      settingsOverrides.mathRenderingEnabled = true;
      const view = await renderMath(source);
      const range = document.createRange();
      select(view.container, range);
      const selection = { rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
      const payload = chatMarkdownClipboardPayload(selection);
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
      return payload;
    }

    it.each([
      [
        "the whole formula",
        (c: HTMLElement, r: Range) =>
          r.selectNode(c.querySelector(".katex-display")!.parentElement!),
      ],
      [
        "the formula's contents",
        (c: HTMLElement, r: Range) =>
          r.selectNodeContents(c.querySelector(".katex-display")!.parentElement!),
      ],
      [
        "its visible .katex-html",
        (c: HTMLElement, r: Range) =>
          r.selectNodeContents(c.querySelector(".katex-display .katex-html")!),
      ],
      [
        "one glyph run inside it",
        (c: HTMLElement, r: Range) =>
          r.selectNodeContents(c.querySelector(".katex-display .katex-html .base")!),
      ],
      [
        "an inline formula's .katex-html",
        (c: HTMLElement, r: Range) => r.selectNodeContents(c.querySelector("p .katex-html")!),
      ],
    ])("copies the TeX when %s is selected", async (name, select) => {
      const payload = await copyFrom(select);
      expect(payload?.text).toBe(
        name === "an inline formula's .katex-html" ? "\\(a_1\\)" : `\\[\n${displayTex}\n\\]`,
      );
      // The HTML flavor carries the TeX, not KaTeX's markup.
      expect(payload?.html).not.toMatch(/katex|annotation|<math/);
      expect(payload?.html).toContain("<code>");
    });

    it("keeps one coherent copy when a selection spans prose and formulas", async () => {
      const payload = await copyFrom((container, range) => {
        range.setStartBefore(container.querySelector("p")!);
        range.setEndAfter(container.lastElementChild!);
      });
      expect(payload?.text).toBe(`Intro \\(a_1\\) text.\n\n\\[\n${displayTex}\n\\]\n\nOutro.`);
      expect(payload?.html).not.toMatch(/katex|annotation|<math/);
      expect(payload?.html).toContain("Outro.");
    });
  });

  describe("assistant citations", () => {
    const sentence = "Your revised \\(G\\) value is \\(6.7\\times10^{-11}\\) today.";

    // Browsers put selection endpoints in KaTeX's glyph text, so tests do too.
    const textNodes = (node: Node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const found: Text[] = [];
      while (walker.nextNode()) found.push(walker.currentNode as Text);
      return found;
    };

    async function citable(text: string) {
      settingsOverrides.mathRenderingEnabled = true;
      const view = await renderMath(text);
      view.container.dataset.assistantCitationSource = "assistant";
      const capture = (select: (range: Range) => void) => {
        const range = document.createRange();
        select(range);
        const selection = {
          isCollapsed: range.collapsed,
          rangeCount: 1,
          getRangeAt: () => range,
        } as unknown as Selection;
        return captureAssistantTextSelection(view.container, selection);
      };
      return {
        ...view,
        capture,
        unmount: async () => {
          await view.unmount();
          delete settingsOverrides.mathRenderingEnabled;
        },
      };
    }

    it.each([
      {
        name: "the whole paragraph",
        quote: sentence,
        select: (range: Range, { prose }: CitedParts) =>
          range.selectNodeContents(prose[0]!.parentElement!),
        visible: (range: Range, { prose }: CitedParts) => {
          range.setStart(prose[0]!, 0);
          range.setEnd(prose.at(-1)!, prose.at(-1)!.length);
        },
      },
      {
        name: "a range starting inside a formula",
        quote: "\\(G\\) value is \\(6.7\\times10^{-11}\\) today.",
        select: (range: Range, { prose, html }: CitedParts) => {
          range.setStart(textNodes(html[0]!)[0]!, 0);
          range.setEnd(prose.at(-1)!, prose.at(-1)!.length);
        },
        visible: (range: Range, { prose, formulas }: CitedParts) => {
          range.setStartBefore(formulas[0]!);
          range.setEnd(prose.at(-1)!, prose.at(-1)!.length);
        },
      },
      {
        name: "a range ending inside a formula",
        quote: "revised \\(G\\) value is \\(6.7\\times10^{-11}\\)",
        select: (range: Range, { prose, html }: CitedParts) => {
          range.setStart(prose[0]!, 5);
          range.setEnd(textNodes(html[1]!)[1]!, 1);
        },
        visible: (range: Range, { prose, formulas }: CitedParts) => {
          range.setStart(prose[0]!, 5);
          range.setEndAfter(formulas[1]!);
        },
      },
      {
        name: "a range within one formula",
        quote: "\\(6.7\\times10^{-11}\\)",
        select: (range: Range, { html }: CitedParts) => {
          const glyphs = textNodes(html[1]!);
          range.setStart(glyphs[1]!, 1);
          range.setEnd(glyphs.at(-1)!, 1);
        },
        visible: (range: Range, { formulas }: CitedParts) => {
          range.setStartBefore(formulas[1]!);
          range.setEndAfter(formulas[1]!);
        },
      },
    ])("quotes $name as its source text and finds it again", async ({ quote, select, visible }) => {
      const view = await citable(sentence);
      try {
        const paragraph = view.container.querySelector("p")!;
        const parts: CitedParts = {
          prose: textNodes(paragraph).filter((node) => !node.parentElement!.closest(".katex")),
          formulas: [...paragraph.querySelectorAll("[data-markdown-copy]")],
          html: [...paragraph.querySelectorAll(".katex-html")],
        };
        const captured = view.capture((range) => select(range, parts));
        expect(captured?.selector.text).toBe(quote);

        // The quote resolves to whole formulas, never KaTeX's glyph nodes.
        const found = resolveAssistantCitationRange(view.container, captured!.selector);
        const expected = document.createRange();
        visible(expected, parts);
        expect(found?.compareBoundaryPoints(Range.START_TO_START, expected)).toBe(0);
        expect(found?.compareBoundaryPoints(Range.END_TO_END, expected)).toBe(0);
      } finally {
        await view.unmount();
      }
    });

    it("quotes prose, a display formula, and a file link with math in its label once each", async () => {
      const view = await citable(
        [
          "Intro \\(a_1\\) text.",
          "",
          "\\[",
          "r=1",
          "\\]",
          "",
          "See [Report \\(x\\) notes](/tmp/project/src/main.ts) and `code`.",
          "",
          "Outro.",
        ].join("\n"),
      );
      try {
        const whole = view.capture((range) => range.selectNodeContents(view.container));
        // The file chip is a control, so its label stays out.
        expect(whole?.selector.text.replace(/\s+/g, " ")).toBe(
          "Intro \\(a_1\\) text. \\[ r=1 \\] See Report \\(x\\) notes and code. Outro.",
        );

        const link = view.container.querySelector('[data-markdown-copy^="[Report"]')!;
        const [first, last] = [
          (t: Text) => t.data === "Report ",
          (t: Text) => t.data === " notes",
        ].map((match) => textNodes(link).find(match)!);
        const inLink = view.capture((range) => {
          range.setStart(first!, 0);
          range.setEnd(last!, last!.length);
        });
        expect(inLink?.selector.text).toBe("Report \\(x\\) notes");
        const found = resolveAssistantCitationRange(view.container, inLink!.selector);
        expect([found?.startContainer, found?.endContainer]).toEqual([first, last]);
      } finally {
        await view.unmount();
      }
    });
  });

  it("copies a file link with math in its label as the link, its label text as text, and the formula as TeX", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath("See [Report \\(x\\) notes](/tmp/project/src/main.ts).");
    try {
      const link = view.container.querySelector('[data-markdown-copy^="[Report"]')!;
      const copy = (select: (range: Range) => void) => {
        const range = document.createRange();
        select(range);
        const selection = { rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
        return chatMarkdownClipboardPayload(selection);
      };

      const label = copy((range) => range.selectNodeContents(link.firstChild!));
      expect(label?.text).toBe("Report");
      expect(label?.html).not.toContain("<code>");

      const whole = copy((range) => range.selectNode(link));
      expect(whole?.text).toBe("[Report \\(x\\) notes](/tmp/project/src/main.ts)");
      expect(whole?.html).toContain("Report <code>\\(x\\)</code> notes");
      expect(whole?.html).not.toMatch(/katex|annotation|<math/);

      const formula = copy((range) => range.selectNodeContents(link.querySelector(".katex-html")!));
      expect(formula?.text).toBe("\\(x\\)");
      expect(formula?.html).toBe('<meta charset="utf-8"><code>\\(x\\)</code>');
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("copies a table cell's file link with math in its label as its label with the TeX", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(
      "| File |\n|---|\n| [Report \\(x\\) notes](/tmp/project/src/main.ts) |",
    );
    try {
      expect(serializeTableElementToCsv(view.container.querySelector("table")!)).toBe(
        "File\nReport \\(x\\) notes main.ts",
      );
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("copies table math as TeX in CSV and Markdown while ordinary cells stay as before", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(
      "| Quantity | Value |\n|---|---|\n| \\(G\\) | \\(6.7\\times10^{-11}\\) |\n| **bold**, plain | so \\(\\sigma\\) here |",
    );
    try {
      const table = view.container.querySelector("table")!;
      expect(serializeTableElementToCsv(table)).toBe(
        'Quantity,Value\n\\(G\\),\\(6.7\\times10^{-11}\\)\n"bold, plain",so \\(\\sigma\\) here',
      );
      expect(serializeTableElementToMarkdown(table)).toContain(
        "| \\(G\\) | \\(6.7\\times10^{-11}\\) |",
      );
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("reads an escaped pipe in a table cell's formula the way a table reads one in a code span", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const table = [
      "| Case | Formula |",
      "| --- | --- |",
      "| bars | \\(\\|x\\|\\) |",
      "| norm | \\(\\Vert x\\Vert\\) |",
      "| row break | \\(a\\\\\\|b\\) |",
    ].join("\n");
    const view = await renderMath(`${table}\n\nOutside a table, \\(\\|x\\|\\) is a norm.`);
    try {
      // `\|` is the table's escape for a pipe; `\\\|` in the third cell is `\\` then that escape.
      expect(view.tex("td .katex")).toEqual(["|x|", "\\Vert x\\Vert", "a\\\\|b"]);
      expect(view.tex("p .katex")).toEqual(["\\|x\\|"]);
      // Copying the table escapes the pipes again.
      expect(serializeTableElementToMarkdown(view.container.querySelector("table")!)).toBe(table);
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("keeps code that only looks like math as code while math rendering is on", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(
      [
        "```math-inline",
        "a_1",
        "```",
        "",
        "```math-display",
        "b^2",
        "```",
        "",
        '<code class="language-math-inline">c^3</code> and <span><code class="language-math-inline">d^4</code></span>',
        "",
        '<pre><code class="language-math-display">e^5</code></pre>',
        "",
        "Real \\(f\\).",
      ].join("\n"),
    );
    try {
      expect(view.tex(".katex")).toEqual(["f"]);
      const code = view.container.textContent ?? "";
      for (const source of ["a_1", "b^2", "c^3", "d^4", "e^5"]) expect(code).toContain(source);
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  // Offsets in a blockquoted raw HTML block skip its `> ` prefixes, so authored
  // code can land on a real opener.
  it.each([
    ["inline", "> <div>\n> \\(<code>hello</code>\n> </div>"],
    ["display", "> <div>\n> \\[<pre><code>hello</code></pre>\n> </div>"],
  ])("keeps authored %s code as code when its offset lands on a math opener", async (_, source) => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(`${source}\n\nReal \\(f\\).`);
    try {
      expect(view.tex(".katex")).toEqual(["f"]);
      expect(view.container.querySelector("blockquote")?.textContent).toContain("hello");
      expect(view.container.querySelector("blockquote .katex")).toBeNull();
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("does not let authored HTML pass itself off as a formula", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const view = await renderMath(
      'Real <span data-markdown-math="inline" data-markdown-copy="\\(forged\\)">shown</span>.',
      { parseRawHtml: true, lineBreaks: false },
    );
    try {
      const paragraph = view.container.querySelector("p")!;
      expect(paragraph.querySelector("span")?.textContent).toBe("shown");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = { rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
      expect(chatMarkdownClipboardPayload(selection)?.text).toBe("Real shown.");
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("points task checkboxes at their own source after math", async () => {
    settingsOverrides.mathRenderingEnabled = true;
    const text = "Do \\(a\\) first:\n\n\\[\nb\n\\]\n\n- [ ] one \\(c\\)\n- [x] two";
    const view = await renderMath(text);
    try {
      const markers = [...view.container.querySelectorAll("li")].map((item) => {
        const offset = Number(item.getAttribute("data-task-marker-offset"));
        return text.slice(offset, offset + 3);
      });
      expect(markers).toEqual(["[ ]", "[x]"]);
    } finally {
      await view.unmount();
      delete settingsOverrides.mathRenderingEnabled;
    }
  });

  it("does not typeset math-classed raw HTML while math rendering is off", async () => {
    const view = await renderMath('<code class="language-math-inline">x^2</code>');
    try {
      expect(view.container.querySelector(".katex")).toBeNull();
      expect(view.container.querySelector("code")?.textContent).toBe("x^2");
    } finally {
      await view.unmount();
    }
  });

  it("leaves the source as ordinary Markdown while math rendering is off", async () => {
    const view = await renderMath(reply);
    try {
      expect(view.container.querySelector(".katex")).toBeNull();
      expect(view.container.textContent).toContain("(G)");
    } finally {
      await view.unmount();
    }
  });
});

it("opens a disclosure only when find selects a match inside it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const openStates = () =>
    [...container.querySelectorAll("[data-markdown-details-open]")].map((node) =>
      node.getAttribute("data-markdown-details-open"),
    );
  function Probe({
    activeOccurrence,
    searching = true,
  }: {
    activeOccurrence: number;
    searching?: boolean;
  }) {
    useThreadFindHighlights({
      container,
      query: searching ? "needle" : "",
      activeRowId: "row",
      activeOccurrence,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={searching}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "Visible needle.",
                "<details><summary>Unrelated</summary><p>nothing here</p></details>",
                "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
              ].join("\n\n")}
            />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  const frame = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  try {
    // Closed panels are unmounted until find starts, as in the app.
    await act(() => root.render(<Probe activeOccurrence={0} searching={false} />));
    expect(container.textContent).not.toContain("nothing here");
    await act(() => root.render(<Probe activeOccurrence={0} />));
    await frame();
    // Selecting the visible match opens nothing; the folded one is counted but not painted.
    expect(openStates()).toEqual(["false", "false", "false"]);
    expect(container.textContent).toContain("nothing here");
    expect(
      [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
    ).toEqual(["needle"]);
    expect(highlights.get("t3-thread-find")?.size).toBe(0);

    await act(() => root.render(<Probe activeOccurrence={1} />));
    await frame();
    await frame();
    // Stepping to the folded match opens its two ancestors, not the unrelated one.
    expect(openStates()).toEqual(["false", "true", "true"]);
    expect(highlights.get("t3-thread-find-active")?.size).toBe(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
  function Probe({ query }: { query: string }) {
    useThreadFindHighlights({
      container,
      query,
      activeRowId: "row",
      activeOccurrence: 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={true}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  const frame = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;
  try {
    await act(() => root.render(<Probe query="Needle" />));
    await frame();
    expect(diagrams()).toBe(2);
    await act(() => root.render(<Probe query="Alpha" />));
    await frame();
    await frame();
    // Only the diagram holding the selected match switches to source.
    expect(diagrams()).toBe(1);
    expect(
      [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
    ).toEqual(["Alpha"]);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
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
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Document template", count: 1, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, useTemplate: true },
])(
  "highlights the indexed occurrences of $query in $text",
  async ({ text, query, count, lineBreaks, user, useTemplate }) => {
    const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    );
    vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Probe() {
      useThreadFindHighlights({
        container,
        query,
        activeRowId: "row",
        activeOccurrence: 0,
        onActiveRange: () => {},
      });
      return (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={true}>
              <ChatMarkdown
                text={text}
                cwd={undefined}
                skills={skills}
                lineBreaks={lineBreaks ?? false}
                parseRawHtml={!user}
                onUseArtifactTemplate={useTemplate ? () => undefined : undefined}
              />
            </MarkdownFindContext>
          </div>
        </div>
      );
    }
    try {
      await act(() => root.render(<Probe />));
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const ranges = [...highlights.values()].flatMap((value) => [...value]);
      expect(ranges.map((range) => range.toString())).toEqual(
        Array.from({ length: count }, () => query),
      );
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

describe("ChatMarkdown heading ids", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        parseRawHtml
        text={
          '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install'
        }
      />,
    );
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const { createRoot } = await import("react-dom/client");
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      window.history.replaceState(null, "", "/#/env/thread");
      const scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      try {
        await act(async () => {
          root.render(
            <ChatMarkdown
              cwd="/tmp/project"
              parseRawHtml={parseRawHtml}
              text={
                "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model"
              }
            />,
          );
        });
        const headings = [...container.querySelectorAll("h2")];
        expect(headings.map((heading) => heading.id)).toEqual([
          "user-content-1-operating-model",
          "user-content-1-operating-model-1",
        ]);

        const [tocLink, missingLink] = [...container.querySelectorAll("a")];
        const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });
        const tocClick = click();
        tocLink!.dispatchEvent(tocClick);
        expect(tocClick.defaultPrevented).toBe(true);
        expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);

        const missingClick = click();
        missingLink!.dispatchEvent(missingClick);
        expect(missingClick.defaultPrevented).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(window.location.hash).toBe("#/env/thread");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
