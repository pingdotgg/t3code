import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  buildScreenshotFileName,
  resolveScreenshotNavigationTarget,
  type ScreenshotTargetThreadShell,
} from "./screenshotCapture.logic";

const ENV_A = EnvironmentId.make("environment-a");
const ENV_B = EnvironmentId.make("environment-b");

function makeShell(
  id: string,
  overrides: Partial<ScreenshotTargetThreadShell> = {},
): ScreenshotTargetThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: ENV_A,
    archivedAt: null,
    ...overrides,
  };
}

describe("resolveScreenshotNavigationTarget", () => {
  it("picks the most recently visited existing thread", () => {
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2", { environmentId: ENV_B })],
      {
        "thread-1": "2026-08-01T10:00:00.000Z",
        "thread-2": "2026-08-02T10:00:00.000Z",
      },
    );
    expect(target).toEqual({ environmentId: ENV_B, threadId: ThreadId.make("thread-2") });
  });

  it("ignores archived threads", () => {
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2", { archivedAt: "2026-08-03T00:00:00.000Z" })],
      {
        "thread-1": "2026-08-01T10:00:00.000Z",
        "thread-2": "2026-08-02T10:00:00.000Z",
      },
    );
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-1") });
  });

  it("ignores visit records for threads that no longer exist", () => {
    const target = resolveScreenshotNavigationTarget([makeShell("thread-1")], {
      "thread-1": "2026-08-01T10:00:00.000Z",
      "thread-deleted": "2026-08-05T10:00:00.000Z",
    });
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-1") });
  });

  it("ignores threads that were never visited", () => {
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2")],
      { "thread-2": "2026-08-01T10:00:00.000Z" },
    );
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-2") });
  });

  it("returns null when no visited thread survives", () => {
    expect(resolveScreenshotNavigationTarget([], {})).toBeNull();
    expect(resolveScreenshotNavigationTarget([makeShell("thread-1")], {})).toBeNull();
    expect(
      resolveScreenshotNavigationTarget(
        [makeShell("thread-1", { archivedAt: "2026-08-03T00:00:00.000Z" })],
        { "thread-1": "2026-08-01T10:00:00.000Z" },
      ),
    ).toBeNull();
  });
});

describe("buildScreenshotFileName", () => {
  const capturedAt = new Date(2026, 7, 25, 14, 30, 12);

  it("slugs the app name into the file name", () => {
    expect(buildScreenshotFileName("Google Chrome", capturedAt)).toBe(
      "screenshot-google-chrome-2026-08-25-143012.png",
    );
  });

  it("omits the app segment when absent or slugged empty", () => {
    expect(buildScreenshotFileName(undefined, capturedAt)).toBe("screenshot-2026-08-25-143012.png");
    expect(buildScreenshotFileName("---", capturedAt)).toBe("screenshot-2026-08-25-143012.png");
  });

  it("truncates very long app names", () => {
    const name = buildScreenshotFileName("a".repeat(100), capturedAt);
    expect(name).toBe(`screenshot-${"a".repeat(40)}-2026-08-25-143012.png`);
  });
});
