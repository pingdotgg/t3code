import "~/index.css";
import { EnvironmentId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const linkMenu = vi.hoisted(() => ({ show: vi.fn(), openExternal: vi.fn(), copy: vi.fn() }));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: linkMenu.show },
      shell: { openExternal: linkMenu.openExternal },
    }) as never,
}));

function setupLinkMenu() {
  linkMenu.show.mockReset().mockResolvedValue(null);
  linkMenu.openExternal.mockReset().mockResolvedValue(undefined);
  linkMenu.copy.mockReset().mockResolvedValue(undefined);
  return vi.spyOn(navigator.clipboard, "writeText").mockImplementation(linkMenu.copy);
}

function rightClick(element: Element): boolean {
  return element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
  );
}
import type { OrbitCreateRowId } from "@t3tools/client-runtime/orbit-gateway";
import type { OrbitSetupView, OrbitSetupViewStage } from "~/orbit/orbitSetupView";
import { OrbitReadyRow, OrbitSetupCard, OrbitThreadSetupRow } from "./OrbitSetupCard";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "t3/feature",
    baseRef: "main",
    worktreePath: "/repo/.t3/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const card = (value: WorktreeSetupSnapshot) => (
  <WorktreeSetupCard snapshot={value} onCancel={null} onWorkLocally={null} onOpenTerminal={null} />
);

it("ticks the running stage while finished stages keep their duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(card(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files12s");
});

it("stops a stage interrupted by the setup ending at the setup's end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files2s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Check out files2s");
});

// Conn: the Orbit setup card shares this card's look and renders a client-built view.
const orbitStage = (
  id: "create" | "connect" | "agent",
  label: string,
  status: "pending" | "running" | "done" | "failed",
  extra: { detail?: string; rows?: OrbitSetupViewStage["rows"] } = {},
) => ({
  id,
  label,
  status,
  detail: extra.detail ?? null,
  rows: extra.rows ?? null,
});

const orbitRow = (
  id: OrbitCreateRowId,
  label: string,
  status: "pending" | "running" | "done" | "failed",
) => ({
  id,
  label,
  status,
  detail: id === "address" ? "meetup.nckrtl.test" : null,
});

