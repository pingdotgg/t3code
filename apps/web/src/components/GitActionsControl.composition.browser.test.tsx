import {
  EnvironmentId,
  SourceControlProviderKind,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import type { RunVcsStackedActionInput } from "@t3tools/client-runtime/state/vcs";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { GitActionsControl } from "./GitActionsControl";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import { SharedTooltipProvider } from "./ui/shared-tooltip";

const publish = vi.hoisted(() => ({ run: vi.fn() }));
const commit = vi.hoisted(() => ({
  status: undefined as VcsStatusResult | undefined,
  run: vi.fn(),
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      ...commit.status,
      sources: [],
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: SourceControlProviderKind.make("github"),
          label: "GitHub",
          status: "available",
          version: Option.none(),
          installHint: "Install gh",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    },
  }),
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: commit.run }),
  useSourceControlActionRunning: vi.fn(),
  useVcsInitAction: vi.fn(),
  useVcsPullAction: vi.fn(),
  useSourceControlPublishRepositoryAction: () => ({
    isAllowed: true,
    isPending: false,
    run: publish.run,
  }),
}));

function setup() {
  commit.status = undefined;
  publish.run.mockReset();
  publish.run.mockReturnValue(new Promise(() => {}));
}

it("keeps composition Enter in the repository path from publishing", async () => {
  setup();
  await using _screen = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={null}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
    />,
  );
  // The redesigned dialog asks for the owner and the name on one page.
  await page.getByPlaceholder("owner").fill("octo");
  const path = page.getByRole("textbox", { name: "Repository" });
  await path.fill("repo");

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => path.element().dispatchEvent(event));
    expect(publish.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  }

  await userEvent.keyboard("{Enter}");
  expect(publish.run).toHaveBeenCalledOnce();
});

it("keeps edits to a retry selection when branch status arrives after the failure", async () => {
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: ["include.txt", "later.txt", "also-later.txt"].map((path) => ({
        path,
        insertions: 1,
        deletions: 0,
      })),
      insertions: 3,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  commit.status = status;
  commit.run.mockReset();
  commit.run.mockImplementation(async ({ actionId, onProgress }: RunVcsStackedActionInput) => {
    onProgress?.({
      actionId,
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit rejected",
      createdBranch: "feature/retry",
    });
    return AsyncResult.failure(Cause.fail(new Error("Commit rejected")));
  });
  const ui = () => (
    <GitActionsControl
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
      target={{ key: "repo", cwd: "/repo", name: "Repo" }}
      showChanges={false}
    />
  );
  await using screen = await render(ui());
  const openCommit = async () => {
    await page.getByRole("button", { name: "Git action options" }).click();
    // The menu item shows how many files it commits.
    await page.getByRole("menuitem", { name: /^Commit\d/ }).click();
  };
  await openCommit();
  await page.getByRole("checkbox", { name: "Include later.txt", exact: true }).click();
  await page.getByRole("combobox", { name: "Branch" }).click();
  await page.getByRole("option", { name: /^New branch/ }).click();
  await act(() => {
    page
      .getByRole("button", { name: /^Commit on new branch/ })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(commit.run).toHaveBeenCalledOnce();

  await openCommit();
  await page.getByRole("checkbox", { name: "Include also-later.txt" }).click();
  commit.status = { ...status, refName: "feature/retry", isDefaultRef: false };
  await screen.rerender(ui());

  await expect
    .element(page.getByRole("checkbox", { name: "Include later.txt", exact: true }))
    .not.toBeChecked();
  await expect
    .element(page.getByRole("checkbox", { name: "Include also-later.txt" }))
    .not.toBeChecked();
});

it("shows one tooltip at a time on the panel Changes row across label hover, row hover, and focus", async () => {
  setup();
  commit.status = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/app.ts", insertions: 12, deletions: 3 }],
      insertions: 12,
      deletions: 3,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  await using _screen = await render(
    <SharedTooltipProvider>
      <div className="p-16">
        <GitActionsControl
          threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
          target={{ key: "repo", cwd: "/repo", name: "Repo" }}
          displayMode="panel"
          showActions={false}
          showChanges
          onOpenChanges={() => {}}
        />
        <button type="button">Outside</button>
      </div>
    </SharedTooltipProvider>,
  );

  const label = page.getByText("Uncommitted");
  const count = page.getByText("+12");
  const outside = page.getByRole("button", { name: "Outside" });

  await userEvent.hover(label);
  await vi.waitFor(() => {
    const popups = [...document.querySelectorAll('[data-slot="tooltip-popup"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(popups).toEqual(["Uncommitted"]);
  });

  await userEvent.hover(count);
  await vi.waitFor(() => {
    const popups = [...document.querySelectorAll('[data-slot="tooltip-popup"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(popups).toHaveLength(1);
    expect(popups[0]).toContain("Code");
    expect(popups[0]).toContain("Total");
  });

  await userEvent.hover(outside);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[data-slot="tooltip-popup"]')).toHaveLength(0);
  });

  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => {
    const popups = [...document.querySelectorAll('[data-slot="tooltip-popup"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(popups).toHaveLength(1);
    expect(popups[0]).toContain("Total");
  });
});
