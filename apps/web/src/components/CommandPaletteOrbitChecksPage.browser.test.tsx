import type { OrbitGatewayProjectListing } from "@t3tools/client-runtime/orbit-gateway";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPalette";
import type { OrbitPaletteProjectsState } from "./CommandPalette.logic";

vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  useVisibleThreadShells: () => [],
}));

const orbit = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { status: "off" } as OrbitPaletteProjectsState,
    listeners,
    set(state: OrbitPaletteProjectsState) {
      this.state = state;
      for (const listener of listeners) listener();
    },
    recheck: vi.fn<() => Promise<boolean>>(),
  };
});
vi.mock("../orbit/orbitPaletteProjects", () => ({
  useOrbitPaletteProjects: () =>
    useSyncExternalStore(
      (listener) => {
        orbit.listeners.add(listener);
        return () => orbit.listeners.delete(listener);
      },
      () => orbit.state,
    ),
  useOrbitPairedEnvironmentIds: () => new Set<string>(),
  retryOrbitPaletteProjects: () => {},
  recheckOrbitPaletteProjects: () => orbit.recheck(),
  checkOrbitInstanceName: async () => ({ available: true }),
}));
vi.mock("../orbit/openOrbitDraft", () => ({ openOrbitDraft: async () => {} }));

function project(cloneable: boolean): OrbitGatewayProjectListing {
  const failing = !cloneable;
  return {
    id: 8,
    slug: "hauzer",
    name: "Hauzer",
    nodeId: 7,
    nodeName: "beast",
    instanceDomainSuffix: ".hauzer.test",
    cloneable,
    cloneableReason: failing ? "The default Instance does not run in a container." : null,
    checks: [
      {
        key: "default_instance",
        label: "Default instance",
        status: "pass",
        code: null,
        message: null,
      },
      failing
        ? {
            key: "container",
            label: "Container",
            status: "fail",
            code: "instance.default_missing",
            message: "Move the default Instance into a container in Orbit.",
          }
        : { key: "container", label: "Container", status: "pass", code: null, message: null },
      ...["active", "seed_snapshot", "node_access", "source_access"].map((key) => ({
        key,
        label: key,
        status: failing ? ("not_checked" as const) : ("pass" as const),
        code: null,
        message: null,
      })),
    ],
  };
}

function loaded(cloneable: boolean): OrbitPaletteProjectsState {
  return { status: "loaded", projects: [project(cloneable)], environments: [] };
}

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  orbit.state = loaded(false);
  orbit.recheck.mockReset();
}

describe("Orbit checks page", () => {
  it("opens from a greyed row, keeps the result when Check again fails, then offers the Instance step", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await page.getByRole("option", { name: /cannot start threads/ }).click();

    await expect.element(page.getByText("Runs in a container")).toBeVisible();
    await expect
      .element(page.getByText("Move the default Instance into a container in Orbit."))
      .toBeVisible();
    expect(page.getByText("Not checked yet").all()).toHaveLength(3);
    // A passing technical key adds no row.
    expect(page.getByText("source_access").all()).toHaveLength(0);

    let answer: (value: boolean) => void = () => {};
    orbit.recheck.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await page.getByRole("option", { name: /Check again/ }).click();
    await expect.element(page.getByText("Checking…")).toBeVisible();
    answer(false);
    await expect.element(page.getByText(/The Gateway did not answer/)).toBeVisible();
    await expect.element(page.getByText("Runs in a container")).toBeVisible();

    orbit.recheck.mockImplementation(async () => {
      orbit.set(loaded(true));
      return true;
    });
    await page.getByRole("option", { name: /Check again/ }).click();
    await expect.element(page.getByText("Threads can start in this project now.")).toBeVisible();
    await page.getByRole("option", { name: /Choose an Instance/ }).click();
    await expect.element(page.getByRole("textbox", { name: "Instance name" })).toBeVisible();
    expect(orbit.recheck).toHaveBeenCalledTimes(2);
  });
});
