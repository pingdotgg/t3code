import { EnvironmentId, ThreadId, type OrchestrationV2ThreadRecap } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const state = vi.hoisted(() => ({
  data: null as OrchestrationV2ThreadRecap | null,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.data }),
}));

import { ThreadDetailsRecap } from "./ThreadDetailsRecap";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

describe("ThreadDetailsRecap", () => {
  it("renders the recap text and toggles collapse while keeping the header visible", async () => {
    state.data = {
      status: "idle",
      text: "Auth refactor complete; next step is running integration checks.",
      updatedAt: "2026-11-28T12:00:00.000Z",
    };

    // router: false — ThreadDetailsRecap renders no links and reads no route state.
    await using _screen = await render(
      <ThreadDetailsRecap environmentId={environmentId} threadId={threadId} />,
      { router: false },
    );

    const text = page.getByText("Auth refactor complete; next step is running integration checks.");
    await expect.element(text).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Collapse recap" }));
    await expect.element(page.getByRole("heading", { name: "Recap" })).toBeVisible();
    await expect.element(text).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Expand recap" }));
    await expect.element(text).toBeVisible();
  });

  it("shows loading state only when pending with no text, and renders nothing when idle empty", async () => {
    state.data = { status: "pending", text: null, updatedAt: null };
    await using screen = await render(
      <ThreadDetailsRecap environmentId={environmentId} threadId={threadId} />,
      { router: false },
    );
    await expect.element(page.getByLabelText("Generating recap")).toBeVisible();

    state.data = { status: "idle", text: null, updatedAt: null };
    await screen.rerender(<ThreadDetailsRecap environmentId={environmentId} threadId={threadId} />);
    expect(screen.container.textContent).toBe("");
  });
});