function orbitCard(
  view: Partial<OrbitSetupView>,
  actions = {
    retry: vi.fn(),
    name: vi.fn(),
    branch: vi.fn(),
    open: vi.fn(),
    dismiss: vi.fn(),
    cancel: vi.fn(),
  },
) {
  const value: OrbitSetupView = {
    phase: "running",
    stages: [
      orbitStage("create", "Create Instance", "running", {
        detail: "beast",
        rows: [
          orbitRow("container", "Copy the container", "done"),
          orbitRow("address", "Publish the address", "running"),
          orbitRow("t3", "Start the T3 server", "pending"),
          orbitRow("register", "Register with Orbit", "pending"),
        ],
      }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: null,
    errorDetailLine: null,
    canRetry: true,
    canChangeName: false,
    canChangeBranch: false,
    openInstance: null,
    instanceStays: false,
    details: {
      instanceName: "meetup",
      nodeName: "beast",
      branch: "meetup",
      baseBranch: null,
      url: "https://meetup.nckrtl.test",
    },
    cancelling: false,
    canCancel: true,
    ...view,
  };
  return {
    actions,
    element: (
      <OrbitSetupCard
        view={value}
        onRetry={actions.retry}
        onChangeName={actions.name}
        onChangeBranch={actions.branch}
        onOpenInstance={actions.open}
        onDismiss={actions.dismiss}
        onCancel={actions.cancel}
      />
    ),
  };
}

it("shows a running Orbit setup with the create rows, Details closed and Cancel", async () => {
  const card = orbitCard({});
  await using screen = await render(<div style={{ width: 640 }}>{card.element}</div>);
  const section = screen.getByRole("region", { name: "Instance setup" });
  expect(section.element().textContent).toContain("Create Instancebeast");
  const rows = screen.container.querySelectorAll("[data-orbit-create-row]");
  expect([...rows].map((row) => row.getAttribute("data-orbit-create-status"))).toEqual([
    "done",
    "running",
    "pending",
    "pending",
  ]);
  await expect.element(screen.getByText("Copy the container")).toBeVisible();
  // No timings anywhere; the address row shows the address, dimmed, before its icon.
  expect(section.element().textContent).not.toMatch(/\d+(ms|s)\b/);
  expect(section.element().textContent).toContain("Publish the addressmeetup.nckrtl.test");
  // Every status icon sits at the right end of its row.
  for (const row of section
    .element()
    .querySelectorAll<HTMLElement>("[data-orbit-create-row], [data-orbit-setup-stage]")) {
    const icon = row.querySelector<HTMLElement>("[data-orbit-row-icon]")!;
    expect(row.getBoundingClientRect().right - icon.getBoundingClientRect().right).toBeLessThan(4);
  }
  expect(section.element().textContent).not.toContain("Instance setup failed");
  expect(screen.getByRole("button", { name: "Retry" }).query()).toBeNull();

  const details = screen.getByRole("button", { name: "Details" });
  await expect.element(details).toHaveAttribute("aria-expanded", "false");
  expect(screen.container.querySelector("[data-orbit-setup-details]")).toBeNull();
  await details.click();
  await expect.element(screen.getByText("https://meetup.nckrtl.test")).toBeVisible();

  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(card.actions.cancel).toHaveBeenCalledOnce();
});

it("in the thread, follows the completion: no Cancel while it runs, Retry and Dismiss when it failed", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const readyView = {
    instanceName: "meetup",
    nodeName: "beast",
    url: null,
    readyLine: "Your Instance is ready.",
    modelFallbackLine: null,
    branch: null,
    baseBranch: null,
    dependenciesLine: null,
  };
  const completionRows = (address: "running" | "failed") => [
    orbitRow("container", "Copy the container", "done"),
    orbitRow("address", "Publish the address", address),
    orbitRow("t3", "Start the T3 server", "done"),
    orbitRow("register", "Register with Orbit", "done"),
  ];
  const doneStages = (address: "running" | "failed") => [
    orbitStage("create", "Create Instance", address, {
      detail: "beast",
      rows: completionRows(address),
    }),
    orbitStage("connect", "Connect", "done"),
    orbitStage("agent", "Start agent", "done"),
  ];
  const running = orbitCard({ stages: doneStages("running"), canCancel: false });
  const retry = vi.fn();
  const dismiss = vi.fn();
  await using screen = await render(
    <OrbitThreadSetupRow
      ready={{
        view: readyView,
        threadRef,
        messageId: "m1",
        setup: (running.element.props as { view: OrbitSetupView }).view,
      }}
    />,
  );
  await expect.element(screen.getByText("Publish the address")).toBeVisible();
  expect(screen.getByText("Copy the workspace").query()).toBeNull();
  // In the thread the card only follows the address: no Details, no Cancel (storyboard 6).
  expect(screen.getByRole("button", { name: "Cancel" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Details" }).query()).toBeNull();
  expect(screen.getByText("Instance ready").query()).toBeNull();

  const failed = orbitCard({
    phase: "failed",
    stages: doneStages("failed"),
    canCancel: false,
    canRetry: true,
    instanceStays: true,
    errorDetailLine: "instance.create_route_failed · dns",
  });
  await screen.rerender(
    <OrbitThreadSetupRow
      ready={{
        view: readyView,
        threadRef,
        messageId: "m1",
        setup: (failed.element.props as { view: OrbitSetupView }).view,
        onRetry: retry,
        onDismiss: dismiss,
      }}
    />,
  );
  await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
  const statuses = [...screen.container.querySelectorAll("[data-orbit-create-row]")].map(
    (row) =>
      `${row.getAttribute("data-orbit-create-row")}:${row.getAttribute("data-orbit-create-status")}`,
  );
  expect(statuses).toContain("address:failed");
  expect(screen.getByRole("button", { name: "Change name" }).query()).toBeNull();
  await screen.getByRole("button", { name: "Retry" }).click();
  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(retry).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();

  await screen.rerender(
    <OrbitThreadSetupRow ready={{ view: readyView, threadRef, messageId: "m1", setup: null }} />,
  );
  await expect.element(screen.getByText("Instance ready")).toBeVisible();
});

it("folds the create rows once the stage is done", async () => {
  await using screen = await render(
    orbitCard({
      stages: [
        orbitStage("create", "Create Instance", "done", { detail: "beast" }),
        orbitStage("connect", "Connect", "running"),
        orbitStage("agent", "Start agent", "pending"),
      ],
    }).element,
  );
  await expect.element(screen.getByText("Connect")).toBeVisible();
  expect(screen.container.querySelector("[data-orbit-create-row]")).toBeNull();
});

it("shows a done Orbit setup with every stage checked", async () => {
  const done = orbitCard({
    phase: "done",
    stages: [
      orbitStage("create", "Create Instance", "done", { detail: "beast" }),
      orbitStage("connect", "Connect", "done"),
      orbitStage("agent", "Start agent", "done"),
    ],
  });
  await using screen = await render(done.element);
  const rows = screen.container.querySelectorAll('[data-orbit-setup-status="done"]');
  expect(rows).toHaveLength(3);
});

it("offers Retry, Change name and Dismiss on a taken name, without the Instance line", async () => {
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "failed", { detail: "beast" }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: "The name pricing-page is taken in create-bench.",
    canChangeName: true,
  });
  await using screen = await render(failed.element);
  await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
  await expect
    .element(screen.getByText("The name pricing-page is taken in create-bench."))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("The Instance stays");
  await screen.getByRole("button", { name: "Retry" }).click();
  await screen.getByRole("button", { name: "Change name" }).click();
  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(failed.actions.retry).toHaveBeenCalledOnce();
  expect(failed.actions.name).toHaveBeenCalledOnce();
  expect(failed.actions.dismiss).toHaveBeenCalledOnce();
});

it("says the Instance stays after a created Instance and offers no Change name", async () => {
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "done", { detail: "beast" }),
      orbitStage("connect", "Connect", "failed"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: "Orbit could not pair with the clone (conn.server_unreachable).",
    instanceStays: true,
  });
  await using screen = await render(failed.element);
  await expect.element(screen.getByText("The Instance stays; remove it in Orbit.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Change name" }).query()).toBeNull();
  expect(screen.container.textContent).not.toMatch(/Discard|Destroy|Remove instance/i);
});

