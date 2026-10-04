import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sweepProviderLogs } from "./ProviderLogRetention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const directories: string[] = [];

async function makeLogDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "provider-log-retention-"));
  directories.push(directory);
  return directory;
}

async function writeLog(directory: string, name: string, bytes = 10): Promise<string> {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, Buffer.alloc(bytes, "x"));
  return filePath;
}

async function setAge(filePath: string, ageMs: number, now = Date.now()): Promise<void> {
  const timestamp = new Date(now - ageMs);
  await fs.utimes(filePath, timestamp, timestamp);
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

/*
 * Failure modes covered: stale/deleted identity must not retain logs; recent or
 * live heads and shared heads must not be unlinked; age and size policies are
 * independent; size cleanup must prefer rotations and stop at the cap; one
 * filesystem error must not abort other files.
 */
describe("sweepProviderLogs", () => {
  it("removes deleted and unknown thread logs regardless of age", async () => {
    const directory = await makeLogDirectory();
    const deletedHead = await writeLog(directory, "deleted-thread.log");
    const deletedRotation = await writeLog(directory, "deleted-thread.log.1");
    const unknownHead = await writeLog(directory, "unknown-thread.log");
    const unknownRotation = await writeLog(directory, "unknown-thread.log.2");
    const recentUnknownHead = await writeLog(directory, "recent-unknown-thread.log");
    const existingHead = await writeLog(directory, "existing-thread.log");
    for (const filePath of [deletedHead, deletedRotation, unknownHead, unknownRotation]) {
      await setAge(filePath, 90 * DAY_MS);
    }

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [
        { id: "deleted-thread", deletedAt: "2024-01-01T00:00:00.000Z" },
        { id: "existing-thread", deletedAt: null },
      ],
      liveThreadIds: new Set(),
      retentionDays: null,
      maxTotalMb: null,
    });

    expect(await exists(deletedHead)).toBe(false);
    expect(await exists(deletedRotation)).toBe(false);
    expect(await exists(unknownHead)).toBe(false);
    expect(await exists(unknownRotation)).toBe(false);
    expect(await exists(recentUnknownHead)).toBe(true);
    expect(await exists(existingHead)).toBe(true);
    expect(summary.removed.deletedThreads.files).toBe(2);
    expect(summary.removed.unknownThreads.files).toBe(2);
  });

  it("removes an old rotation but keeps recent logs", async () => {
    const directory = await makeLogDirectory();
    const oldRotation = await writeLog(directory, "thread-a.log.2");
    const recentRotation = await writeLog(directory, "thread-a.log.1");
    const recentHead = await writeLog(directory, "thread-a.log");
    await setAge(oldRotation, 15 * DAY_MS);
    await setAge(recentRotation, 2 * DAY_MS);
    await setAge(recentHead, HOUR_MS / 2);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "thread-a", deletedAt: null }],
      liveThreadIds: new Set(),
      retentionDays: 14,
      maxTotalMb: null,
    });

    expect(await exists(oldRotation)).toBe(false);
    expect(await exists(recentRotation)).toBe(true);
    expect(await exists(recentHead)).toBe(true);
    expect(summary.removed.age.files).toBe(1);
  });

  it("removes oldest rotations before heads and stops once under the size cap", async () => {
    const directory = await makeLogDirectory();
    const now = Date.now();
    const oldestRotation = await writeLog(directory, "thread-a.log.2", 2 * 1024 * 1024);
    const newerRotation = await writeLog(directory, "thread-a.log.1", 2 * 1024 * 1024);
    const oldHead = await writeLog(directory, "thread-a.log", 2 * 1024 * 1024);
    await setAge(oldestRotation, 3 * DAY_MS, now);
    await setAge(newerRotation, 2 * DAY_MS, now);
    await setAge(oldHead, 10 * DAY_MS, now);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "thread-a", deletedAt: null }],
      liveThreadIds: new Set(),
      retentionDays: null,
      maxTotalMb: 4,
      nowMs: now,
    });

    expect(await exists(oldestRotation)).toBe(false);
    expect(await exists(newerRotation)).toBe(true);
    expect(await exists(oldHead)).toBe(true);
    expect(summary.removed.sizeCap.files).toBe(1);
    expect(summary.remainingBytes).toBe(4 * 1024 * 1024);
  });

  it("never removes a live thread head, even when old and over the size cap", async () => {
    const directory = await makeLogDirectory();
    const liveHead = await writeLog(directory, "live-thread.log", 1024);
    const unprojectedLiveHead = await writeLog(directory, "unprojected-live-thread.log", 1024);
    await setAge(liveHead, 30 * DAY_MS);
    await setAge(unprojectedLiveHead, 30 * DAY_MS);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "live-thread", deletedAt: null }],
      liveThreadIds: new Set(["live-thread", "unprojected-live-thread"]),
      retentionDays: 1,
      maxTotalMb: 0,
    });

    expect(await exists(liveHead)).toBe(true);
    expect(await exists(unprojectedLiveHead)).toBe(true);
    expect(summary.removed.age.files).toBe(0);
    expect(summary.removed.sizeCap.files).toBe(0);
  });

  it("disables the age pass when retention days are null", async () => {
    const directory = await makeLogDirectory();
    const oldRotation = await writeLog(directory, "thread-a.log.1", 1024);
    await setAge(oldRotation, 30 * DAY_MS);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "thread-a", deletedAt: null }],
      liveThreadIds: new Set(),
      retentionDays: null,
      maxTotalMb: 5120,
    });

    expect(await exists(oldRotation)).toBe(true);
    expect(summary.removed.age.files).toBe(0);
    expect(summary.removed.sizeCap.files).toBe(0);
  });

  it("disables the size pass when the total-size limit is null", async () => {
    const directory = await makeLogDirectory();
    const rotation = await writeLog(directory, "thread-a.log.1", 6 * 1024 * 1024);
    await setAge(rotation, 2 * DAY_MS);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "thread-a", deletedAt: null }],
      liveThreadIds: new Set(),
      retentionDays: 14,
      maxTotalMb: null,
    });

    expect(await exists(rotation)).toBe(true);
    expect(summary.removed.age.files).toBe(0);
    expect(summary.removed.sizeCap.files).toBe(0);
  });

  it("keeps shared heads but allows their rotations to be retained", async () => {
    const directory = await makeLogDirectory();
    const eventHead = await writeLog(directory, "events.log");
    const eventRotation = await writeLog(directory, "events.log.1");
    const providerHead = await writeLog(directory, "provider-events.ndjson");
    const providerRotation = await writeLog(directory, "provider-events.ndjson.1");
    for (const filePath of [eventHead, eventRotation, providerHead, providerRotation]) {
      await setAge(filePath, 30 * DAY_MS);
    }

    await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [],
      liveThreadIds: new Set(),
      retentionDays: 14,
      maxTotalMb: null,
    });

    expect(await exists(eventHead)).toBe(true);
    expect(await exists(providerHead)).toBe(true);
    expect(await exists(eventRotation)).toBe(false);
    expect(await exists(providerRotation)).toBe(false);
  });

  it("continues after a per-file unlink error", async () => {
    const directory = await makeLogDirectory();
    const inaccessible = await writeLog(directory, "thread-a.log.1");
    const removable = await writeLog(directory, "thread-a.log.2");
    await setAge(inaccessible, 30 * DAY_MS);
    await setAge(removable, 31 * DAY_MS);

    const summary = await sweepProviderLogs({
      providerLogsDir: directory,
      threads: [{ id: "thread-a", deletedAt: null }],
      liveThreadIds: new Set(),
      retentionDays: 14,
      maxTotalMb: null,
      unlink: async (filePath) => {
        if (filePath === inaccessible) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        await fs.unlink(filePath);
      },
    });

    expect(await exists(inaccessible)).toBe(true);
    expect(await exists(removable)).toBe(false);
    expect(summary.failedFiles).toBe(1);
    expect(summary.removed.age.files).toBe(1);
  });
});
