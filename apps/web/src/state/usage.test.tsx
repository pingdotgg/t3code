import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-offline");

vi.mock("../i18n/messages", () => ({ m: () => "In the app language" }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./presentation", () => ({
  environmentPresentations: {
    presentationsAtom: Atom.make(
      new Map([
        [
          environmentId,
          { connection: { phase: "disconnected" }, entry: { target: { label: "Build box" } } },
        ],
      ]),
    ),
  },
}));
vi.mock("./session", () => {
  const session = Atom.make(AsyncResult.success(null));
  return {
    environmentSession: { sessionStateAtom: () => session },
    readEnvironmentScope: () => false,
  };
});

const { useUsage } = await import("./usage");

function UsageError() {
  const { environments } = useUsage({
    sinceDay: "2026-11-01",
    untilDay: "2026-11-28",
    timeZone: "UTC",
    resolution: "day",
  } as Parameters<typeof useUsage>[0]);
  return <p>{environments[0]?.error}</p>;
}

describe("useUsage", () => {
  it("says an offline environment is not connected in the app language", () => {
    expect(renderToString(<UsageError />)).toBe("<p>In the app language</p>");
  });
});
