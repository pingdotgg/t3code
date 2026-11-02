import type { ServerConfigStreamEvent } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: null as unknown as import("effect/reactivity").Atom.Writable<{
    readonly latestEvent: ServerConfigStreamEvent | null;
  }>,
  addToast: vi.fn<(toast: { readonly title?: unknown }) => void>(),
}));

// The event atom is derived from server state, as in production; nothing else reads it.
vi.mock(import("../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  mocks.state = Atom.make<{ readonly latestEvent: ServerConfigStreamEvent | null }>({
    latestEvent: null,
  });
  return {
    primaryServerConfigAtom: Atom.make(null),
    primaryServerConfigEventAtom: Atom.make((get) => get(mocks.state).latestEvent),
  } as never;
});
vi.mock(import("../state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) } as never;
});
vi.mock(
  import("./KeybindingsConfigWarning"),
  () => ({ KeybindingsConfigWarning: () => null }) as never,
);
vi.mock(
  import("./ui/toast"),
  () =>
    ({
      toastManager: { add: mocks.addToast },
      stackedThreadToast: (toast: unknown) => toast,
    }) as never,
);

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startKeybindingsUpdateToasts } from "./KeybindingsUpdateToast";

function keybindingsUpdated(issues: ReadonlyArray<unknown>): ServerConfigStreamEvent {
  return { type: "keybindingsUpdated", payload: { keybindings: [], issues } } as never;
}

describe("startKeybindingsUpdateToasts", () => {
  it("toasts reloads the server reports after start", () => {
    const stop = startKeybindingsUpdateToasts();
    try {
      appAtomRegistry.set(mocks.state, { latestEvent: keybindingsUpdated([]) });
      appAtomRegistry.set(mocks.state, {
        latestEvent: keybindingsUpdated([
          { kind: "keybindings.malformed-config", message: "Unexpected token" },
        ]),
      });

      expect(mocks.addToast.mock.calls.map(([toast]) => toast.title)).toEqual([
        "Keybindings updated",
        "Invalid keybindings configuration",
      ]);
    } finally {
      stop();
    }
  });
});
