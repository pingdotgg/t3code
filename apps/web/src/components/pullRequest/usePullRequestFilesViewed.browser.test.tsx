import { EnvironmentId, ProjectId, type PullRequestFilesViewedResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  data: null as PullRequestFilesViewedResult | null,
  error: null as string | null,
  overlay: new Map<string, boolean>(),
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ ...state, refresh: () => {} })) as never,
}));
vi.mock(import("./filesViewedStore"), () => ({
  filesViewedScope: () => ({
    subscribe: () => () => {},
    getSnapshot: () => state.overlay,
    setViewed: () => {},
  }),
}));
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

function setup() {
  state.data = { files: [{ path: "a.ts", state: "viewed" }], truncated: false };
  state.error = null;
  state.overlay = new Map();
}

function Probe() {
  const view = usePullRequestFilesViewed({
    environmentId: EnvironmentId.make("viewed-read-failure"),
    reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
    enabled: true,
    paths: ["a.ts", "new.test.ts"],
  });
  return <output>{JSON.stringify({ paths: view.filePaths, ready: view.ready })}</output>;
}

it("stops treating retained files as complete after a refresh fails", async () => {
  setup();
  await using screen = await render(<Probe />);
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ paths: ["a.ts"], ready: true });
  state.error = "Refresh failed";
  await screen.rerender(<Probe />);
  expect(result()).toEqual({ paths: null, ready: false });
});
