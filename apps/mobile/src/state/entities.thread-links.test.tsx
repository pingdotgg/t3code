import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as links from "@t3tools/shared/threadLinks";

const fixture = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return { local: Atom.make({ title: "First" }), remote: Atom.make({ title: "Remote" }) };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("@t3tools/shared/threadLinks", { spy: true });

vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../native/ProjectChipIconImages", () => ({}));
vi.mock("./assets", () => ({}));
vi.mock("./orchestration", () => ({}));
vi.mock("./projects", () => ({}));
vi.mock("./server", () => ({}));
vi.mock("./threads", async () => {
  return {
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellAtom: (ref: ScopedThreadRef) =>
        ref.environmentId === "remote" ? fixture.remote : fixture.local,
    },
  };
});

import { useLiveThreadLinkLabels } from "./entities";

it("updates live labels and environment subscriptions without reparsing unchanged source", async () => {
  const registry = AtomRegistry.make();
  const read = vi.mocked((await import("@effect/atom-react")).useAtomValue);
  read.mockImplementation((atom) => registry.get(atom));
  const prepare = vi.spyOn(links, "prepareThreadLinks");
  const root = createRoot(document.createElement("div"));
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const source = "`<t3-thread://v1/code>`\n\n< t3-thread://v1/ignored > <t3-thread://v1/chat>";
  let output = "";
  function Probe({ markdown, environmentId }: { markdown: string; environmentId: EnvironmentId }) {
    const label = useLiveThreadLinkLabels(markdown, environmentId);
    useLayoutEffect(() => {
      output = label;
    }, [label]);
    return null;
  }
  try {
    await act(async () => root.render(<Probe markdown={source} environmentId={local} />));
    expect(output).toBe(source.replace("<t3-thread://v1/chat>", "[First](t3-thread://v1/chat)"));
    const count = prepare.mock.calls.length;
    expect(count).toBe(1);
    registry.set(fixture.local, { title: "Renamed" });
    await act(async () => root.render(<Probe markdown={source} environmentId={local} />));
    expect(output).toContain("[Renamed](t3-thread://v1/chat)");
    await act(async () => root.render(<Probe markdown={source} environmentId={remote} />));
    expect(output).toContain("[Remote](t3-thread://v1/chat)");
    expect(prepare).toHaveBeenCalledTimes(count);
    await act(async () =>
      root.render(<Probe markdown={source + " changed"} environmentId={remote} />),
    );
    expect(output).toBe(
      source.replace("<t3-thread://v1/chat>", "[Remote](t3-thread://v1/chat)") + " changed",
    );
    expect(prepare).toHaveBeenCalledTimes(count + 1);
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    read.mockRestore();
    prepare.mockRestore();
  }
});
