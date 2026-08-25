import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading",
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    return testState.assetState === "loading"
      ? { _tag: "Loading" }
      : { _tag: "Success", url: "https://signed.test/workspace-image.svg" };
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
  useActiveEnvironmentId: () => EnvironmentId.make("env-windows"),
  useProjects: () => [],
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

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

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
    testState.assetState = "success";
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
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      { _tag: "workspace-file", threadId: threadRef.threadId, path: imagePath },
      { _tag: "workspace-file", threadId: threadRef.threadId, path: imagePath },
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "\\\\server\\share\\workspace-image.svg",
      },
    ]);
    expect(html.match(/https:\/\/signed\.test\/workspace-image\.svg/g)).toHaveLength(4);
    expect(html.match(/max-w-\[min\(100%,30rem\)\]/g)).toHaveLength(4);
    expect(html.match(/max-h-\[30rem\]/g)).toHaveLength(4);
    expect(html).not.toContain("Image unavailable");
  });

  it("normalizes a drive-absolute src in raw image HTML", () => {
    const html = render(String.raw`<img src="D:\screens\workspace-image.svg" alt="raw">`);

    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: "D:/screens/workspace-image.svg",
      },
    ]);
    expect(html).toContain("https://signed.test/workspace-image.svg");
  });

  it("uses a static placeholder while a signed asset URL loads", () => {
    testState.assetState = "loading";

    const html = render("![loading](.t3/workspace-image.svg)");

    expect(html).toContain('aria-label="Loading image"');
    expect(html).not.toContain("animate-pulse");
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
    expect(html).toContain("max-h-[30rem]");
    expect(html).not.toContain("Image unavailable");
  });
});
