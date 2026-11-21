import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { PublishRepositoryDialog } from "./GitActionsControl";

const publish = vi.hoisted(() => ({ run: vi.fn() }));
const auth = vi.hoisted((): { account: string | null } => ({ account: null }));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
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
            account: Option.fromNullishOr(auth.account),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    },
  }),
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: vi.fn(),
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
  publish.run.mockReset();
  publish.run.mockReturnValue(new Promise(() => {}));
  auth.account = null;
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
  await page.getByRole("button", { name: "Next" }).click();
  const path = page.getByRole("textbox", { name: "Repository" });
  await path.fill("octo/repo");

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

it.each([
  { account: "my-app[bot]", expected: "" },
  { account: "octo", expected: "octo/" },
])("prefills the repository owner for $account with '$expected'", async ({ account, expected }) => {
  setup();
  auth.account = account;
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
  await page.getByRole("button", { name: "Next" }).click();

  await expect.element(page.getByRole("textbox", { name: "Repository" })).toHaveValue(expected);
});
