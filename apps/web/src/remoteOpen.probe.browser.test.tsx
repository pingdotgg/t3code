import { expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { act, render, stubGlobal } from "../test/render";
import { useRemoteCapableEditors } from "./remoteOpen";

it("lists a probed Zed install instead of the VS Code fallback", async () => {
  const probe = vi.fn(async () => ["zed", "vscode"] as const);
  using _bridge = stubGlobal("desktopBridge", { probeRemoteEditors: probe });
  function Probe() {
    return <output>{useRemoteCapableEditors().join(",")}</output>;
  }
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toBe("zed,vscode"));
  await act(async () => undefined);
  expect(probe).toHaveBeenCalledOnce();
});
