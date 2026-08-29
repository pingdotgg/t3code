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
  useActiveEnvironmentId: () => EnvironmentId.make("env-windows"),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));

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

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
    testState.assetState = "success";
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

  it("shows a stable placeholder while the signed URL loads", () => {
    testState.assetState = "loading";
    const html = render("![loading](.t3/workspace-image.svg)");
    expect(html).toContain('aria-label="Loading image"');
    expect(html).not.toContain("animate-pulse");
  });

  it("keeps remote images directly loadable", () => {
    const html = render("![remote](https://example.com/image.png)");
    expect(testState.resources).toEqual([]);
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain("max-h-[30rem]");
  });
});
