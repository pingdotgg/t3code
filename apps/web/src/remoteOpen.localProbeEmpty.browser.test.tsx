import { expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { render, stubGlobal } from "../test/render";
import { useLocalEditors } from "./remoteOpen";

// Own file: the probe atom is kept alive for the page, so another probe result would leak in.
it("keeps an empty local probe instead of offering the VS Code fallback", async () => {
  const probe = vi.fn(async () => [] as const);
  using _bridge = stubGlobal("desktopBridge", { probeLocalEditors: probe });
  function Probe() {
    return <output>{`[${useLocalEditors().join(",")}]`}</output>;
  }
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toBe("[]"));
});
