import { EnvironmentId } from "@t3tools/contracts";
import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../test/render";

const state = vi.hoisted(() => ({ route: null as unknown as Atom.Writable<unknown> }));

vi.mock(import("./state/session"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom: AtomApi } = await import("effect/reactivity");
  const route = AtomApi.make<unknown>(Option.none()).pipe(AtomApi.keepAlive);
  state.route = route;
  const prepared = AtomApi.make((get) => get(route));
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      preparedConnectionValueAtom: () => prepared,
    } as never,
  };
});

import { appAtomRegistry } from "./rpc/atomRegistry";
import { useDeviceLocalEditorPreference } from "./remoteOpen";

const environmentId = EnvironmentId.make("selected");

function Probe() {
  const preference = useDeviceLocalEditorPreference(environmentId);
  return <output>{preference.available ? "available" : "unavailable"}</output>;
}

// The client id is cached per page, so each failure mode gets its own file.
it("hides the opt-in when the desktop cannot provide a client id", async () => {
  using _bridge = stubGlobal("desktopBridge", {
    getEditorClientId: () => {
      throw new Error("sendSync failed");
    },
    openLocalEditor: async () => ({ ok: true }),
  });
  await using screen = await render(<Probe />);
  await act(async () =>
    appAtomRegistry.set(
      state.route,
      Option.some({
        target: new BearerConnectionTarget({
          environmentId,
          label: "VM",
          connectionId: "saved-vm-tunnel",
        }),
      }),
    ),
  );
  await expect.element(page.getByText("unavailable")).toBeVisible();
  expect(screen.container.textContent).toBe("unavailable");
});
