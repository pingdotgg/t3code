import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { completeConnection, setConnectionReady } from "./appActivation.ts";

const MAIN_WEB_CONTENTS_ID = 7;

function harness() {
  const setConnectionRendererReady = vi.fn(() => Effect.void);
  const complete = vi.fn(() => Effect.void);
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: MAIN_WEB_CONTENTS_ID } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Effect.provideService(
        DesktopAppActivation.DesktopAppActivation,
        DesktopAppActivation.DesktopAppActivation.of({
          setConnectionRendererReady,
          completeConnection: complete,
        } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]),
      ),
    );
  return { setConnectionRendererReady, complete, provide };
}

const completion = {
  dispatchId: "d1",
  response: { version: 1, requestId: "r1", ok: true, result: { environments: [] } },
} as const;

describe("connection bridge IPC sender checks", () => {
  it.effect("accepts the main window renderer", () =>
    Effect.gen(function* () {
      const { setConnectionRendererReady, complete, provide } = harness();
      const sender = { sender: { id: MAIN_WEB_CONTENTS_ID } };
      yield* provide(setConnectionReady.handler(true, sender));
      yield* provide(completeConnection.handler(completion, sender));
      expect(setConnectionRendererReady).toHaveBeenCalledWith(true);
      expect(complete).toHaveBeenCalledWith(completion);
    }),
  );

  it.effect("refuses readiness and completions from any other web contents", () =>
    Effect.gen(function* () {
      const { setConnectionRendererReady, complete, provide } = harness();
      for (const event of [{ sender: { id: 8 } }, undefined]) {
        const ready = yield* Effect.exit(provide(setConnectionReady.handler(true, event)));
        const completed = yield* Effect.exit(
          provide(completeConnection.handler(completion, event)),
        );
        expect(Exit.isFailure(ready)).toBe(true);
        expect(Exit.isFailure(completed)).toBe(true);
      }
      expect(setConnectionRendererReady).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    }),
  );
});
