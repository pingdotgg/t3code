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
        "environment-a:thread-1": "2026-08-01T10:00:00.000Z",
        "environment-b:thread-2": "2026-08-02T10:00:00.000Z",
      },
    );
    expect(target).toEqual({ environmentId: ENV_B, threadId: ThreadId.make("thread-2") });
  });

  it("looks visits up by scoped key, not bare thread id", () => {
    // Visit records are keyed `environmentId:threadId`; a bare-id record must
    // not match (regression: the resolver once used shell.id directly and
    // never found any visit).
    expect(
      resolveScreenshotNavigationTarget([makeShell("thread-1")], {
        "thread-1": "2026-08-01T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      resolveScreenshotNavigationTarget([makeShell("thread-1")], {
        "environment-a:thread-1": "2026-08-01T10:00:00.000Z",
      }),
    ).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-1") });
  });

  it("orders visits chronologically across timezone offsets", () => {
    // "+10:00" sorts after "Z" lexically but is the earlier instant.
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2")],
      {
        "environment-a:thread-1": "2026-08-01T12:00:00.000+10:00", // 02:00Z
        "environment-a:thread-2": "2026-08-01T10:00:00.000Z",
      },
    );
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-2") });
  });

  it("ignores archived threads", () => {
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2", { archivedAt: "2026-08-03T00:00:00.000Z" })],
      {
        "environment-a:thread-1": "2026-08-01T10:00:00.000Z",
        "environment-a:thread-2": "2026-08-02T10:00:00.000Z",
      },
    );
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-1") });
  });

  it("ignores visit records for threads that no longer exist", () => {
    const target = resolveScreenshotNavigationTarget([makeShell("thread-1")], {
      "environment-a:thread-1": "2026-08-01T10:00:00.000Z",
      "environment-a:thread-deleted": "2026-08-05T10:00:00.000Z",
    });
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-1") });
  });

  it("ignores threads that were never visited or have invalid timestamps", () => {
    const target = resolveScreenshotNavigationTarget(
      [makeShell("thread-1"), makeShell("thread-2"), makeShell("thread-3")],
      {
        "environment-a:thread-2": "2026-08-01T10:00:00.000Z",
        "environment-a:thread-3": "not-a-date",
      },
    );
    expect(target).toEqual({ environmentId: ENV_A, threadId: ThreadId.make("thread-2") });
  });

  it("returns null when no visited thread survives", () => {
    expect(resolveScreenshotNavigationTarget([], {})).toBeNull();
    expect(resolveScreenshotNavigationTarget([makeShell("thread-1")], {})).toBeNull();
    expect(
      resolveScreenshotNavigationTarget(
        [makeShell("thread-1", { archivedAt: "2026-08-03T00:00:00.000Z" })],
        { "environment-a:thread-1": "2026-08-01T10:00:00.000Z" },
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
