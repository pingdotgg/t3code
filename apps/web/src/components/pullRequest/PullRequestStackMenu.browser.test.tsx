import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ detail: "" }));

vi.mock(import("~/state/use-atom-command"), async () => {
  const { PullRequestOperationError } = await import("@t3tools/contracts");
  const { Cause } = await import("effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (() => async () =>
      AsyncResult.failure(
        Cause.fail(new PullRequestOperationError({ operation: "runAction", detail: state.detail })),
      )) as never,
  };
});

import "~/index.css";
import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { PullRequestStackMenu } from "./PullRequestStackMenu";

function setup(detail: string) {
  state.detail = detail;
}

const HEAD_MOVED = "The stack head moved. Refresh the stack before trying again.";

it.each([
  { label: "Merge stack", detail: HEAD_MOVED, description: HEAD_MOVED },
  { label: "Rebase stack", detail: HEAD_MOVED, description: HEAD_MOVED },
  {
    label: "Rebase stack",
    detail: "GitHub CLI command failed.",
    description:
      "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.",
  },
])("$label refused with $detail shows $description", async (row) => {
  setup(row.detail);
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
        terminology={sourceControlClients.get("github").changeRequest}
        stack={{
          id: "stack",
          number: 1,
          url: "https://github.com/owner/repository/stack/1",
          base: "main",
          layers: [{ number: 2, headBranch: "feature", headSha: "abc123", state: "open" }],
        }}
        canMerge
        stale={false}
        canRebase
        mergeMethod="squash"
        onActed={() => {}}
      />
    </ToastProvider>,
  );
  if (row.label === "Rebase stack") {
    await screen.getByRole("button", { name: "Stack 1, layer 1 of 1" }).click();
    await page.getByRole("menuitem", { name: row.label }).click();
  } else {
    await screen.getByRole("button", { name: row.label, exact: true }).click();
  }
  await page.getByRole("dialog").getByRole("button", { name: row.label, exact: true }).click();
  await expect.element(page.getByText(row.description, { exact: true })).toBeInTheDocument();
});

it("does not offer Merge stack through a queued layer", async () => {
  setup("");
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
        terminology={sourceControlClients.get("github").changeRequest}
        stack={{
          id: "stack",
          number: 1,
          url: "https://github.com/owner/repository/stack/1",
          base: "main",
          layers: [
            {
              number: 1,
              headBranch: "bottom",
              headSha: "abc123",
              state: "open",
              isInMergeQueue: true,
            },
            { number: 2, headBranch: "top", headSha: "def456", state: "open" },
          ],
        }}
        canMerge
        stale={false}
        canRebase
        mergeMethod="squash"
        onActed={() => {}}
      />
    </ToastProvider>,
  );
  await expect.element(screen.getByRole("button", { name: "Merge stack" })).toBeDisabled();
  await screen.getByRole("button", { name: "Stack 1, layer 2 of 2" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Merge stack (2)" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByText("A layer being merged is already in the merge queue."))
    .toBeInTheDocument();
});
