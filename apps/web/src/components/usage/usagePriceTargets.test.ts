import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  writeUsagePrices,
  type UsagePriceTarget,
  type UsagePriceWriteResult,
} from "./usagePriceTargets";

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
const target = (id: string, overrides: Partial<UsagePriceTarget> = {}): UsagePriceTarget => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  prices: { example: price },
  aliases: {},
  unavailable: null,
  ...overrides,
});

describe("model price writes", () => {
  it("sends all table changes in one patch per environment and skips unchanged destinations", async () => {
    const write = vi.fn(async () => ({ _tag: "Success" as const }));
    const onResult = vi.fn();
    await writeUsagePrices({
      targets: [target("edited"), target("unchanged")],
      changes: new Map([
        [
          EnvironmentId.make("edited"),
          [
            { model: "new-model", price },
            { model: "example", price: null },
          ],
        ],
      ]),
      write,
      onResult,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith({
      environmentId: "edited",
      input: { patch: { usagePriceOverrides: { "new-model": price, example: null } } },
    });
    expect(onResult).toHaveBeenCalledWith("unchanged", { status: "saved" });
  });

  it("saves independently, skips unavailable targets, and retries failures without rewriting successes", async () => {
    let resolveSlow!: (result: { _tag: "Success" | "Failure" }) => void;
    const slow = new Promise<{ _tag: "Success" | "Failure" }>((resolve) => {
      resolveSlow = resolve;
    });
    let resolveFastSaved!: () => void;
    const fastSaved = new Promise<void>((resolve) => {
      resolveFastSaved = resolve;
    });
    const targets = [target("fast"), target("slow"), target("offline", { unavailable: "Offline" })];
    const results = new Map<EnvironmentId, UsagePriceWriteResult>();
    const write = vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) =>
      environmentId === "slow" ? slow : { _tag: "Success" as const },
    );
    const change = { model: "example", price };
    const running = writeUsagePrices({
      targets,
      changes: new Map(targets.map((target) => [target.environmentId, [change]])),
      write,
      onResult: (id, result) => {
        results.set(id, result);
        if (id === "fast") resolveFastSaved();
      },
    });
    await fastSaved;
    expect(results.get(EnvironmentId.make("fast"))).toEqual({ status: "saved" });
    expect(results.get(EnvironmentId.make("offline"))).toEqual({
      status: "failed",
      error: "Offline",
    });
    expect(results.has(EnvironmentId.make("slow"))).toBe(false);
    resolveSlow({ _tag: "Failure" });
    await running;
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith({
      environmentId: "fast",
      input: { patch: { usagePriceOverrides: { example: price } } },
    });
    const retry = vi.fn(async () => ({ _tag: "Success" as const }));
    await writeUsagePrices({
      targets: targets
        .filter((entry) => results.get(entry.environmentId)?.status === "failed")
        .map((entry) => ({ ...entry, unavailable: null })),
      changes: new Map(targets.map((target) => [target.environmentId, [change]])),
      write: retry,
      onResult: (id, result) => {
        results.set(id, result);
      },
    });
    expect(retry.mock.calls).toHaveLength(2);
    expect(retry).not.toHaveBeenCalledWith(expect.objectContaining({ environmentId: "fast" }));
    expect([...results.values()].every((result) => result.status === "saved")).toBe(true);
  });

  it("sends mappings beside prices and fails servers that cannot store them", async () => {
    const write = vi.fn(async () => ({ _tag: "Success" as const }));
    const onResult = vi.fn();
    const changes = [
      { model: "example", alias: "example-model" },
      { model: "example", price: null },
    ];
    await writeUsagePrices({
      targets: [target("current"), target("old", { aliases: null })],
      changes: new Map([
        [EnvironmentId.make("current"), changes],
        [EnvironmentId.make("old"), changes],
      ]),
      write,
      onResult,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith({
      environmentId: "current",
      input: {
        patch: {
          usagePriceOverrides: { example: null },
          usageModelAliases: { example: "example-model" },
        },
      },
    });
    expect(onResult).toHaveBeenCalledWith("old", {
      status: "failed",
      error: "Update server to map models",
    });
  });
});
