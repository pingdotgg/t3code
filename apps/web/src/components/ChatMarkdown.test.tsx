import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  orderedListGutterStyle,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

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
    expect(html).toContain("chat-markdown-artifact-template");
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

    expect(html).toContain("chat-markdown-artifact-template");
    expect(html).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", () => {
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("chat-markdown-artifact-template");
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", () => {
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("chat-markdown-artifact-template");
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
    expect(html).not.toContain("chat-markdown-artifact-template");
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

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("widens the gutter for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toEqual({ "--list-gutter": "3ch" });
  });

  it("widens the gutter for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toEqual({ "--list-gutter": "3ch" });
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(5, "999995")).toEqual({ "--list-gutter": "7ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(3, -5)).toEqual({ "--list-gutter": "3ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
    expect(orderedListGutterStyle(0, 100)).toEqual({ "--list-gutter": "4ch" });
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
