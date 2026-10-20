import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDetail } from "@t3tools/contracts";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

const state = vi.hoisted(() => ({
  connected: false,
  canAsk: true,
  ask: vi.fn(),
}));
vi.mock("./usePullRequestConnected", () => ({
  usePullRequestConnected: () => state.connected,
}));
vi.mock("./usePullRequestThreads", () => ({
  usePullRequestThreads: () => ({
    threads: [],
    canAsk: state.canAsk,
    canWatch: true,
    busy: false,
    isPending: true,
    ask: state.ask,
  }),
}));
const params = {
  environmentId: "environment",
  projectId: "project",
  repository: "owner/repo",
  number: 1,
};
const pr = { state: "open", mergeability: "conflicting" } as PullRequestDetail;

beforeEach(() => {
  state.connected = false;
  state.canAsk = true;
  state.ask.mockClear();
});

describe("PR agent drafts", () => {
  it("opens offline drafts without waiting for linked-thread discovery", () => {
    const actions = usePullRequestAgentActions(params, pr);
    expect(actions.disabled).toBe(false);
    actions.start("ask");
    actions.start("feedback");
    expect(state.ask.mock.calls).toEqual([
      [undefined, "ask"],
      [undefined, "feedback"],
    ]);
  });

  it("does not open drafts when the connection denies task access", () => {
    state.connected = true;
    state.canAsk = false;
    usePullRequestAgentActions(params, pr).start("feedback");
    expect(state.ask).not.toHaveBeenCalled();
  });
});
