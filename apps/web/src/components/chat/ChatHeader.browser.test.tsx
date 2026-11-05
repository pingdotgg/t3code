import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import { render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function setup() {
  persisted.title = "New thread";
}

function header(title: string, onNewThreadInProject = () => {}) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={onNewThreadInProject}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    setup();
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Switch thread, current: New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen
      .getByRole("button", { name: "Switch thread, current: Fix login redirect" })
      .dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread switcher and starts a new thread", async () => {
  setup();
  const onNewThreadInProject = vi.fn();
  await using screen = await render(header(persisted.title, onNewThreadInProject));

  await screen.getByRole("button", { name: "Switch thread, current: New thread" }).click();
  await expect.element(page.getByRole("textbox", { name: "Search threads" })).toBeVisible();
  const newThread = page.getByRole("menuitem", { name: "New thread", exact: true });
  await expect.element(newThread).toBeVisible();
  await newThread.click();
  expect(onNewThreadInProject).toHaveBeenCalledOnce();
});
