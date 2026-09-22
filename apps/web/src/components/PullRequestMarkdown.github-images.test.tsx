import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Success", url: "https://signed.test/pr-image.png" }),
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

vi.mock("./media/MediaActions", () => ({
  MediaActions: ({ children }: { children: ReactNode }) => children,
}));

import { ChatMarkdownAssetImage } from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("env-pr"),
  threadId: ThreadId.make("thread-pr"),
};
const ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918";

describe("ChatMarkdownAssetImage GitHub media fallback", () => {
  it("keeps the loading slot through a signed-URL failure, then shows the original", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{ _tag: "github-media", cwd: "/repo", url: ATTACHMENT_URL }}
          alt="Screenshot"
          framed={false}
          fallbackSrc={ATTACHMENT_URL}
          originalUrl={ATTACHMENT_URL}
        />,
      );
    });
    try {
      expect(renderer.root.findByType("img").props.src).toBe("https://signed.test/pr-image.png");
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findByType("img").props.src).toBe(ATTACHMENT_URL);
      expect(renderer.root.findByProps({ "aria-label": "Loading image" })).toBeDefined();
      await act(async () => renderer.root.findByType("img").props.onLoad());
      expect(renderer.root.findByType("img").props.src).toBe(ATTACHMENT_URL);
      expect(renderer.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(0);
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findAllByType("img")).toHaveLength(0);
      expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
});
