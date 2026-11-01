import { act, render as renderScreen, stubGlobal, type Screen } from "../../../test/render";
import { type ReactElement } from "react";
import { EnvironmentId, type PluginInstallation, PluginInstallationId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
const add = vi.hoisted(() => vi.fn());
const consent = vi.hoisted(() => vi.fn());
const enable = vi.hoisted(() => vi.fn());
vi.mock("../../state/plugins", () => ({
  pluginSettingsEnvironment: { values: vi.fn(), update: "update" },
  pluginEnvironment: {
    add: "add",
    consent: "consent",
    enable: "enable",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "consent" ? consent : command === "enable" ? enable : add,
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  const { Atom } = await import("effect/reactivity");
  const sessionStates = Atom.make([]);
  return {
    usePreparedConnection: (): ReturnType<
      typeof import("../../state/session").usePreparedConnection
    > => Option.none(),
    environmentSession: { sessionStateAtom: () => null },
    environmentSessionStatesAtom: () => sessionStates,
    useEnvironmentScope: () => true,
    useEnvironmentsWithScope: () => new Set(),
    readEnvironmentScope: () => true,
    useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
  };
});
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: true, refresh: vi.fn() }),
}));
import { AddPluginDialog, PluginReviewDialog } from "./PluginsSettings";
const environment = {
  environmentId: EnvironmentId.make("remote"),
  label: "Build box",
  entry: { target: { _tag: "RemoteConnectionTarget" } },
} as unknown as EnvironmentPresentation;
async function render(screen: Screen, element: ReactElement) {
  await act(async () => await screen.rerender(element));
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}
async function renderDialog(screen: Screen, canManage: boolean) {
  await render(
    screen,
    <AddPluginDialog
      environment={environment}
      canManage={canManage}
      status={null}
      notice={canManage ? null : "Managing plugins needs administrative access."}
      onClose={() => undefined}
      onAdded={() => undefined}
    />,
  );
}
/** Enters a directory through the input and submits through the live DOM. */
async function typeAndSubmit(
  screen: Screen,
  canManageAtSubmit: boolean,
  via: "keyboard" | "button",
) {
  await renderDialog(screen, true);
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      " /srv/plugins/notifier ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await renderDialog(screen, canManageAtSubmit);
  await act(async () => {
    if (via === "keyboard")
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    else button("Add and review").click();
  });
}
describe("AddPluginDialog", () => {
  it.each(["keyboard", "button"] as const)(
    "adds the typed directory by %s while management is allowed",
    async (via) => {
      using _setup = await setup();
      await using screen = await renderScreen(null, { router: false });
      await typeAndSubmit(screen, true, via);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({
        environmentId: environment.environmentId,
        input: { directory: "/srv/plugins/notifier" },
      });
    },
  );
  it.each(["keyboard", "button"] as const)(
    "sends nothing by %s once the open dialog loses management authority",
    async (via) => {
      using _setup = await setup();
      await using screen = await renderScreen(null, { router: false });
      await typeAndSubmit(screen, false, via);
      expect(add).not.toHaveBeenCalled();
    },
  );
});
describe("PluginReviewDialog", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;
  const DIGEST_B = `sha256:${"b".repeat(64)}`;
  const reviewed = (digest: string) =>
    ({
      installationId: PluginInstallationId.make("installation-1"),
      directory: "/srv/plugins/notifier",
      manifest: null,
      source: { digest, files: 3, bytes: 2048 },
      problem: null,
      consent: null,
      enabled: false,
    }) as unknown as PluginInstallation;
  const CHECKING = "Checking access…";
  const renderReview = (screen: Screen, installation: PluginInstallation, canManage = true) =>
    render(
      screen,
      <PluginReviewDialog
        environment={environment}
        detail={{ _tag: "found", installation }}
        canManage={canManage}
        status={canManage ? null : CHECKING}
        notice={null}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
  const success = { _tag: "Success", value: { installation: reviewed(DIGEST_A) } };
  /** Acknowledges the files on screen, approves, and holds the consent reply. */
  async function approveHoldingConsent(screen: Screen) {
    let release: (value: unknown) => void = () => undefined;
    consent.mockReset().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await renderReview(screen, reviewed(DIGEST_A));
    await act(async () => (document.querySelector("[role=checkbox]") as HTMLElement).click());
    await act(async () => button("Approve and enable").click());
    return (value: unknown) => release(value);
  }
  it("enables the reviewed files once consent succeeds", async () => {
    using _setup = await setup(success);
    await using screen = await renderScreen(null, { router: false });
    const release = await approveHoldingConsent(screen);
    await renderReview(screen, reviewed(DIGEST_A));
    await act(async () => release(success));
    expect(consent).toHaveBeenCalledWith({
      environmentId: environment.environmentId,
      input: { installationId: "installation-1", digest: DIGEST_A },
    });
    expect(enable).toHaveBeenCalledTimes(1);
  });
  it("never enables when the files change while consent is in flight", async () => {
    using _setup = await setup(success);
    await using screen = await renderScreen(null, { router: false });
    const release = await approveHoldingConsent(screen);
    // A snapshot reports new bytes for the same installation; access stays granted.
    await renderReview(screen, reviewed(DIGEST_B));
    await act(async () => release(success));
    expect(consent).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
  });
});

async function setup(success?: unknown) {
  const global0 = stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const global1 = stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
  add.mockReset().mockReturnValue(new Promise(() => undefined));
  enable.mockReset().mockResolvedValue(success);
  return {
    [Symbol.dispose]() {
      global1[Symbol.dispose]();
      global0[Symbol.dispose]();
    },
  };
}
