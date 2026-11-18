import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  partitionGroupWorkers,
  resolveThreadGroupFor,
  resolveThreadGroupPlacement,
  resolveThreadGroupSection,
  splitThreadGroups,
  type ThreadGroupCandidate,
} from "./threadGroups.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function thread(
  id: string,
  extra: Partial<ThreadGroupCandidate> & { environmentId?: EnvironmentId } = {},
): ThreadGroupCandidate {
  return {
    environmentId: envA,
    id: ThreadId.make(id),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const keyA = (id: string) => scopedThreadKey(scopeThreadRef(envA, ThreadId.make(id)));

describe("threadGroups", () => {
  it("splits workers under their parent and sorts them", () => {
    const parent = thread("p");
    const w1 = thread("w1", { groupParentThreadId: parent.id, groupOrderKey: "b" });
    const w2 = thread("w2", { groupParentThreadId: parent.id, groupOrderKey: "a" });
    const w3 = thread("w3", { groupParentThreadId: parent.id, createdAt: "2026-01-02T00:00:00Z" });
    const w4 = thread("w4", { groupParentThreadId: parent.id });
    const other = thread("o");
    const { roots, workersByParentKey } = splitThreadGroups([w1, parent, w3, other, w2, w4]);
    expect(roots).toEqual([parent, other]);
    expect(workersByParentKey.get(keyA("p"))).toEqual([w2, w1, w4, w3]);
  });

  it("worker without its parent in the input is a root", () => {
    const orphan = thread("w", { groupParentThreadId: ThreadId.make("missing") });
    const { roots, workersByParentKey } = splitThreadGroups([orphan]);
    expect(roots).toEqual([orphan]);
    expect(workersByParentKey.size).toBe(0);
  });

  it("parents in another environment do not match", () => {
    const parent = thread("p", { environmentId: envB });
    const worker = thread("w", { groupParentThreadId: parent.id });
    const { roots, workersByParentKey } = splitThreadGroups([parent, worker]);
    expect(roots).toEqual([parent, worker]);
    expect(workersByParentKey.size).toBe(0);
  });

  it("cycles, chains and workers-of-workers keep every thread visible as a root", () => {
    const a = thread("a", { groupParentThreadId: ThreadId.make("b") });
    const b = thread("b", { groupParentThreadId: ThreadId.make("a") });
    const c = thread("c", { groupParentThreadId: b.id });
    const d = thread("d", { groupParentThreadId: c.id });
    const cycle = splitThreadGroups([a, b]);
    expect(cycle.roots).toEqual([a, b]);
    expect(cycle.workersByParentKey.size).toBe(0);
    const chain = splitThreadGroups([a, b, c, d]);
    expect(chain.roots).toEqual([a, b, c, d]);
    expect(chain.workersByParentKey.size).toBe(0);
    const lead = thread("lead");
    const worker = thread("worker", { groupParentThreadId: lead.id });
    const nested = thread("nested", { groupParentThreadId: worker.id });
    const nestedSplit = splitThreadGroups([lead, worker, nested]);
    expect(nestedSplit.roots).toEqual([lead, nested]);
    expect(nestedSplit.workersByParentKey.get(keyA("lead"))).toEqual([worker]);
    expect(resolveThreadGroupFor([lead, worker, nested], envA, nested.id)).toBeNull();
  });

  it("resolveThreadGroupFor finds the group from a worker and from the parent", () => {
    const parent = thread("p");
    const worker = thread("w", { groupParentThreadId: parent.id });
    const lone = thread("l");
    const all = [parent, worker, lone];
    const expected = { parent, workers: [worker] };
    expect(resolveThreadGroupFor(all, envA, parent.id)).toEqual(expected);
    expect(resolveThreadGroupFor(all, envA, worker.id)).toEqual(expected);
    expect(resolveThreadGroupFor(all, envA, lone.id)).toBeNull();
    expect(resolveThreadGroupFor(all, envB, parent.id)).toBeNull();
  });

  it("any live member keeps the group live", () => {
    expect(resolveThreadGroupPlacement(["settled", "live", "snoozed"])).toBe("live");
    expect(resolveThreadGroupPlacement(["settled", "snoozed"])).toBe("snoozed");
    expect(resolveThreadGroupSection("pinned", "live")).toBe("pinned");
    expect(resolveThreadGroupSection("working", "live")).toBe("working");
    expect(resolveThreadGroupSection("settled", "live")).toBe("active");
  });

  it("settled placement only when every member is settled", () => {
    expect(resolveThreadGroupPlacement(["settled", "settled"])).toBe("settled");
    expect(resolveThreadGroupSection("active", "settled")).toBe("settled");
    expect(resolveThreadGroupSection("active", "snoozed")).toBe("snoozed");
  });

  it("settled workers overflow from three", () => {
    const states = { a: "live", b: "settled", c: "settled", d: "settled", e: "snoozed" } as const;
    const result = partitionGroupWorkers(
      Object.keys(states),
      (w) => states[w as keyof typeof states],
    );
    expect(result.inline).toEqual(["a", "e"]);
    expect(result.settledOverflow).toEqual(["b", "c", "d"]);
    expect(result.snoozedOverflow).toEqual([]);
  });

  it("two settled workers stay inline", () => {
    const result = partitionGroupWorkers(["a", "b"], () => "settled");
    expect(result.inline).toEqual(["a", "b"]);
    expect(result.settledOverflow).toEqual([]);
  });
});
