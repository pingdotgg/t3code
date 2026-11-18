import { newOrbitThreadStart, type OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { useThreadShell } from "../state/entities";
import { OrbitPendingThreadView } from "./OrbitPendingThreadView";
import { readStored, updateStarts, useOrbitThreadStarts } from "./orbitThreadStartStore";

vi.mock("../state/entities", { spy: true });
const gateway = vi.hoisted(() => {
  const cancelOperation = vi.fn();
  return { cancelOperation, client: vi.fn(() => ({ cancelOperation })) };
});
vi.mock("./OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./OrbitProfileSync")>()),
  desktopOrbitGatewayClient: gateway.client,
}));

const start = (patch: Partial<OrbitThreadStart> = {}): OrbitThreadStart => ({
  ...newOrbitThreadStart({
    id: "s1",
    project: { id: 66, slug: "create-bench", nodeName: "beast" },
    message: "List the files in this folder",
    suffix: "x",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
    instanceName: "pricing-page",
    pendingThread: true,
  }),
  ...patch,
});

function setup(saved: OrbitThreadStart) {
  gateway.cancelOperation.mockReset();
  window.localStorage.clear();
  updateStarts(() => [saved]);
  vi.mocked(useThreadShell).mockReturnValue(null);
}

const bubbles = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-orbit-pending-message]")].map((node) => node.textContent);

const view = () => (
  <SidebarProvider>
    <OrbitPendingThreadView startId="s1" />
  </SidebarProvider>
);

describe("OrbitPendingThreadView", () => {
  it("shows the message and the setup card from the saved start, also after a reload", async () => {
    setup(start({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }));
    {
      await using screen = await render(view(), { router: "/orbit/s1" });
      await expect.element(screen.getByText("Create Instance")).toBeVisible();
      expect(bubbles(screen.container)).toEqual(["List the files in this folder"]);
    }
    // A reload reads the start from localStorage again.
    useOrbitThreadStarts.setState({ starts: readStored() });
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("Create Instance")).toBeVisible();
    expect(bubbles(screen.container)).toEqual(["List the files in this folder"]);
    expect(screen.container.querySelectorAll('[data-orbit-setup-status="running"]')).toHaveLength(
      1,
    );
  });

  it("shows the prompt box from the send, disabled: dimmed, not focusable, no text entry", async () => {
    setup(start({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }));
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("Create Instance")).toBeVisible();
    const box = screen.container.querySelector<HTMLElement>("[data-orbit-pending-composer]");
    expect(box).not.toBeNull();
    expect(box!.inert).toBe(true);
    expect(box!.textContent).toContain("Ask anything");
    expect(box!.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
  });

  it("replaces the route with the real thread once, when the clone's thread reached the window", async () => {
    const sent = start({
      environmentId: "env-41",
      instanceId: 41,
      connected: true,
      createStartedAt: 1,
      connectStartedAt: 2,
      sentAt: 3,
    });
    setup(sent);
    vi.mocked(useThreadShell).mockReturnValue({ id: "thread-1" } as never);
    await using screen = await render(view(), { router: "/orbit/s1" });
    const router = screen.router!;
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-41/thread-1"));
    expect(router.history.length).toBe(1);
    // The pending view never sends or adds a message; the real thread shows the one sent.
    expect(bubbles(screen.container)).toHaveLength(1);
  });

  it("Dismiss removes only the saved start, without a Gateway call", async () => {
    setup(
      start({
        createStartedAt: 1,
        instanceId: 41,
        error: "Orbit could not create the clone (instance.t3_unready).",
        errorCode: "instance.t3_unready",
      }),
    );
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("The Instance stays; remove it in Orbit.")).toBeVisible();
    gateway.client.mockClear();
    await screen.getByRole("button", { name: "Dismiss" }).click();
    expect(readStored()).toEqual([]);
    expect(gateway.client).not.toHaveBeenCalled();
  });

  it("Change name keeps the failed start when the draft cannot open", async () => {
    setup(
      start({
        createStartedAt: 1,
        error: "The name pricing-page is taken.",
        errorCode: "instance.name_taken",
      }),
    );
    await using screen = await render(view(), { router: "/orbit/s1" });
    // Tests are not the desktop app in Orbit mode, so the draft does not open.
    await screen.getByRole("button", { name: "Change name" }).click();
    await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
    expect(readStored()).toHaveLength(1);
  });

  it("Cancel stops Orbit's create, then drops the saved start", async () => {
    setup(
      start({
        createStartedAt: 1,
        createKey: "k",
        createOperationId: 100,
        instanceId: 41,
        createRows: {
          container: { status: "running", startedAt: 1, finishedAt: null },
          address: { status: "done", startedAt: 1, finishedAt: 2 },
        },
      }),
    );
    gateway.cancelOperation.mockResolvedValue({ id: 100, status: "running" });
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("Copy the container")).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
    expect(gateway.cancelOperation).toHaveBeenCalledWith(100);
  });

  it("Cancel after the create succeeded cancels its completion, before the thread opens", async () => {
    setup(
      start({
        createStartedAt: 1,
        createFinishedAt: 2,
        createKey: "k",
        createOperationId: 100,
        instanceId: 41,
        environmentId: "env-41",
        connectStartedAt: 3,
        completionOperationId: 101,
        completionStatus: "queued",
      }),
    );
    gateway.cancelOperation.mockResolvedValue({ id: 101, status: "running" });
    await using screen = await render(view(), { router: "/orbit/s1" });
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
    expect(gateway.cancelOperation.mock.calls).toEqual([[101]]);
  });

  it("Cancel before the create was sent only drops the saved start", async () => {
    setup(start({ createStartedAt: 1 }));
    await using screen = await render(view(), { router: "/orbit/s1" });
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
    expect(gateway.cancelOperation).not.toHaveBeenCalled();
  });
});
