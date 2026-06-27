import { it as effectIt } from "@effect/vitest";
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

  effectIt.effect(
    "rejects invalid native surface bounds before resolving the preview service",
    () =>
      Effect.map(
        PreviewIpc.setSurface
          .handler({
            tabId: "tab-1",
            bounds: { x: 0, y: 0, width: 0, height: 800 },
            visible: true,
            scale: 1,
          })
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
});
