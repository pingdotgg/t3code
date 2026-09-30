// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, expect, it } from "@effect/vitest";

import { ChatGPTRateLimit } from "./ChatGPTRateLimit.ts";

const resources: { limiter: ChatGPTRateLimit; directory: string }[] = [];
const defaults = {
  minimumIntervalSeconds: 60,
  requestsPerHour: 2,
  requestsPerDay: 3,
  cooldownMinutes: 30,
};
async function create() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-limit-test-"));
  const limiter = new ChatGPTRateLimit(NodePath.join(directory, "rate.sqlite"), defaults);
  resources.push({ limiter, directory });
  return { limiter, directory };
}
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.limiter.close();
    await NodeFSP.rm(resource.directory, { recursive: true, force: true });
  }
});

it("counts attempts, waits between requests, and enforces a rolling hour", async () => {
  const { limiter } = await create();
  expect(limiter.reserve(1_000_000)).toEqual({ waitMs: 0 });
  expect(limiter.reserve(1_010_000)).toEqual({ waitMs: 50_000 });
  expect(limiter.reserve(1_060_000)).toEqual({ waitMs: 0 });
  expect(() => limiter.reserve(1_120_000)).toThrow("request limit reached");
  expect(limiter.reserve(4_600_000)).toEqual({ waitMs: 0 });
});

it("retains daily attempts and cooldowns after a provider restart", async () => {
  const resource = await create();
  resource.limiter.reserve(1_000_000);
  resource.limiter.block(1_000_001);
  resource.limiter.close();
  resource.limiter = new ChatGPTRateLimit(
    NodePath.join(resource.directory, "rate.sqlite"),
    defaults,
  );
  resources[0] = resource;
  expect(() => resource.limiter.reserve(1_060_000)).toThrow("cooldown");
  expect(resource.limiter.reserve(4_600_000)).toEqual({ waitMs: 0 });
  expect(resource.limiter.reserve(8_200_000)).toEqual({ waitMs: 0 });
  expect(() => resource.limiter.reserve(11_800_000)).toThrow("request limit reached");
  expect(resource.limiter.reserve(87_400_000)).toEqual({ waitMs: 0 });
});

it("serializes admission across two connections to the same database", async () => {
  const { limiter, directory } = await create();
  const second = new ChatGPTRateLimit(NodePath.join(directory, "rate.sqlite"), defaults);
  try {
    limiter.reserve(1_000_000);
    expect(second.reserve(1_000_000)).toEqual({ waitMs: 60_000 });
    second.block(1_000_001);
    expect(() => limiter.reserve(1_060_000)).toThrow("cooldown");
  } finally {
    second.close();
  }
});
