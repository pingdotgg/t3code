import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  connectSshEnvironment: vi.fn<() => Promise<AtomCommandResult<void, Error>>>(async () =>
    AsyncResult.success(undefined),
  ),
  refresh: () => {},
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectSshEnvironment: mocks.connectSshEnvironment as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: [],
    isPending: false,
    error: null,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make([]) as never,
}));

import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

function Owner() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AppAtomRegistryProvider>
      <AddEnvironmentDialog
        open={open}
        routeTarget={null}
        error={error}
        savedEnvironments={[]}
        onOpenChange={setOpen}
        onErrorChange={setError}
      />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.connectSshEnvironment.mockClear();
  return stubGlobal("desktopBridge", {});
}

const remoteCard = () => page.getByRole("button", { name: /Remote link/ });
const sshCard = () => page.getByRole("button", { name: /^SSH/ });

async function openDialogOnSsh() {
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await userEvent.click(sshCard());
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "true");
}

async function expectDefaultModeAfterReopen() {
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await expect.element(remoteCard()).toHaveAttribute("aria-pressed", "true");
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "false");
  await expect.element(page.getByPlaceholder("backend.example.com")).toBeInTheDocument();
}

describe("AddEnvironmentDialog", () => {
  it("reopens on Remote link after adding an SSH environment", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );
    expect(mocks.connectSshEnvironment).toHaveBeenCalledOnce();

    await expectDefaultModeAfterReopen();
  });

  it("clears the form after dismissing it on SSH", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.click(remoteCard());
    await userEvent.type(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.type(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await userEvent.click(sshCard());
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.type(page.getByPlaceholder("root"), "maria");
    await userEvent.type(page.getByPlaceholder("22"), "2222");
    await userEvent.keyboard("{Escape}");

    await expectDefaultModeAfterReopen();
    await expect.element(page.getByPlaceholder("backend.example.com")).toHaveValue("");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");
    await userEvent.click(sshCard());
    await expect.element(page.getByPlaceholder("Search hosts or type devbox")).toHaveValue("");
    await expect.element(page.getByPlaceholder("root")).toHaveValue("");
    await expect.element(page.getByPlaceholder("22")).toHaveValue("");

    let finishConnection!: (result: AtomCommandResult<void, Error>) => void;
    const pending = new Promise<AtomCommandResult<void, Error>>((resolve) => {
      finishConnection = resolve;
    });
    mocks.connectSshEnvironment.mockImplementationOnce(() => pending);
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );
    await userEvent.keyboard("{Escape}");
    await expectDefaultModeAfterReopen();
    finishConnection(AsyncResult.failure(Cause.fail(new Error("dismissed SSH attempt"))));
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Add environment" }))
      .toBeEnabled();
    await expect.element(page.getByText(/dismissed SSH attempt/)).not.toBeInTheDocument();
  });
});
