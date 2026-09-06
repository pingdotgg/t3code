import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPendingThreadOrder } from "../features/threads/threadOrder";
import { appAtomRegistry } from "./atom-registry";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  pendingThreadOrderAtom,
} from "./thread-order";
import { environmentThreadShells } from "./threads";

vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()).pipe(Atom.keepAlive) };
});

// The mocked shell source is writable so tests can deliver canonical upserts.
const shellsAtom = environmentThreadShells.threadShellsAtom as Atom.Writable<
  readonly EnvironmentThreadShell[],
  readonly EnvironmentThreadShell[]
>;

function fixture() {
  // Only section membership and order fields are read by this coordinator.
  const rows = ["a", "b"].map(
    (id, index) =>
      ({
        id: ThreadId.make(id),
        environmentId: EnvironmentId.make("env"),
        createdAt: `2026-06-01T0${2 - index}:00:00.000Z`,
        archivedAt: null,
        pinnedAt: null,
        activeOrderKey: null,
      }) as EnvironmentThreadShell,
  );
  appAtomRegistry.set(shellsAtom, rows);
  const pending = createPendingThreadOrder({
    section: "active",
    ordered: rows,
    movedId: "env:b",
    direction: "up",
    assignments: [
      { id: "env:b", orderKey: "aa" },
      { id: "env:a", orderKey: "bb" },
    ],
  });
  const start = () => beginPendingThreadOrder(pending);
  const upsert = (id: string, key: string) => {
    const current = appAtomRegistry.get(shellsAtom);
    appAtomRegistry.set(
      shellsAtom,
      current.map((row) => (row.id === id ? { ...row, activeOrderKey: key } : row)),
    );
  };
  return { rows, start, upsert };
}

afterEach(() => appAtomRegistry.reset());

describe("shared mobile pending move", () => {
  it("blocks another pickup after receipts and clears on final canonical upsert", () => {
    const { start, upsert } = fixture();
    const move = start();
    move.complete();
    expect(getPendingThreadOrder()).not.toBeNull();
    upsert("b", "aa");
    expect(getPendingThreadOrder()).not.toBeNull();
    upsert("a", "bb");
    expect(getPendingThreadOrder()).toBeNull();
    expect(move.isPending()).toBe(false);
  });

  it("waits for receipts when shells arrive first", () => {
    const { start, upsert } = fixture();
    const move = start();
    upsert("b", "aa");
    upsert("a", "bb");
    expect(getPendingThreadOrder()).not.toBeNull();
    move.complete();
    expect(getPendingThreadOrder()).toBeNull();
  });

  it.each(["failure", "interruption"])("releases a %s without restoring old canonical keys", () => {
    const { start, upsert } = fixture();
    const move = start();
    upsert("b", "aa");
    move.cancel();
    expect(getPendingThreadOrder()).toBeNull();
    expect(appAtomRegistry.get(shellsAtom)[1]?.activeOrderKey).toBe("aa");
    const next = start();
    move.cancel();
    expect(next.isPending()).toBe(true);
    next.cancel();
  });

  it("stops remaining writes when a canonical membership change invalidates the move", () => {
    const { rows, start } = fixture();
    const move = start();
    appAtomRegistry.set(shellsAtom, rows.slice(1));
    expect(move.isPending()).toBe(false);
    expect(appAtomRegistry.get(pendingThreadOrderAtom)).toBeNull();
    move.complete();
    appAtomRegistry.set(shellsAtom, rows);
    expect(getPendingThreadOrder()).toBeNull();
  });
});
