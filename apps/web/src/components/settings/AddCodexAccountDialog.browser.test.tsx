import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry as registry } from "../../rpc/atomRegistry";

const setup = vi.hoisted(() => ({
  update: vi.fn(async () => ({ _tag: "Success" as const })),
}));

const providersAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => providersAtom.current) as never,
      updateSettings: setup.update as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({ providerInstances: {} })) as never,
}));

import { AddCodexAccountDialog } from "./AddCodexAccountDialog";

const environmentId = EnvironmentId.make("local");

function codexProvider(
  instanceId: ProviderInstanceId,
  auth: ServerProvider["auth"],
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    installed: true,
    enabled: true,
    version: "test-version",
    status: "ready",
    auth,
    checkedAt: "2026-09-02T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    setup: { canAuthenticate: true, canInstall: false },
  };
}

function createdInstanceId(): ProviderInstanceId {
  const [call] = setup.update.mock.calls as unknown as [
    [{ input: { patch: { providerInstances: Record<string, unknown> } } }],
  ];
  return ProviderInstanceId.make(Object.keys(call[0].input.patch.providerInstances)[0]!);
}

function Owner({ onClose }: { readonly onClose: () => void }) {
  const [shown, setShown] = useState(true);
  return shown ? (
    <AddCodexAccountDialog
      environmentId={environmentId}
      onClose={() => {
        onClose();
        setShown(false);
      }}
      renderSetup={() => <p>Sign in to ChatGPT</p>}
    />
  ) : null;
}

describe("AddCodexAccountDialog", () => {
  it("plays its close animation before the owner unmounts it once the account connects", async () => {
    const atom = Atom.make<ReadonlyArray<ServerProvider> | null>([]).pipe(Atom.keepAlive);
    providersAtom.current = atom;
    const onClose = vi.fn();
    // A long exit transition that the test finishes by hand, so the close is
    // observable mid-animation without waiting on real time.
    const style = document.createElement("style");
    style.textContent = `[data-slot="dialog-popup"] { transition: opacity 600s; }
      [data-slot="dialog-popup"][data-ending-style] { opacity: 0; }`;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Owner onClose={onClose} />
      </AppAtomRegistryProvider>,
    );

    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    const instanceId = createdInstanceId();
    await act(() => registry.set(atom, [codexProvider(instanceId, { status: "unauthenticated" })]));
    await expect.element(page.getByText("Sign in to ChatGPT")).toBeVisible();

    await act(() =>
      registry.set(atom, [
        codexProvider(instanceId, { status: "authenticated", subscriptionSharing: true }),
      ]),
    );
    // Closing the dialog starts its exit animation; unmounting now would cut it off.
    await vi.waitFor(() => expect(document.getAnimations()).not.toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();

    await act(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // onClose runs before the owner's unmount commits, so wait for the dialog to leave the DOM.
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
