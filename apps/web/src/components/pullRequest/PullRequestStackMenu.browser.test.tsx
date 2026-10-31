import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ complete: null as (() => void) | null }));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { PullRequestOperationError } = await import("@t3tools/contracts");
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (() => () =>
      new Promise((resolve) => {
        state.complete = () =>
          resolve(
            AsyncResult.failure(
              Cause.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: "The stack head moved. Refresh the stack before trying again.",
                }),
              ),
            ),
          );
      })) as never,
  };
});

import "~/index.css";
import { act, render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { PullRequestStackMenu } from "./PullRequestStackMenu";

function setup() {
  state.complete = null;
}

it.each(["merge", "rebase"] as const)(
  "shows the host's stack %s refusal without error prefixes",
  async (action) => {
    setup();
    await using screen = await render(
      <ToastProvider>
        <PullRequestStackMenu
          environmentId={EnvironmentId.make("environment")}
          reference={{
            projectId: ProjectId.make("project"),
            repository: "owner/repository",
            number: 2,
          }}
          hostLabel="GitHub"
          stack={{
            id: "stack",
            number: 1,
            url: "https://github.com/owner/repository/stack/1",
            base: "main",
            layers: [{ number: 2, headBranch: "feature", headSha: "abc123", state: "open" }],
          }}
          canMerge
          canRebase
          mergeMethod="squash"
          onActed={() => {}}
        />
      </ToastProvider>,
    );
    if (action === "merge") {
      await screen.getByRole("button", { name: "Merge stack", exact: true }).click();
    } else {
      await screen.getByRole("button", { name: "Stack 1, layer 1 of 1" }).click();
      await page.getByRole("menuitem", { name: "Rebase stack" }).click();
    }
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: action === "merge" ? "Merge stack" : "Rebase stack",
        exact: true,
      })
      .click();
    await expect
      .element(
        page.getByText(action === "merge" ? "Merging stack..." : "Rebasing stack...", {
          exact: true,
        }),
      )
      .toBeInTheDocument();
    await act(() => state.complete?.());
    const description = page.getByText(
      /The stack head moved\. Refresh the stack before trying again\./,
    );
    await expect.element(description).toBeInTheDocument();
    expect(description.element().textContent).toBe(
      "The stack head moved. Refresh the stack before trying again.",
    );
  },
);
