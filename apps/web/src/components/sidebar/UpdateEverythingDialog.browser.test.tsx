import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import type { UpdatePickerDevice, UpdatePickerItem } from "./updateEverything.logic";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";

const threads = vi.hoisted(() => ({ running: {} as Record<string, number> }));
vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      environmentThreadsAtom: Atom.family((id: string) =>
        Atom.make(() =>
          Array.from({ length: threads.running[id] ?? 0 }, () => ({ status: "running" })),
        ),
      ),
    },
  } as never;
});

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function item(key: string, overrides: Partial<UpdatePickerItem> = {}): UpdatePickerItem {
  return {
    key,
    kind: "provider",
    label: key,
    context: null,
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    note: null,
    disabledReason: null,
    restarts: [],
    ...overrides,
  };
}

const app = item("app", {
  kind: "app",
  label: "T3 Code",
  restarts: [{ environmentId: local, continuesThreads: false }],
});

function devices(extraRemote: UpdatePickerItem[] = []): UpdatePickerDevice[] {
  return [
    {
      id: "this-device",
      label: "MacBook",
      unavailableReason: null,
      items: [app, item("claude", { label: "Claude" })],
    },
    {
      id: remote,
      label: "Studio",
      unavailableReason: null,
      items: [
        item("server", {
          kind: "server",
          label: "T3 Code",
          toVersion: null,
          note: "Uses that device's update feed",
          restarts: [{ environmentId: remote, continuesThreads: false }],
        }),
        item("codex", { label: "Codex" }),
        ...extraRemote,
      ],
    },
  ];
}

function setup(running: Record<string, number> = {}) {
  threads.running = running;
  const registry = AtomRegistry.make();
  const onConfirm = vi.fn();
  const dialog = (list: UpdatePickerDevice[]) => (
    <RegistryContext.Provider value={registry}>
      <UpdateEverythingDialog open onOpenChange={() => {}} devices={list} onConfirm={onConfirm} />
    </RegistryContext.Provider>
  );
  return { dialog, onConfirm, [Symbol.dispose]: () => registry.dispose() };
}

const expand = (device: string) =>
  userEvent.click(page.getByRole("button", { name: `${device} updates` }));
const confirmed = (onConfirm: ReturnType<typeof vi.fn>) =>
  [...(onConfirm.mock.calls[0]![0] as ReadonlySet<string>)].toSorted();

const checkbox = (name: string | RegExp) => page.getByRole("checkbox", { name, exact: true });
const update = () => page.getByRole("button", { name: "Update", exact: true });
const press = (locator: Locator) => act(() => (locator.element() as HTMLElement).click());

it("confirms only the items left selected, skipping T3 while keeping its tools", async () => {
  using test = setup();
  await using _screen = await render(test.dialog(devices()));

  await expand("MacBook");
  await userEvent.click(page.getByRole("region", { name: "MacBook" }).getByText("T3 Code"));
  await expect.element(page.getByText("Devices update first, then their tools.")).toBeVisible();
  await press(update());

  expect(confirmed(test.onConfirm)).toEqual(["claude", "codex", "server"]);
});

it("shows a device as mixed and toggles all of its items from the header", async () => {
  using test = setup();
  await using _screen = await render(test.dialog(devices()));
  const studio = page.getByRole("region", { name: "Studio" });

  await expand("Studio");
  await userEvent.click(studio.getByText("Codex"));
  await expect.element(checkbox("Studio1 of 2")).toHaveAttribute("aria-checked", "mixed");
  await expect.element(checkbox("All3 of 4")).toHaveAttribute("aria-checked", "mixed");

  await userEvent.click(checkbox("Studio1 of 2"));
  await expect.element(checkbox("Studio2 of 2")).toBeChecked();

  await userEvent.click(checkbox("Studio2 of 2"));
  await press(update());
  expect(confirmed(test.onConfirm)).toEqual(["app", "claude"]);
});

