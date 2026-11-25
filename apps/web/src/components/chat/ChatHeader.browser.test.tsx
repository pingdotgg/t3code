import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
const openExtension = vi.hoisted(() => vi.fn());
vi.mock("../ExtensionCommandHost", () => ({ openExtensionCommand: openExtension }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: () => ({ serverConfig: { environment: { capabilities: { extensions: true } } } }),
}));
vi.mock("../../state/extensions", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    extensionClientSurface: "web",
    extensionEnvironment: { state: () => ({}), invoke: { permissionAtom: () => allowed } },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: [
      {
        status: "running",
        manifest: {
          id: "test.extension",
          commands: [{ id: "status", title: "Run extension status" }],
          statusItems: [{ command: "status", text: "Run extension status" }],
        },
      },
    ],
  }),
}));
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

const project = {
  environmentId: EnvironmentId.make("environment"),
  id: ProjectId.make("project"),
  title: "Project",
  workspaceRoot: "/workspace/project",
  scripts: [],
  defaultModelSelection: null,
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
};

function header(
  title: string,
  {
    isServerThread = true,
    activeProject,
  }: { isServerThread?: boolean; activeProject?: typeof project } = {},
) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread={isServerThread}
        activeProject={activeProject ?? null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
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

it("omits the draft thread from extension actions until it is persisted", async () => {
  openExtension.mockClear();
  await using screen = await render(
    header("New thread", { isServerThread: false, activeProject: project }),
  );
  await screen.getByRole("button", { name: "Run extension status" }).click();
  expect(openExtension.mock.lastCall?.[0]).toMatchObject({
    environmentId: project.environmentId,
  });
  expect(openExtension.mock.lastCall?.[0].context).toEqual({
    surface: "web",
    projectId: project.id,
  });

  await screen.rerender(header("New thread", { activeProject: project }));
  await screen.getByRole("button", { name: "Run extension status" }).click();
  expect(openExtension.mock.lastCall?.[0].context).toEqual({
    surface: "web",
    projectId: project.id,
    threadId: ThreadId.make("thread"),
  });
});
