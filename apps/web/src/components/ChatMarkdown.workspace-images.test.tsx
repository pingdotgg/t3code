import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
  editorEnvironmentIds: [] as Array<unknown>,
  remoteEnvironmentIds: [] as Array<unknown>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return { _tag: "Success", url: "https://signed.test/workspace-image.svg" };
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: (environmentId: unknown) => {
    testState.editorEnvironmentIds.push(environmentId);
    return vi.fn();
  },
  usePreferredEditor: () => ["vscode", vi.fn()],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: (environmentId: unknown) => {
    testState.remoteEnvironmentIds.push(environmentId);
    return {
      isResolved: true,
      state: { mode: "local-exec", localExecutionUnavailableReason: null },
    };
  },
}));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-windows"),
  threadId: ThreadId.make("thread-windows"),
};

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ChatMarkdown cwd={"C:\\Users\\shawn\\project"} threadRef={threadRef} text={markdown} />,
  );
}

function renderWithoutThread(markdown: string): string {
  return renderToStaticMarkup(<ChatMarkdown cwd={"C:\\Users\\shawn\\project"} text={markdown} />);
}

function renderFilePreview(cwd: string, relativePath: string): string {
  return renderToStaticMarkup(
    <FileMarkdownPreview
      cwd={cwd}
      relativePath={relativePath}
      text="![diagram](images/diagram.png)"
      threadRef={threadRef}
    />,
  );
}

function copiedMarkdownFrom(html: string): string {
  const copy = /data-markdown-copy="([^"]*)"/.exec(html)?.[1]?.replaceAll("&quot;", '"');
  expect(copy).toBeDefined();
  return copy ?? "";
}

