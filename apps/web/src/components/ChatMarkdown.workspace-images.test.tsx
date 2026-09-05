import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
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
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: expectedPath,
      },
    ]);
  });

  it("loads every Windows workspace path form through a signed asset URL", () => {
    const imagePath = "C:/Users/shawn/project/.t3/workspace-image.svg";
    const html = render(
      [
        "![relative](.t3/workspace-image.svg)",
        `![absolute](${imagePath})`,
        `![file URL](file:///${imagePath})`,
        "![UNC file URL](file://server/share/workspace-image.svg)",
      ].join("\n\n"),
    );

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      { _tag: "media-file", threadId: threadRef.threadId, path: imagePath },
      { _tag: "media-file", threadId: threadRef.threadId, path: imagePath },
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "\\\\server\\share\\workspace-image.svg",
      },
    ]);
    expect(html.match(/<img[^>]*src="https:\/\/signed\.test\/workspace-image\.svg"/g)).toHaveLength(
      4,
    );
    expect(html.match(/max-w-\[min\(100%,30rem\)\]/g)).toHaveLength(4);
    expect(html).not.toContain("Image unavailable");
  });

  it("loads a POSIX absolute path and file URI through a signed asset URL", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text={[
          "![absolute](/tmp/embed-test/2.png)",
          "![file URL](file:///tmp/embed-test/5.png)",
        ].join("\n\n")}
      />,
    );

    expect(testState.resources).toEqual([
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/2.png" },
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/5.png" },
    ]);
    expect(html).not.toContain("Image unavailable");
  });

  it("normalizes a drive-absolute src in raw image HTML", () => {
    const html = render(String.raw`<img src="D:\screens\workspace-image.svg" alt="raw">`);

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "D:/screens/workspace-image.svg",
      },
    ]);
    expect(html).toContain("https://signed.test/workspace-image.svg");
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

  it("keeps images that share a line inline and lets a standalone one reserve a slot", () => {
    const html = render(
      "![remote](https://example.com/badge.svg) ![workspace](.t3/workspace-image.svg)",
    );

    // Two images in one paragraph are badges: neither reserves a slot.
    expect(html).not.toContain("aspect-video");
    expect(html).toContain('src="https://example.com/badge.svg"');
    expect(html).toContain('src="https://signed.test/workspace-image.svg"');
    expect(html.match(/<img[^>]*class="[^"]*inline-block![^"]*"/g)).toHaveLength(1);
    expect(html).not.toContain("invisible");

    const centeredHtml = render(
      '<p align="center"><img src=".t3/workspace-image.svg" alt="logo"></p>',
    );
    const frame = /<span[^>]*role="status"[^>]*>/.exec(centeredHtml)?.[0];

    expect(frame).toContain("inline-block!");
    expect(frame).toContain("aspect-video");
  });

  it("reserves a slot for an image that is the only content of its link", () => {
    const html = render("[![shot](.t3/workspace-image.svg)](https://example.com)");

    expect(html).toContain("aspect-video");
  });

  it.each([
    ["a link", "Figure: [![shot](.t3/workspace-image.svg)](https://example.com)"],
    ["emphasis", "**![shot](.t3/workspace-image.svg)** caption"],
  ])("keeps an image wrapped in %s inline when text shares its block", (_wrapper, markdown) => {
    expect(render(markdown)).not.toContain("aspect-video");
  });

  it("keeps an authored id on a remote image so fragment links resolve", () => {
    const html = render('<img id="diagram" src="https://example.com/diagram.png" alt="diagram">');

    // The sanitizer prefixes authored ids; the loading slot carries it too.
    expect(html).toContain('<span id="user-content-diagram"');
  });

  it("reserves a slot for an image that is alone in a list item", () => {
    expect(render("- ![shot](.t3/workspace-image.svg)")).toContain("aspect-video");
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

  it("reserves the same 16:9 frame while the URL, the bytes, and a failure resolve", () => {
    const frameClassName = (html: string) => {
      const frame = /<span[^>]*role="(?:status|alert)"[^>]*>/.exec(html)?.[0] ?? "";
      return /class="([^"]*)"/.exec(frame)?.[1]?.split(" ") ?? [];
    };
    const markdown = "![shot](.t3/workspace-image.svg)";

    testState.assetState = "loading";
    const loadingUrl = frameClassName(render(markdown));
    testState.assetState = "success";
    const loadingBytes = render(markdown);
    testState.assetState = "failure";
    const failure = render(markdown);

    expect(loadingUrl).toEqual(expect.arrayContaining(["aspect-video", "w-full"]));
    expect(loadingUrl).not.toContain("animate-pulse");
    expect(frameClassName(loadingBytes)).toEqual(loadingUrl);
    expect(frameClassName(failure)).toEqual(loadingUrl);
    expect(failure).toContain("Image unavailable");
    // The bytes are requested inside the frame but never paint at an unknown size.
    expect(loadingBytes).toMatch(/<img[^>]*src="https:\/\/signed[^>]*class="invisible/);
    expect(loadingBytes).not.toContain('loading="lazy"');
  });

  it("gives a standalone remote image the same frame instead of a bare tag", () => {
    const html = render("![remote](https://example.com/shot.png)");

    expect(html).toContain('aria-label="Loading image"');
    expect(html).toContain("aspect-video");
  });

  it("never passes a workspace source to a raw image when thread context is unavailable", () => {
    const html = renderWithoutThread(
      "![file URL](file:///C:/Users/shawn/project/workspace-image.svg)",
    );

    expect(testState.resources).toEqual([]);
    expect(html).toContain("Image unavailable");
    expect(html).not.toContain("file://");
  });

  it("blocks unsupported image schemes instead of passing them to a raw image", () => {
    const html = render("![unsupported](content://media/image/1)");

    expect(testState.resources).toEqual([]);
    expect(html).toContain("Image unavailable");
    expect(html).not.toContain("content://");
  });

  it("keeps remote images directly loadable", () => {
    const html = render("![remote](https://example.com/image.png)");

    expect(testState.resources).toEqual([]);
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain("max-w-[min(100%,30rem)]");
    expect(html).not.toContain("Image unavailable");
  });
});
