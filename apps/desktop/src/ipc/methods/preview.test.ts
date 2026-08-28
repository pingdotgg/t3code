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

  effectIt.effect("returns fulfilled automation press results for known keyboard failures", () =>
    Effect.gen(function* () {
      const errors = [
        new PreviewManager.PreviewAutomationKeyboardWindowNotFocusedError({
          tabId: "tab-1",
          webContentsId: 41,
        }),
        new PreviewManager.PreviewAutomationKeyboardFocusedFrameUnsupportedError({
          tabId: "tab-1",
          webContentsId: 41,
        }),
        new PreviewManager.PreviewAutomationKeyboardDeliveryNotConfirmedError({
          tabId: "tab-1",
          webContentsId: 41,
        }),
        new PreviewManager.PreviewAutomationTargetChangedError({
          operation: "press",
          tabId: "tab-1",
          webContentsId: 41,
        }),
      ];

      for (const error of errors) {
        const manager = PreviewManager.PreviewManager.of({
          automationPress: () => Effect.fail(error),
        } as unknown as PreviewManager.PreviewManager["Service"]);

        expect(
          yield* PreviewIpc.automationPress
            .handler({ tabId: "tab-1", input: { key: "x" } })
            .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
        ).toEqual({
          _tag: "Failure",
          error: {
            _tag: error._tag,
            ...(error._tag === "PreviewAutomationTargetChangedError"
              ? { operation: error.operation }
              : {}),
            tabId: error.tabId,
            webContentsId: error.webContentsId,
          },
        });
      }
    }),
  );

  effectIt.effect("returns a fulfilled automation press success", () =>
    Effect.gen(function* () {
      const manager = PreviewManager.PreviewManager.of({
        automationPress: () => Effect.void,
      } as unknown as PreviewManager.PreviewManager["Service"]);

      expect(
        yield* PreviewIpc.automationPress
          .handler({ tabId: "tab-1", input: { key: "x" } })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
      ).toEqual({ _tag: "Success" });
    }),
  );

  effectIt.effect("rejects unrelated automation press failures", () =>
    Effect.gen(function* () {
      const error = new PreviewManager.PreviewTabNotFoundError({ tabId: "tab-1" });
      const manager = PreviewManager.PreviewManager.of({
        automationPress: () => Effect.fail(error),
      } as unknown as PreviewManager.PreviewManager["Service"]);

      const exit = yield* PreviewIpc.automationPress
        .handler({ tabId: "tab-1", input: { key: "x" } })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, manager), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(error));
    }),
  );
});
