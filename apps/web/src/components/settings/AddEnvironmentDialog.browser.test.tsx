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
  saveSandboxProfile: vi.fn<() => Promise<AtomCommandResult<unknown, Error>>>(),
  testSandboxProfile: vi.fn(),
  refresh: () => {},
  /** The profiles list fetch result when the query is the profile list. */
  profilesData: null as null | undefined | { readonly profiles: ReadonlyArray<unknown> },
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectSshEnvironment: mocks.connectSshEnvironment as never,
}));
vi.mock(import("~/state/cloudSandboxProfiles"), () => ({
  sandboxProfilesList: ((input: unknown) => input) as never,
  sandboxProfilesSave: mocks.saveSandboxProfile as never,
  sandboxProfilesTest: mocks.testSandboxProfile as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    // Only the profiles query is a tagged input; host discovery expects its array.
    data: query !== null && typeof query === "object" && "input" in query ? mocks.profilesData : [],
    isPending: false,
    error: null,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
  usePrimaryEnvironmentId: (() => "environment-primary-1") as never,
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
  mocks.saveSandboxProfile.mockReset();
  mocks.testSandboxProfile.mockReset();
  mocks.testSandboxProfile.mockResolvedValue(AsyncResult.success({}));
  mocks.profilesData = null;
  return stubGlobal("desktopBridge", {});
}

const remoteCard = () => page.getByRole("radio", { name: /Remote/ });
const sshCard = () => page.getByRole("radio", { name: /^SSH/ });
const sandboxCard = () => page.getByRole("radio", { name: /boat\.dev/ });

async function openDialogOnSsh() {
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await userEvent.click(sshCard());
  await expect.element(sshCard()).toHaveAttribute("aria-checked", "true");
  await userEvent.click(page.getByRole("button", { name: "Next" }));
}

async function expectDefaultModeAfterReopen() {
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await expect.element(remoteCard()).toHaveAttribute("aria-checked", "true");
  await expect.element(sshCard()).toHaveAttribute("aria-checked", "false");
  await userEvent.click(page.getByRole("button", { name: "Next" }));
  await expect.element(page.getByPlaceholder("backend.example.com")).toBeInTheDocument();
}

/** Gets the boat wizard to its defaults step with a new key validated. */
async function reachSandboxDefaults() {
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await userEvent.click(sandboxCard());
  await userEvent.click(page.getByRole("button", { name: "Next" }));
  await userEvent.type(page.getByPlaceholder("boat_k3Xz9f…"), "boat_secret_key");
  await userEvent.click(page.getByRole("button", { name: "Next" }));
  await expect
    .element(page.getByRole("radio", { name: "Standard" }))
    .toHaveAttribute("aria-checked", "true");
}

describe("AddEnvironmentDialog", () => {
  it("reopens on Remote link after adding an SSH environment", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
    expect(mocks.connectSshEnvironment).toHaveBeenCalledOnce();

    await expectDefaultModeAfterReopen();
  });

  it("clears the form after dismissing it on SSH", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.type(page.getByPlaceholder("root"), "maria");
    await userEvent.type(page.getByPlaceholder("22"), "2222");

    await userEvent.click(page.getByRole("button", { name: "Back" }));
    await userEvent.click(remoteCard());
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await userEvent.type(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.type(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await userEvent.keyboard("{Escape}");

    await expectDefaultModeAfterReopen();
    await expect.element(page.getByPlaceholder("backend.example.com")).toHaveValue("");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");
    await userEvent.click(page.getByRole("button", { name: "Back" }));
    await userEvent.click(sshCard());
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await expect.element(page.getByPlaceholder("Search hosts or type devbox")).toHaveValue("");
    await expect.element(page.getByPlaceholder("root")).toHaveValue("");
    await expect.element(page.getByPlaceholder("22")).toHaveValue("");

    let finishConnection!: (result: AtomCommandResult<void, Error>) => void;
    const pending = new Promise<AtomCommandResult<void, Error>>((resolve) => {
      finishConnection = resolve;
    });
    mocks.connectSshEnvironment.mockImplementationOnce(() => pending);
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
    await userEvent.keyboard("{Escape}");
    await expectDefaultModeAfterReopen();
    finishConnection(AsyncResult.failure(Cause.fail(new Error("dismissed SSH attempt"))));
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Next" }))
      .toBeEnabled();
    await expect.element(page.getByText(/dismissed SSH attempt/)).not.toBeInTheDocument();
  });

  it("validates a candidate key without saving it until the wizard finishes", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    mocks.saveSandboxProfile.mockResolvedValue(
      AsyncResult.success({
        profile: {
          profileId: "boat-dev",
          name: "boat.dev",
          driverKind: "boat",
          apiKeySet: true,
          defaultSize: "large",
          autoStopMinutes: 120,
          template: null,
          monthlyBudgetUsd: 25,
          maxConcurrentSandboxes: 3,
        },
        spend: null,
      }),
    );

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.click(sandboxCard());
    await userEvent.click(page.getByRole("button", { name: "Next" }));

    // The access step takes only the API key; it blocks until one exists.
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await expect.element(page.getByText("boat.dev API key is required.")).toBeInTheDocument();

    await userEvent.type(page.getByPlaceholder("boat_k3Xz9f…"), "boat_secret_key");
    await userEvent.click(page.getByRole("button", { name: "Next" }));

    expect(mocks.saveSandboxProfile).not.toHaveBeenCalled();
    expect(mocks.testSandboxProfile).toHaveBeenCalledWith({
      environmentId: "environment-primary-1",
      input: { driverKind: "boat", apiKey: "boat_secret_key" },
    });
    await expect
      .element(page.getByRole("radio", { name: "Standard" }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Finish" }));
    expect(mocks.saveSandboxProfile).toHaveBeenCalledOnce();
    expect(mocks.saveSandboxProfile).toHaveBeenLastCalledWith({
      environmentId: "environment-primary-1",
      input: {
        profileId: "boat-dev",
        name: "boat.dev",
        driverKind: "boat",
        apiKey: "boat_secret_key",
        defaultSize: "default",
        autoStopMinutes: 60,
        template: null,
        monthlyBudgetUsd: null,
        maxConcurrentSandboxes: 3,
      },
    });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("clears a failed key check when the wizard goes back", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);
    mocks.testSandboxProfile.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Invalid Boat API key."))),
    );

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.click(sandboxCard());
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await userEvent.type(page.getByPlaceholder("boat_k3Xz9f…"), "boat_bad_key");
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await expect.element(page.getByText("Invalid Boat API key.")).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Back" }));
    await expect.element(sandboxCard()).toBeInTheDocument();
    await expect.element(page.getByText("Invalid Boat API key.")).not.toBeInTheDocument();
  });

  it("reuses a stored key and its saved defaults without re-saving the key", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    mocks.profilesData = {
      profiles: [
        {
          profile: {
            profileId: "boat-demo",
            name: "Boat demo",
            driverKind: "boat",
            apiKeySet: true,
            defaultSize: null,
            autoStopMinutes: 120,
            template: "project-template",
            monthlyBudgetUsd: 25,
            maxConcurrentSandboxes: 3,
          },
          spend: null,
        },
      ],
    };

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.click(sandboxCard());
    await userEvent.click(page.getByRole("button", { name: "Next" }));

    // A stored key carries the access step with the field empty.
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    expect(mocks.saveSandboxProfile).not.toHaveBeenCalled();
    expect(mocks.testSandboxProfile).toHaveBeenCalledOnce();

    await expect
      .element(page.getByRole("radio", { name: "Standard" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("combobox", { name: "Auto-stop window" }))
      .toHaveTextContent("2 hours");
    // The window is changeable from the step itself.
    await userEvent.click(page.getByRole("combobox", { name: "Auto-stop window" }));
    await userEvent.click(page.getByRole("option", { name: "4 hours" }));
    await expect
      .element(page.getByRole("combobox", { name: "Auto-stop window" }))
      .toHaveTextContent("4 hours");

    mocks.saveSandboxProfile.mockResolvedValue(
      AsyncResult.success({
        profile: {
          profileId: "boat-demo",
          name: "Boat demo",
          driverKind: "boat",
          apiKeySet: true,
          defaultSize: "default",
          autoStopMinutes: 120,
          template: "project-template",
          monthlyBudgetUsd: 25,
          maxConcurrentSandboxes: 3,
        },
        spend: null,
      }),
    );

    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Finish" }));
    expect(mocks.saveSandboxProfile).toHaveBeenCalledTimes(1);
    expect(mocks.saveSandboxProfile).toHaveBeenCalledWith({
      environmentId: "environment-primary-1",
      input: {
        profileId: "boat-demo",
        name: "Boat demo",
        driverKind: "boat",
        defaultSize: "default",
        autoStopMinutes: 240,
        template: "project-template",
        monthlyBudgetUsd: 25,
        maxConcurrentSandboxes: 3,
      },
    });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves the budget, concurrency cap and template entered on the defaults step", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    mocks.saveSandboxProfile.mockResolvedValue(
      AsyncResult.success({
        profile: {
          profileId: "boat-dev",
          name: "boat.dev",
          driverKind: "boat",
          apiKeySet: true,
          defaultSize: "default",
          autoStopMinutes: 60,
          template: "project-template",
          monthlyBudgetUsd: 25.5,
          maxConcurrentSandboxes: 5,
        },
        spend: null,
      }),
    );

    await reachSandboxDefaults();
    await userEvent.type(page.getByLabelText("Monthly budget"), "25.5");
    await userEvent.clear(page.getByLabelText("Concurrent sandboxes"));
    await userEvent.type(page.getByLabelText("Concurrent sandboxes"), "5");
    await userEvent.type(page.getByLabelText("Template snapshot"), "project-template");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Finish" }));

    expect(mocks.saveSandboxProfile).toHaveBeenCalledOnce();
    expect(mocks.saveSandboxProfile).toHaveBeenLastCalledWith({
      environmentId: "environment-primary-1",
      input: {
        profileId: "boat-dev",
        name: "boat.dev",
        driverKind: "boat",
        apiKey: "boat_secret_key",
        defaultSize: "default",
        autoStopMinutes: 60,
        template: "project-template",
        monthlyBudgetUsd: 25.5,
        maxConcurrentSandboxes: 5,
      },
    });
  });

  it("blocks save while the monthly budget is not a positive amount", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await reachSandboxDefaults();
    await userEvent.type(page.getByLabelText("Monthly budget"), "abc");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Finish" }));

    await expect
      .element(
        page.getByText("Monthly budget must be a dollar amount above 0, or blank for no limit."),
      )
      .toBeInTheDocument();
    expect(mocks.saveSandboxProfile).not.toHaveBeenCalled();
  });
});
