import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../test/render";
import { hostEnvironmentIdAtom } from "./state/primaryEnvironment";
import { useNativeFileDrag } from "./useNativeFileDrag";

vi.mock("./state/session", () => ({ useEnvironmentScope: () => true }));

const HOST = EnvironmentId.make("host-environment");
const REMOTE = EnvironmentId.make("remote-environment");

function FileLink({ environmentId }: { environmentId: EnvironmentId }) {
  const nativeDrag = useNativeFileDrag(environmentId, () => "/Users/me/docs/report.pdf");
  return (
    <a href="/Users/me/docs/report.pdf" {...nativeDrag}>
      report.pdf
    </a>
  );
}

async function dragFrom(environmentId: EnvironmentId) {
  const registry = AtomRegistry.make();
  registry.set(hostEnvironmentIdAtom, HOST);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileLink environmentId={environmentId} />
    </RegistryContext.Provider>,
    { router: false }, // The hook needs no routing.
  );
  const event = new DragEvent("dragstart", { bubbles: true, cancelable: true });
  screen.getByRole("link").element().dispatchEvent(event);
  return event;
}

describe("useNativeFileDrag on the desktop app", () => {
  it("never lets a file link start the browser's URL drag", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const startFileDrag = vi.fn(async () => true);
    window.desktopBridge = { startFileDrag } as unknown as NonNullable<typeof window.desktopBridge>;
    try {
      expect((await dragFrom(HOST)).defaultPrevented).toBe(true);
      // A link from a remote environment otherwise drops a t3code://app/... URL shortcut.
      expect((await dragFrom(REMOTE)).defaultPrevented).toBe(true);
    } finally {
      delete window.desktopBridge;
    }
  });
});
