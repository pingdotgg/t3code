import { it as effectIt } from "@effect/vitest";
import { PreviewAutomationStatus } from "@t3tools/contracts";
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

  effectIt.effect("returns filtered native snapshot failure detail", () =>
    Effect.gen(function* () {
      const safeCause = new Error("software compositor copy failed");
      safeCause.name = "UnknownVizError";
      const unsafeCause = new Error("capture failed at https://preview.example/secret");
      unsafeCause.name = "UnknownVizError";
      const failures: PreviewManager.PreviewManagerError[] = [safeCause, unsafeCause].map(
        (cause) =>
          new PreviewManager.PreviewOperationError({
            operation: "automationSnapshot.capturePage",
            tabId: "tab-1",
            webContentsId: 42,
            cause,
          }),
      );
      failures.push(
        new PreviewManager.PreviewAutomationCaptureTimeoutError({
          tabId: "tab-1",
          webContentsId: 42,
          stage: "capture-page",
          timeoutMs: 2_500,
        }),
      );
      let attempt = 0;
      const manager = PreviewManager.PreviewManager.of({
        automationSnapshot: () => Effect.fail(failures[attempt++]!),
      } as unknown as PreviewManager.PreviewManager["Service"]);

      const run = () =>
        PreviewIpc.automationSnapshot
          .handler({ tabId: "tab-1" })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
      expect(yield* run()).toEqual({
        _tag: "Failure",
        error: { name: "UnknownVizError", message: safeCause.message },
      });
      expect(yield* run()).toEqual({
        _tag: "Failure",
        error: { name: "UnknownVizError", message: "Preview capture failed." },
      });
      expect(yield* run()).toEqual({
        _tag: "Failure",
        error: {
          name: "PreviewAutomationCaptureTimeoutError",
          message: "Desktop preview snapshot failed during capture-page.",
          stage: "capture-page",
        },
      });
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