it("shows a failed clone's text and Orbit's detail line, truncated on one line", async () => {
  const detail = `instance.create_clone_failed · Argument list too long${" /srv/x".repeat(40)}`;
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "failed", { detail: "beast" }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: "Orbit could not create pricing-page: the clone operation failed on beast.",
    errorDetailLine: detail,
    instanceStays: true,
  });
  await using screen = await render(<div style={{ width: 480 }}>{failed.element}</div>);
  await expect
    .element(
      screen.getByText("Orbit could not create pricing-page: the clone operation failed on beast."),
    )
    .toBeVisible();
  const line = screen.container.querySelector<HTMLElement>("[data-orbit-setup-error-detail]")!;
  expect(line.textContent).toBe(detail);
  expect(line.hasAttribute("title")).toBe(false);
  expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
  expect(line.getBoundingClientRect().height).toBeLessThan(24);
});

it("offers only Dismiss when a Project process did not start, and names the process", async () => {
  const text =
    "A process of this Project did not start: conn-web.service. Fix the Project, remove this Instance in Orbit, then create it again.";
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "failed", { detail: "beast" }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: text,
    errorDetailLine: "instance.container_process_inactive · conn-web.service exited with status 1",
    canRetry: false,
  });
  await using screen = await render(<div style={{ width: 480 }}>{failed.element}</div>);
  await expect.element(screen.getByText(text)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" }).query()).toBeNull();
  expect(screen.container.textContent).not.toContain("The Instance stays");
  expect(screen.container.querySelector("[data-orbit-setup-error-detail]")?.textContent).toContain(
    "instance.container_process_inactive",
  );
});

