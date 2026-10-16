import { expect, it, vi } from "vite-plus/test";
import { usePullRequestAction } from "./usePullRequestAction";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: { runAction: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => run }));
vi.mock("./usePullRequestPermissions", () => ({
  usePullRequestPermissions: () => ({ canWrite: true }),
}));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (input: unknown) => ({ environmentId: "environment", input }),
}));

it("ignores an action while the pull request detail has not loaded", async () => {
  const action = usePullRequestAction(
    { environmentId: "environment", projectId: "project", repository: "owner/repo", number: 1 },
    null,
  );
  expect(action.available("close")).toBe(false);
  await expect(action.perform("close")).resolves.toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});
