import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { useDirectoryEntries } from "./useDirectoryEntries";

const mocks = vi.hoisted(() => ({
  reachable: null as unknown as Atom.Writable<boolean>,
  connectedSession: null as unknown as Atom.Writable<number>,
}));

vi.mock("~/connection/catalog", () => ({
  // Derived like the real one, which only follows the connection once something computes it.
  environmentCatalog: {
    sessionGenerationAtom: () => Atom.make((get) => get(mocks.connectedSession)),
  },
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    listEntries: () =>
      Atom.make((get) =>
        get(mocks.reachable)
          ? AsyncResult.success({
              entries: [{ path: "README.md", kind: "file" }],
              truncated: false,
            })
          : AsyncResult.failure(Cause.fail(new Error("Environment is reconnecting."))),
      ),
  },
}));

function setup() {
  mocks.reachable = Atom.make(false);
  mocks.connectedSession = Atom.make(1);
}

function Probe() {
  const directory = useDirectoryEntries(EnvironmentId.make("env-files"), "/repo");
  return (
    <output>{directory.error ?? directory.entries.map((entry) => entry.path).join(",")}</output>
  );
}

describe("useDirectoryEntries", () => {
  it("reads a folder that failed while unreachable again once a new session is up", async () => {
    setup();
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe />
      </RegistryContext.Provider>,
      // A bare hook probe; nothing here navigates.
      { router: false },
    );
    await expect.element(screen.getByText("Environment is reconnecting.")).toBeInTheDocument();

    await act(() => {
      appAtomRegistry.set(mocks.reachable, true);
      appAtomRegistry.set(mocks.connectedSession, 2);
    });
    await expect.element(screen.getByText("README.md")).toBeInTheDocument();
  });
});
