import {
  BearerConnectionTarget,
  SshConnectionTarget,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../test/render";
import { useRemoteOpenResolution } from "./remoteOpen";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";

const state = vi.hoisted(() => ({
  presentationAtom: null as Atom.Writable<EnvironmentPresentation | null> | null,
}));
vi.mock(import("./state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  state.presentationAtom = Atom.make<EnvironmentPresentation | null>(null);
  return { environmentPresentations: { presentationAtom: () => state.presentationAtom! } } as never;
});

const environmentId = EnvironmentId.make("home-service");
function Resolution() {
  const resolution = useRemoteOpenResolution(environmentId);
  return (
    <output>
      {resolution.state.mode}/{String(resolution.isSameHomeBearer)}
    </output>
  );
}

it("marks only matching-home bearer execution and updates provenance when the mode stays local", async () => {
  const getHomeEnvironmentId = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
  vi.stubGlobal("desktopBridge", { getHomeEnvironmentId });
  using _cleanup = {
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
      appAtomRegistry.dispose();
    },
  };
  const presentation = (connectionId: string): EnvironmentPresentation => ({
    entry: {
      target: new BearerConnectionTarget({ environmentId, label: "Service", connectionId }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  });
  appAtomRegistry.set(state.presentationAtom!, presentation("local:secondary"));
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Resolution />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("local-exec/false");
  await vi.waitFor(() => expect(getHomeEnvironmentId).toHaveResolvedWith(null));

  getHomeEnvironmentId.mockResolvedValue(environmentId);
  appAtomRegistry.set(state.presentationAtom!, presentation("paired-service"));
  await expect.element(screen.getByRole("status")).toHaveTextContent("local-exec/true");

  const ssh = presentation("paired-service");
  appAtomRegistry.set(state.presentationAtom!, {
    ...ssh,
    entry: {
      ...ssh.entry,
      target: new SshConnectionTarget({ environmentId, label: "SSH", connectionId: "ssh-service" }),
    },
  });
  await expect.element(screen.getByRole("status")).toHaveTextContent("remote-unavailable/false");
});
