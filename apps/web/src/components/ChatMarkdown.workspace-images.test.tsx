import { EnvironmentId, ProjectId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { act, type ReactNode, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
  imageDimensions: undefined as { width: number; height: number } | undefined,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return {
      _tag: "Success",
      url: "https://signed.test/workspace-image.svg",
      ...(testState.imageDimensions ? { imageDimensions: testState.imageDimensions } : {}),
    };
  },
}));
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
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
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
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, { ChatMarkdownAssetImage } from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";
import { PullRequestMarkdown } from "./pullRequest/PullRequestMarkdown";
import { PullRequestAttachmentContext } from "./pullRequest/PullRequestAttachmentContext";

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
    testState.imageDimensions = undefined;
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

  it("sizes the slot from server-reported dimensions so a portrait image never grows", () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const style = firstInlineStyle(render("![shot](.t3/workspace-image.svg)"));

    expect(style).toMatchObject({ width: "720px", "aspect-ratio": "720 / 1400" });
  });

  it("folds a caller's height cap into the width bound so the ratio holds", () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const html = renderToStaticMarkup(
      <ChatMarkdownAssetImage
        environmentId={threadRef.environmentId}
        resource={{ _tag: "media-file", threadId: threadRef.threadId, path: "/shot.png" }}
        alt="shot"
        maxHeightRem={16}
      />,
    );

    expect(firstInlineStyle(html)).toMatchObject({
      "aspect-ratio": "720 / 1400",
      "max-width": `min(100%, 30rem, ${(16 * 720) / 1400}rem)`,
    });
  });

  it("lets an authored size override server-reported dimensions", () => {
    testState.imageDimensions = { width: 720, height: 1400 };

    const style = firstInlineStyle(
      render('<img src=".t3/workspace-image.svg" alt="sized" width="96" height="128">'),
    );

    expect(style).toMatchObject({ width: "96px", "aspect-ratio": "96 / 128" });
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

it("loads native PR media through signed URLs and keeps ordinary external media direct", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  const resolveMediaResource = (
    url: string,
  ): Extract<AssetResource, { _tag: "pull-request-media" }> | null =>
    url.startsWith("/uploads/") || url.startsWith("https://gitlab.com/owner/repo/-/uploads/")
      ? {
          _tag: "pull-request-media",
          provider: "gitlab",
          reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
          url: url.startsWith("/") ? `https://gitlab.com/owner/repo/-${url}` : url,
        }
      : null;
  const text =
    "![private](/uploads/hash/shot.png)\n\n[Private document](https://gitlab.com/owner/repo/-/uploads/hash/report.pdf)\n\n[clip.mp4](/uploads/hash/clip.mp4)\n\n![public](https://public.example/shot.png)";
  try {
    testState.assetState = "loading";
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          environmentId={threadRef.environmentId}
          cwd="/repo"
          text={text}
          resolveMediaResource={resolveMediaResource}
        />,
      );
    });
    expect(testState.resources).toContainEqual(
      expect.objectContaining({
        _tag: "pull-request-media",
        url: "https://gitlab.com/owner/repo/-/uploads/hash/shot.png",
      }),
    );
    expect(testState.resources).toContainEqual(
      expect.objectContaining({
        _tag: "pull-request-media",
        url: "https://gitlab.com/owner/repo/-/uploads/hash/clip.mp4",
      }),
    );
    expect(
      renderer!.root.findAllByType("img").some((node) => node.props.src?.includes("/uploads/")),
    ).toBe(false);
    testState.assetState = "success";
    await act(async () => {
      renderer!.update(
        <ChatMarkdown
          environmentId={threadRef.environmentId}
          cwd="/repo"
          text={text}
          resolveMediaResource={(url) => resolveMediaResource(url)}
        />,
      );
    });
    expect(
      renderer!.root
        .findAllByType("img")
        .some((node) => node.props.src?.startsWith("https://signed.test/")),
    ).toBe(true);
    expect(
      renderer!.root
        .findAllByType("a")
        .some(
          (node) => node.props.href === "https://gitlab.com/owner/repo/-/uploads/hash/report.pdf",
        ),
    ).toBe(true);

    expect(
      renderer!.root
        .findAllByType("img")
        .some((node) => node.props.src === "https://public.example/shot.png"),
    ).toBe(true);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  [
    "github",
    "github.com",
    "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789012",
  ],
  ["github", "github.com", "https://raw.githubusercontent.com/other/repo/main/image.png"],
  ["bitbucket", "bitbucket.org", "https://bitbucket.org/owner/repo/downloads/shot.png"],
  [
    "gitlab",
    "gitlab.com",
    "https://gitlab.com/owner/repo/uploads/0123456789abcdef0123456789abcdef/icons.svg#icon",
  ],
  [
    "gitlab",
    "gitlab.com",
    "https://gitlab.com/owner/repo/uploads/0123456789abcdef0123456789abcdef/shot.png",
  ],
  [
    "forgejo",
    "code.example.com",
    "https://code.example.com/attachments/12345678-1234-1234-1234-123456789012",
  ],
  [
    "azure-devops",
    "dev.azure.com",
    "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/1/attachments/shot.png?api-version=7.1-preview.1",
  ],
] as const)(
  "uses the PR context to show private %s attachments in saved comments and editor previews",
  async (provider, host, url) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    testState.assetState = "success";
    testState.resources.length = 0;
    try {
      await act(async () => {
        renderer = create(
          <PullRequestAttachmentContext
            value={{
              environmentId: threadRef.environmentId,
              reference: {
                projectId: ProjectId.make("project"),
                host,
                repository: "owner/repo",
                number: 1,
                expectedAccountId: "account",
              },
              provider,
              cwd: "/repo",
              url: undefined,
              capabilities: { supported: true, maxBytes: 1024, destination: "pull-request" },
              upload: async () => "",
            }}
          >
            <PullRequestMarkdown
              environmentId={threadRef.environmentId}
              cwd="/repo"
              text={`![private](${url})`}
            />
          </PullRequestAttachmentContext>,
        );
      });
      expect(testState.resources).toContainEqual(
        expect.objectContaining({
          _tag: "pull-request-media",
          provider,
          reference: expect.objectContaining({ expectedAccountId: "account" }),
          url: url.split("#", 1)[0],
        }),
      );
      expect(
        renderer!.root
          .findAllByType("img")
          .some((node) => node.props.src?.startsWith("https://signed.test/")),
      ).toBe(true);
      if (url.includes("#icon"))
        expect(
          renderer!.root.findAllByType("img").some((node) => node.props.src?.endsWith("#icon")),
        ).toBe(true);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("does not use the legacy GitHub credential when the PR media resolver rejects a URL", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.resources.length = 0;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          environmentId={threadRef.environmentId}
          cwd="/repo"
          text="![external](https://raw.githubusercontent.com/other/repo/main/image.png)"
          githubMedia
          resolveMediaResource={() => null}
        />,
      );
    });
    expect(testState.resources).toEqual([]);
    expect(
      renderer!.root
        .findAllByType("img")
        .some(
          (node) =>
            node.props.src === "https://raw.githubusercontent.com/other/repo/main/image.png",
        ),
    ).toBe(true);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    vi.unstubAllGlobals();
  }
});
