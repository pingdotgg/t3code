import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import type { VideoPreviewSource } from "../../components/VideoPreviewModal";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPullRequest: vi.fn(async () => true),
}));
const navigation = { navigate: harness.navigate };
vi.mock("./useOpenLinkedThread", () => ({
  useOpenLinkedThread: () => (target: unknown) => harness.navigate("Thread", target),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => [] } }));
vi.mock("../../state/entities", () => ({ resolveThreadLink: () => null }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigation }));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => harness.openPullRequest,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));

import { useThreadMarkdownLinkPress } from "./useThreadMarkdownLinkPress";

function LinkHarness(props: { readonly href: string; readonly imageEmbed?: boolean }) {
  const [file, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [video, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const open = useThreadMarkdownLinkPress({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    workspaceRoot: "/repo",
    setExpandedFile,
    setExpandedVideo,
  });
  return (
    <>
      <button onClick={() => open(props.href, props.imageEmbed)}>Open</button>
      <output>{JSON.stringify({ file, video })}</output>
    </>
  );
}

describe("thread Markdown links", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ["t3-thread://v1/linked-thread", "Thread", { threadId: "linked-thread" }],
    [
      "/repo/src/main.ts#L42",
      "ThreadFile",
      { threadId: "thread-1", path: ["src", "main.ts"], line: "42" },
    ],
    ["src/main.ts", "ThreadFile", { threadId: "thread-1", path: ["src", "main.ts"] }],
    ["/tmp/report.md", "ThreadFile", { threadId: "thread-1", path: ["", "tmp", "report.md"] }],
  ])("opens %s in the owning environment", async (href, route, params) => {
    harness.navigate.mockClear();
    harness.openPullRequest.mockClear();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<LinkHarness href={href} />));
      await act(async () => host.querySelector("button")?.click());
      expect(harness.navigate).toHaveBeenCalledWith(route, {
        environmentId: "environment-1",
        ...params,
      });
      expect(harness.openPullRequest).not.toHaveBeenCalled();
      expect(host.querySelector("output")?.textContent).toBe('{"file":null,"video":null}');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    ["https://linear.app/login", false, null],
    ["https://github.com/pingdotgg/t3code/pull/1", false, null],
    ["https://cdn.example.com/render?id=42", true, "image"],
    ["/repo/docs/spec.pdf", false, "pdf"],
    ["https://cdn.example.com/demo.mp4", false, "video"],
  ])("routes %s to the existing link or media destination", async (href, imageEmbed, kind) => {
    harness.navigate.mockClear();
    harness.openPullRequest.mockClear();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<LinkHarness href={href} imageEmbed={imageEmbed} />));
      await act(async () => host.querySelector("button")?.click());
      expect(harness.navigate).not.toHaveBeenCalled();
      if (kind === null) {
        expect(harness.openPullRequest).toHaveBeenCalledWith(href);
        expect(host.querySelector("output")?.textContent).toBe('{"file":null,"video":null}');
      } else {
        expect(harness.openPullRequest).not.toHaveBeenCalled();
        const preview = host.querySelector("output")?.textContent;
        if (kind === "video") {
          expect(preview).toContain('"type":"media"');
          expect(preview).toContain(`"uri":"${href}"`);
        } else {
          expect(preview).toContain(`"kind":"${kind}"`);
        }
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
