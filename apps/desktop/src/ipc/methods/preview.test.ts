import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "project", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "project", "c");

    expect(first).toEqual({
      scope: JSON.stringify([JSON.stringify(["a", "project"]), "b::c"]),
      persistent: true,
      namespace: "profile",
    });
    expect(second).toEqual({
      scope: JSON.stringify([JSON.stringify(["a::b", "project"]), "c"]),
      persistent: true,
      namespace: "profile",
    });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope(
      "environment",
      "project",
      "profile-\ud800",
    );
    const lowSurrogate = PreviewIpc.resolvePartitionScope(
      "environment",
      "project",
      "profile-\udc00",
    );
    const replacement = PreviewIpc.resolvePartitionScope("environment", "project", "profile-�");

    expect(highSurrogate.scope).toBe(
      JSON.stringify([JSON.stringify(["environment", "project"]), "profile-\ud800"]),
    );
    expect(lowSurrogate.scope).toBe(
      JSON.stringify([JSON.stringify(["environment", "project"]), "profile-\udc00"]),
    );
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the default partition persistent and separates incognito", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", "project", undefined)).toEqual({
      scope: '["environment::legacy","project"]',
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope(
        "environment::legacy",
        "project",
        DEFAULT_BROWSER_PROFILE_ID,
      ),
    ).toEqual({
      scope: '["environment::legacy","project"]',
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope(
        "environment::legacy",
        "project",
        INCOGNITO_BROWSER_PROFILE_ID,
      ),
    ).toEqual({
      scope: JSON.stringify(['["environment::legacy","project"]', "incognito"]),
      persistent: false,
      namespace: "profile",
    });
  });

  it("keeps projects in one environment on separate default partitions", () => {
    expect(
      PreviewIpc.resolvePartitionScope("environment", "project-a", DEFAULT_BROWSER_PROFILE_ID),
    ).not.toEqual(
      PreviewIpc.resolvePartitionScope("environment", "project-b", DEFAULT_BROWSER_PROFILE_ID),
    );
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("returns automation status for long runtime tab ids", () =>
    Effect.gen(function* () {
      const tabId =
        `["environment-1","thread:delegated-task:${"a".repeat(120)}",` +
        `"server-epoch-1","preview-1"]`;
      const status = {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };
      const manager = PreviewManager.PreviewManager.of({
        automationStatus: () => Effect.succeed(status),
      } as unknown as PreviewManager.PreviewManager["Service"]);

      expect(tabId.length).toBeGreaterThan(128);
      expect(
        yield* PreviewIpc.automationStatus
          .handler({ tabId })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
      ).toEqual(status);
    }),
  );

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