function firstInlineStyle(html: string): Record<string, string> {
  const style = /style="([^"]+)"/.exec(html)?.[1];
  expect(style).toBeDefined();
  return Object.fromEntries(
    (style ?? "").split(";").map((declaration) => {
      const separator = declaration.indexOf(":");
      return [declaration.slice(0, separator), declaration.slice(separator + 1)];
    }),
  );
}

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
    testState.assetState = "success";
    testState.editorEnvironmentIds = [];
    testState.remoteEnvironmentIds = [];
  });

  it.each([
    ["/workspace/project", "docs/README.md", "/workspace/project/docs/images/diagram.png"],
    [
      "C:\\Users\\shawn\\project",
      "docs\\README.md",
      "C:\\Users\\shawn\\project\\docs\\images\\diagram.png",
    ],
    ["/workspace/project", "README.md", "/workspace/project/images/diagram.png"],
  ])("resolves images beside a nested file in %s", (cwd, relativePath, expectedPath) => {
    renderFilePreview(cwd, relativePath);

    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: expectedPath,
      },
    ]);
  });

  it("loads relative workspace paths through signed asset URLs", () => {
    const html = render("![relative](.t3/workspace-image.svg)");

    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
    ]);
    expect(html).toContain("https://signed.test/workspace-image.svg");
  });

  it("preserves Windows drive links through markdown sanitization", () => {
    const html = render(String.raw`[Open](C:\Users\shawn\project\src\main.ts)`);
    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it("loads drive-absolute markdown and raw HTML images through assets", () => {
    const html = render(
      [
        "![absolute](C:/Users/shawn/project/.t3/workspace-image.svg)",
        String.raw`<img src="D:\screens\workspace-image.svg" alt="raw">`,
      ].join("\n\n"),
    );
    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "C:/Users/shawn/project/.t3/workspace-image.svg",
      },
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "D:/screens/workspace-image.svg",
      },
    ]);
    expect(html.match(/https:\/\/signed\.test\/workspace-image\.svg/g)).toHaveLength(2);
  });

  it("keeps a tall image placeholder and loaded image at the same proportional bounds", () => {
    const markdown = '<img src=".t3/workspace-image.svg" alt="sized" width="96" height="128">';
    const loadedStyle = firstInlineStyle(render(markdown));
    testState.assetState = "loading";
    const loadingStyle = firstInlineStyle(render(markdown));

    expect(loadedStyle).toMatchObject({
      width: "96px",
      height: "auto",
      "aspect-ratio": "96 / 128",
      "max-width": "min(100%, 30rem, 22.5rem)",
    });
    expect(loadingStyle).toEqual(loadedStyle);
  });

  it.each([
    ["width", "max-width", "min(100%, 30rem, 300px)"],
    ["height", "max-height", "min(30rem, 300px)"],
  ])("treats a lone authored %s as a cap", (axis, constraint, expectedValue) => {
    const markdown = `<img src=".t3/workspace-image.svg" alt="sized" ${axis}="300">`;
    const loadedStyle = firstInlineStyle(render(markdown));

    expect(loadedStyle).not.toHaveProperty(axis);
    expect(loadedStyle).toHaveProperty(constraint, expectedValue);
  });

  it("keeps all images baseline-aligned and workspace images inline", () => {
    const html = render(
      "![remote](https://example.com/badge.svg) ![workspace](.t3/workspace-image.svg)",
    );
    const classNames = Array.from(html.matchAll(/<img[^>]*class="([^"]*)"/g), (match) =>
      match[1]?.split(" "),
    );

    expect(classNames).toHaveLength(2);
    expect(classNames[1]).toContain("inline-block!");

    const centeredHtml = render(
      '<p align="center"><img src=".t3/workspace-image.svg" alt="logo"></p>',
    );
    const centeredClassName = /<img[^>]*class="([^"]*)"/.exec(centeredHtml)?.[1];

    expect(centeredClassName?.split(" ")).toContain("inline-block!");
  });

  it("retains an authored SVG fragment on the signed URL", () => {
    const html = render("![logo](icons.svg#logo)");

    expect(html).toContain('src="https://signed.test/workspace-image.svg#logo"');
  });

  it.each(["success", "loading", "failure", "no-thread"] as const)(
    "copies the authored workspace source (%s)",
    (scenario) => {
      if (scenario === "no-thread") {
        const html = renderWithoutThread("![diagram](images/diagram.png)");
        expect(copiedMarkdownFrom(html)).toBe("![diagram](images/diagram.png)");
        return;
      }

      testState.assetState = scenario;
      const html = render("![diagram](images/diagram.png#preview)");

      expect(copiedMarkdownFrom(html)).toBe("![diagram](images/diagram.png#preview)");
    },
  );

  it("copies an authored title with a workspace image", () => {
    const html = render('![logo](images/logo.svg "My Title")');

    expect(copiedMarkdownFrom(html)).toBe('![logo](images/logo.svg "My Title")');
  });

  it("escapes double quotes in an authored image title", () => {
    const html = render(`![logo](images/logo.svg 'My "Title"')`);

    expect(copiedMarkdownFrom(html)).toBe('![logo](images/logo.svg "My \\"Title\\"")');
  });

  it("escapes a closing bracket in authored image alt text", () => {
    const markdown = String.raw`![build\] badge](badge.svg)`;

    expect(copiedMarkdownFrom(render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash in authored image alt text", () => {
    const markdown = String.raw`![folder\\name](badge.svg)`;

    expect(copiedMarkdownFrom(render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash before a quote in an authored image title", () => {
    const html = render(
      String.raw`<img src="images/logo.svg" alt="logo" title="Path \&quot;Title\&quot;">`,
    );

    expect(copiedMarkdownFrom(html)).toBe(
      String.raw`![logo](images/logo.svg "Path \\\"Title\\\"")`,
    );
  });

  it("uses a static bounded-width placeholder while a signed asset URL loads", () => {
    testState.assetState = "loading";
    const html = render("![loading](.t3/workspace-image.svg)");
    const className = /<span[^>]*aria-label="Loading image"[^>]*class="([^"]*)"/.exec(html)?.[1];

    expect(html).toContain('aria-label="Loading image"');
    expect(html).not.toContain("animate-pulse");
    expect(className?.split(" ")).toContain("w-64");
  });

  it("keeps remote images directly loadable", () => {
    const html = render("![remote](https://example.com/image.png)");
    expect(testState.resources).toEqual([]);
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain("max-h-[30rem]");
  });

  it("uses the markdown owner's environment for file actions", () => {
    const owningEnvironmentId = EnvironmentId.make("env-pull-request");

    renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        environmentId={owningEnvironmentId}
        text="[Open](src/main.ts)"
      />,
    );

    expect(testState.editorEnvironmentIds).toEqual([owningEnvironmentId]);
    expect(testState.remoteEnvironmentIds).toEqual([owningEnvironmentId]);
  });
});
