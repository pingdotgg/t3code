import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPendingThreadOrder } from "../features/threads/threadOrder";
import { makeThreadShellFixture } from "../test-fixtures";
import { appAtomRegistry } from "./atom-registry";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  pendingThreadOrderAtom,
} from "./thread-order";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()).pipe(Atom.keepAlive) };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return { queuedThreadKeysAtom: Atom.make(new Set<string>()).pipe(Atom.keepAlive) };
});

type ServerConfigs = Atom.Type<typeof environmentServerConfigsAtom>;
type ServerConfig = ServerConfigs extends ReadonlyMap<EnvironmentId, infer Config> ? Config : never;
const configsAtom = environmentServerConfigsAtom as Atom.Writable<ServerConfigs, ServerConfigs>;
const shellsAtom = environmentThreadShells.threadShellsAtom as Atom.Writable<
  readonly EnvironmentThreadShell[],
  readonly EnvironmentThreadShell[]
>;

function fixture() {
  const rows = ["a", "b"].map((id, index) =>
    makeThreadShellFixture({
      id: ThreadId.make(id),
      environmentId: EnvironmentId.make("env"),
      createdAt: `2026-06-01T0${2 - index}:00:00.000Z`,
    }),
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

  it("releases a cancelled move without restoring old canonical keys", () => {
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

  it("retires the hold when a snooze expiry changes the section without a shell event", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));
      const { rows, start } = fixture();
      // Only the snooze capability matters to the section filter; afterEach's
      // registry reset restores the empty configs.
      const config = { environment: { capabilities: { threadSnooze: true } } } as ServerConfig;
      appAtomRegistry.set(configsAtom, new Map([[EnvironmentId.make("env"), config]]));
      const snoozed = makeThreadShellFixture({
        id: ThreadId.make("c"),
        environmentId: EnvironmentId.make("env"),
        createdAt: "2026-06-01T00:00:00.000Z",
        snoozedUntil: "2026-06-01T03:00:05.000Z",
      });
      appAtomRegistry.set(shellsAtom, [...rows, snoozed]);
      start();
      expect(getPendingThreadOrder()).not.toBeNull();

      vi.advanceTimersByTime(5_000);

      expect(appAtomRegistry.get(pendingThreadOrderAtom)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears down a superseded hold's clocks when another hold begins", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));
      const { rows, start } = fixture();
      const snoozed = makeThreadShellFixture({
        id: ThreadId.make("c"),
        environmentId: EnvironmentId.make("env"),
        createdAt: "2026-06-01T00:00:00.000Z",
        snoozedUntil: "2026-06-01T04:00:00.000Z",
      });
      appAtomRegistry.set(shellsAtom, [...rows, snoozed]);
      start();
      start().cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