it("offers Retry when Orbit retries a Project process with its current definitions", async () => {
  const text =
    "A process of this Project did not start: conn-web.service. Change or remove this process in the Project's Orbit settings, then retry.";
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "failed", { detail: "beast" }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: text,
    errorDetailLine: "instance.container_process_inactive · conn-web.service exited with status 1",
    canRetry: true,
  });
  await using screen = await render(<div style={{ width: 480 }}>{failed.element}</div>);
  await expect.element(screen.getByText(text)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
});

it("folds a finished Orbit start to Instance ready with Details open and Conn's ready line", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const view = {
    instanceName: "pricing-page",
    nodeName: "beast",
    url: "https://pricing-page.create-bench.test",
    readyLine: "",
    modelFallbackLine: "This Instance does not offer claude-opus-5-5, so the agent uses gpt-5.5.",
    branch: "feature/pricing",
    baseBranch: "develop",
    dependenciesLine: "Dependencies and build come from the default branch.",
  };
  await using screen = await render(<OrbitReadyRow view={view} threadRef={threadRef} />);
  await expect.element(screen.getByText("Instance ready")).toBeVisible();
  // No timing on the ready row (storyboard 7).
  expect(screen.container.querySelector("[data-orbit-setup-stage]")?.textContent).toBe(
    "Instance ready",
  );
  await expect
    .element(screen.getByRole("button", { name: "Details" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("pricing-page", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(view.modelFallbackLine)).toBeVisible();
  await expect.element(screen.getByText("develop", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(view.dependenciesLine)).toBeVisible();
  const line = screen.container.querySelector("[data-orbit-ready-line]");
  expect(line?.textContent).toBe(
    "Your Instance is ready. You can preview it at https://pricing-page.create-bench.test while I work on your request.",
  );
  await screen.getByRole("button", { name: "Details" }).click();
  expect(screen.getByText("Node").query()).toBeNull();
});

it("gives the ready line and Preview chip the chat link menu for the Instance address", async () => {
  using _clipboard = setupLinkMenu();
  const url = "https://meetup.dlf.test";
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const view = {
    instanceName: "meetup",
    nodeName: "beast",
    url,
    readyLine: "",
    modelFallbackLine: null,
    branch: null,
    baseBranch: null,
    dependenciesLine: null,
  };
  await using screen = await render(<OrbitReadyRow view={view} threadRef={threadRef} />);
  const lineLink = screen.container.querySelector<HTMLAnchorElement>("[data-orbit-ready-line] a")!;
  const chip = screen.container.querySelector<HTMLAnchorElement>(`dd a[href="${url}"]`)!;
  expect(lineLink.href).toBe(`${url}/`);
  expect(chip).not.toBeNull();

  linkMenu.show.mockResolvedValue("copy-link");
  // The native menu only offers Copy Link and text editing; the app's link menu replaces it.
  expect(await act(async () => rightClick(lineLink))).toBe(false);
  expect(linkMenu.show.mock.calls[0]?.[0].map((item: { id: string }) => item.id)).toContain(
    "open-external",
  );
  await vi.waitFor(() => expect(linkMenu.copy).toHaveBeenCalledWith(url));

  linkMenu.show.mockResolvedValue("open-external");
  expect(await act(async () => rightClick(chip))).toBe(false);
  await vi.waitFor(() => expect(linkMenu.openExternal).toHaveBeenCalledWith(url));
});
