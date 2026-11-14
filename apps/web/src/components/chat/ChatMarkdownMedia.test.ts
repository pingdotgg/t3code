import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../../rightPanelStore";
import { assetMediaActionsSource } from "./ChatMarkdownMedia";

it.each([
  { run: "the thread's folder", root: "/repo-w/app", path: "/repo-w/app/a.png", opens: ["a.png"] },
  { run: "another folder", root: "/repo-a", path: "/repo-a/a.png", opens: ["/repo-a/a.png"] },
  { run: "a parent folder", root: "/repo-w", path: "/repo-w/app/a.png", opens: ["a.png"] },
  { run: "another folder, file outside it", root: "/repo-a", path: "/tmp/a.png", opens: [] },
])("opens a media file of a run in $run by a path the panel reads", ({ root, path, opens }) => {
  using openFile = vi.spyOn(useRightPanelStore.getState(), "openFile").mockImplementation(() => {});
  assetMediaActionsSource({
    environmentId: EnvironmentId.make("environment-1"),
    resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path },
    kind: "image",
    name: "image",
    src: null,
    workspaceRoot: root,
    threadWorkspaceRoot: "/repo-w/app",
  }).onOpenFile?.();
  expect(openFile.mock.calls.map((call) => call[1])).toEqual(opens);
});
