import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The live modules pull in the connection runtime.
vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  const entry = (environmentId: string) => ({ enabled: true, target: { environmentId } });
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([
          ["work", entry("work")],
          ["home", entry("home")],
        ]),
        focusAllowlist: new Set(["work"]),
      }),
    },
  };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentShell: { stateValueAtom: () => Atom.make({ status: "live" }) } };
});
vi.mock("./thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadOutboxManager: {
      queuedMessagesByThreadKeyAtom: Atom.make({
        "work:thread": [{ environmentId: "work" }],
        "home:thread": [{ environmentId: "home" }],
      }),
    },
  };
});

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxShellStatusesAtom } from "./use-thread-outbox";

describe("thread outbox shell statuses", () => {
  it("leaves out a Focus-paused environment whose shell still reads live", () => {
    expect(appAtomRegistry.get(threadOutboxShellStatusesAtom)).toEqual(
      new Map([[EnvironmentId.make("work"), "live"]]),
    );
  });
});
