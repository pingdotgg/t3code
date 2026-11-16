import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
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
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {}, readMenu: () => null }),
}));

import { render, stubGlobal } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function header(title: string, props: Partial<ComponentProps<typeof ChatHeader>> = {}) {
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
        onNewThreadInProject={() => {}}
        {...props}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
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

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it.each(["ltr", "rtl"] as const)(
  "keeps draft titles beside the project in %s",
  async (direction) => {
    const project = {
      id: ProjectId.make("project"),
      environmentId: EnvironmentId.make("environment"),
      title: "my-project",
      workspaceRoot: "/projects/my-project",
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    };
    const layout = (title: string) => (
      <div dir={direction} style={{ width: 800 }}>
        {header(title, { activeProject: project, isServerThread: false })}
      </div>
    );
    await using screen = await render(layout("New thread"));
    await vi.waitFor(() => {
      const projectBounds = screen.container
        .querySelector('[aria-label="New thread in my-project"]')!
        .getBoundingClientRect();
      const titleBounds = screen.container
        .querySelector('h2[aria-label="New thread"]')!
        .getBoundingClientRect();
      const gap =
        direction === "rtl"
          ? projectBounds.left - titleBounds.right
          : titleBounds.left - projectBounds.right;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(60);
    });

    const longTitle = "A very long draft title ".repeat(20);
    await screen.rerender(layout(longTitle));
    await vi.waitFor(() => {
      const title = screen.container.querySelector("h2[aria-label]")!;
      const text = title.querySelector<HTMLElement>('[data-slot="workspace-breadcrumb-text"]')!;
      const bounds = title.getBoundingClientRect();
      const breadcrumb = screen.container
        .querySelector('nav[aria-label="Thread breadcrumb"]')!
        .getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(breadcrumb.left);
      expect(bounds.right).toBeLessThanOrEqual(breadcrumb.right);
      expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    });
  },
);

it("keeps the Escape that cancels a rename from also reaching window shortcuts", async () => {
  persisted.title = "New thread";
  await using screen = await render(header(persisted.title));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await input.fill("Unsaved title");

  // The thread find bar closes from a window keydown listener that skips handled events.
  const windowEscapes: boolean[] = [];
  const recordEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") windowEscapes.push(event.defaultPrevented);
  };
  window.addEventListener("keydown", recordEscape);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", recordEscape),
  };
  await userEvent.keyboard("{Escape}");

  await expect.element(input).not.toBeInTheDocument();
  expect(persisted.title).toBe("New thread");
  expect(windowEscapes).toEqual([true]);
});