it("disables Update and confirms nothing when everything is cleared", async () => {
  using test = setup();
  await using _screen = await render(test.dialog(devices()));

  await press(checkbox("All4 of 4"));
  await expect.element(update()).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(test.onConfirm).not.toHaveBeenCalled();
});

it("keeps cleared choices and leaves new items unchecked when the catalog changes", async () => {
  using test = setup();
  await using screen = await render(test.dialog(devices()));

  await expand("MacBook");
  await userEvent.click(page.getByRole("region", { name: "MacBook" }).getByText("Claude"));
  await screen.rerender(test.dialog(devices([item("opencode", { label: "OpenCode" })])));
  await expand("Studio");

  await expect.element(page.getByRole("checkbox", { name: /OpenCode/ })).not.toBeChecked();
  await press(update());
  expect(confirmed(test.onConfirm)).toEqual(["app", "codex", "server"]);
});

it("shows why an item is unavailable and drops a selected item that became unavailable", async () => {
  using test = setup();
  await using screen = await render(test.dialog(devices()));

  const next = devices();
  next[1] = {
    ...next[1]!,
    items: next[1]!.items.map((entry) =>
      entry.key === "codex" ? { ...entry, disabledReason: "Already updating" } : entry,
    ),
  };
  await screen.rerender(test.dialog(next));
  await expand("Studio");

  const codex = page.getByRole("checkbox", { name: /Codex/ });
  await expect.element(codex).toBeDisabled();
  await expect.element(codex).toHaveAccessibleDescription("Already updating");
  await press(update());
  expect(confirmed(test.onConfirm)).toEqual(["app", "claude", "server"]);
});

it("warns about interrupted threads only for selected restarts", async () => {
  using test = setup({ [local]: 2, [remote]: 1 });
  await using _screen = await render(test.dialog(devices()));

  await expect.element(page.getByText("3 running threads will be interrupted.")).toBeVisible();
  await expand("MacBook");
  await expand("Studio");
  await userEvent.click(page.getByRole("region", { name: "MacBook" }).getByText("T3 Code"));
  await expect.element(page.getByText("1 running thread will be interrupted.")).toBeVisible();
  await userEvent.click(page.getByRole("region", { name: "Studio" }).getByText("T3 Code"));
  await expect.element(page.getByRole("note")).not.toBeInTheDocument();
});

it("toggles a collapsed device from its checkbox without expanding it", async () => {
  using test = setup();
  await using _screen = await render(test.dialog(devices()));

  await userEvent.click(checkbox("Studio2 of 2"));
  await expect.element(checkbox("Studio0 of 2")).not.toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: /Codex/ })).not.toBeInTheDocument();

  await expand("Studio");
  await expect.element(page.getByRole("checkbox", { name: /Codex/ })).not.toBeChecked();
  await press(update());
  expect(confirmed(test.onConfirm)).toEqual(["app", "claude"]);
});

it("offers resume control without running threads and skips T3 updates that cannot honor off", async () => {
  using test = setup();
  const list = devices();
  list[0] = { ...list[0]!, items: [{ ...app, canDisableAutoResume: true }, list[0]!.items[1]!] };
  await using _screen = await render(test.dialog(list));
  const resume = checkbox(/^Resume interrupted threads/);
  const studioT3 = page
    .getByRole("region", { name: "Studio" })
    .getByRole("checkbox", { name: /T3 Code/ });

  await expand("Studio");
  await expect.element(resume).toBeChecked();
  await expect.element(page.getByRole("note")).not.toBeInTheDocument();

  await press(resume);
  await expect.element(studioT3).toBeDisabled();
  await expect
    .element(studioT3)
    .toHaveAccessibleDescription("Cannot turn off thread resume on this version");
  await expect
    .element(resume)
    .toHaveAccessibleDescription("Skips 1 T3 Code update that can't turn this off.");

  await press(resume);
  await expect.element(studioT3).toBeChecked();

  await press(resume);
  await press(update());
  expect(confirmed(test.onConfirm)).toEqual(["app", "claude", "codex"]);
  expect(test.onConfirm.mock.calls[0]![1]).toBe(false);
});
