import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import WorkflowPane from "./WorkflowPane";

const environmentId = EnvironmentId.make("laptop");
const state = vi.hoisted(() => ({
  linked: [] as ReadonlyArray<string>,
  openThreadPage: null as unknown as (...input: ReadonlyArray<unknown>) => void,
}));

vi.mock(import("../../state/peerLinks"), async (original) => ({
  ...(await original()),
  useLinkedEnvironments: ((id: EnvironmentId | null) =>
    new Map(
      id === environmentId
        ? state.linked.map((link) => [EnvironmentId.make(link), "Build box"])
        : [],
    )) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId | null) =>
    id === environmentId ? { environmentId, label: "Laptop" } : null) as never,
}));
// The thread itself is the chat's to render; these tests are about where the pane's button leads.
vi.mock("./WorkflowThreadPane", () => ({
  default: () => null,
  WorkflowThreadTabLabel: () => "Agent",
  useOpenThreadPage: () => state.openThreadPage,
}));

const pane = (env: string | undefined) => (
  <WorkflowPane
    environmentId={environmentId}
    runId={null}
    state={{ pane: [{ thread: "thread-2", ...(env === undefined ? {} : { env }) }] }}
    onChange={vi.fn()}
  />
);

describe("WorkflowPane", () => {
  it("opens a thread on a linked environment through the run's environment", async () => {
    state.linked = ["build-box"];
    state.openThreadPage = vi.fn();
    await using screen = await render(pane("build-box"));

    await screen.getByRole("button", { name: "Open as a full thread" }).click();
    expect(state.openThreadPage).toHaveBeenCalledWith(
      { environmentId: "build-box", threadId: "thread-2" },
      environmentId,
    );
  });

  it("opens a thread on the run's own environment directly", async () => {
    state.linked = [];
    state.openThreadPage = vi.fn();
    await using screen = await render(pane(undefined));

    await screen.getByRole("button", { name: "Open as a full thread" }).click();
    expect(state.openThreadPage).toHaveBeenCalledWith(
      { environmentId, threadId: "thread-2" },
      undefined,
    );
  });

  it("offers no full thread on an environment this client cannot reach", async () => {
    state.linked = [];
    state.openThreadPage = vi.fn();
    await using screen = await render(pane("build-box"));

    await expect.element(screen.getByRole("tab", { name: "Agent" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open as a full thread" }))
      .not.toBeInTheDocument();
  });
});
