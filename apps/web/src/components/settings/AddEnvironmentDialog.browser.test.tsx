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
  connectPairing: vi.fn<
    (input: { readonly host: string }) => Promise<AtomCommandResult<void, Error>>
  >(async () => AsyncResult.success(undefined)),
  refresh: () => {},
  toastAdd: vi.fn(),
}));

vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: mocks.toastAdd } as never,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectSshEnvironment: mocks.connectSshEnvironment as never,
  connectPairing: mocks.connectPairing as never,
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

const devbox = { environmentId: "devbox", label: "Devbox", relayManaged: false } as never;

function Owner() {
  const [open, setOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<typeof devbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <AppAtomRegistryProvider>
      <button
        type="button"
        onClick={() => {
          setRouteTarget(devbox);
          setOpen(true);
        }}
      >
        Add a route to Devbox
      </button>
      <AddEnvironmentDialog
        open={open}
        routeTarget={routeTarget}
        error={error}
        savedEnvironments={[]}
        onOpenChange={(next) => {
          if (next) setRouteTarget(null);
          setOpen(next);
        }}
        onErrorChange={setError}
      />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.connectSshEnvironment.mockClear();
  mocks.connectPairing.mockClear();
  mocks.toastAdd.mockClear();
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
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }));
    expect(mocks.connectSshEnvironment).toHaveBeenCalledOnce();

    await expectDefaultModeAfterReopen();
  });

  it("drops an SSH error when switching to Remote link", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    mocks.connectSshEnvironment.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("ssh: connection refused"))),
    );
    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }));
    await expect.element(page.getByText(/connection refused/)).toBeInTheDocument();

    await userEvent.click(remoteCard());
    await expect.element(page.getByText(/connection refused/)).not.toBeInTheDocument();
  });

  it("clears the form after dismissing it on SSH", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.click(remoteCard());
    await userEvent.fill(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await userEvent.click(sshCard());
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.fill(page.getByPlaceholder("root"), "maria");
    await userEvent.fill(page.getByPlaceholder("22"), "2222");
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
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }));
    await userEvent.keyboard("{Escape}");
    await expectDefaultModeAfterReopen();
    // The spinner's "Loading" status is part of the button's accessible name.
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: /Connecting to devbox…$/ }))
      .toBeDisabled();
    await expect.element(page.getByText(/^Starting T3 Code on devbox/)).toBeInTheDocument();
    finishConnection(AsyncResult.failure(Cause.fail(new Error("dismissed SSH attempt"))));
    await expect
      .poll(() => mocks.toastAdd.mock.calls.at(-1)?.[0]?.description)
      .toContain("dismissed SSH attempt");
    await userEvent.fill(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }))
      .toBeEnabled();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  describe("a dismissed Remote link attempt", () => {
    function holdPairing() {
      let finish!: (result: AtomCommandResult<void, Error>) => void;
      const pending = new Promise<AtomCommandResult<void, Error>>((resolve) => {
        finish = resolve;
      });
      mocks.connectPairing.mockImplementationOnce(() => pending);
      // Resolves after the dialog's own continuation, which awaited the same promise first.
      return async (result: AtomCommandResult<void, Error>) => {
        finish(result);
        await pending;
      };
    }

    async function startPairingAndDismiss() {
      await userEvent.click(page.getByRole("button", { name: "Add environment" }));
      await userEvent.fill(page.getByPlaceholder("backend.example.com"), "slow.example.com");
      await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
      await userEvent.click(
        page.getByRole("dialog").getByRole("button", { name: "Connect & add" }),
      );
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    }

    it("keeps a failure that landed while closed out of the reopened form", async () => {
      using _bridge = setup();
      await using _screen = await render(<Owner />);
      const finish = holdPairing();

      await startPairingAndDismiss();
      await finish(AsyncResult.failure(Cause.fail(new Error("dismissed pairing timed out"))));
      await userEvent.click(page.getByRole("button", { name: "Add environment" }));

      await expect
        .element(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }))
        .toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    });

    it("reports its result in a toast, leaving the reopened form alone", async () => {
      using _bridge = setup();
      await using _screen = await render(<Owner />);
      const finish = holdPairing();

      await startPairingAndDismiss();
      await userEvent.click(page.getByRole("button", { name: "Add environment" }));
      await expect
        .element(page.getByRole("dialog").getByRole("button", { name: /Pairing with/ }))
        .toBeDisabled();
      await finish(AsyncResult.failure(Cause.fail(new Error("dismissed pairing timed out"))));

      expect(mocks.toastAdd).toHaveBeenLastCalledWith(
        expect.objectContaining({ description: "dismissed pairing timed out" }),
      );
      await expect
        .element(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }))
        .toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    });

    it("does not close the reopened dialog when it succeeds", async () => {
      using _bridge = setup();
      await using _screen = await render(<Owner />);
      const finish = holdPairing();

      await startPairingAndDismiss();
      await userEvent.click(page.getByRole("button", { name: "Add environment" }));
      await finish(AsyncResult.success(undefined));

      expect(mocks.toastAdd).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Backend added" }),
      );
      await expect
        .element(page.getByRole("dialog").getByRole("button", { name: "Connect & add" }))
        .toBeInTheDocument();
    });

    it("does not lock a dialog for another machine", async () => {
      using _bridge = setup();
      await using _screen = await render(<Owner />);
      const finish = holdPairing();

      await startPairingAndDismiss();
      await userEvent.click(page.getByRole("button", { name: "Add a route to Devbox" }));
      await expect.element(page.getByPlaceholder("backend.example.com")).toBeEnabled();
      await expect.element(page.getByText(/slow\.example\.com/)).not.toBeInTheDocument();
      await finish(AsyncResult.failure(Cause.fail(new Error("dismissed pairing timed out"))));
      await expect
        .element(page.getByRole("dialog").getByRole("button", { name: "Add route" }))
        .toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps showing its progress after another machine's attempt starts", async () => {
      using _bridge = setup();
      await using _screen = await render(<Owner />);
      const finishFirst = holdPairing();

      await startPairingAndDismiss();
      const finishRoute = holdPairing();
      await userEvent.click(page.getByRole("button", { name: "Add a route to Devbox" }));
      await userEvent.fill(page.getByPlaceholder("backend.example.com"), "route.example.com");
      await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
      await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Add route" }));
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await finishRoute(AsyncResult.failure(Cause.fail(new Error("route pairing timed out"))));

      await userEvent.click(page.getByRole("button", { name: "Add environment" }));
      await expect
        .element(
          page.getByRole("dialog").getByRole("button", { name: /Pairing with slow\.example\.com/ }),
        )
        .toBeDisabled();
      await finishFirst(AsyncResult.success(undefined));
    });
  });

  it("submits Remote link with Enter and explains a missing pairing code", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a pairing code.");
    expect(mocks.connectPairing).not.toHaveBeenCalled();

    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.connectPairing).toHaveBeenCalledOnce();
  });

  it("splits a typed pairing URL into host and code once the field loses focus", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    const host = page.getByPlaceholder("backend.example.com");
    await userEvent.type(host, "http://devbox.example.com/pair#token=ABC123");
    await expect.element(host).toHaveValue("http://devbox.example.com/pair#token=ABC123");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");

    await userEvent.keyboard("{Backspace}");
    await expect.element(host).toHaveValue("http://devbox.example.com/pair#token=ABC12");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");

    await userEvent.tab();
    await expect.element(host).toHaveValue("http://devbox.example.com");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("ABC12");
  });
});
