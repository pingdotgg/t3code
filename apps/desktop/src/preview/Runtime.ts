import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { installPreviewIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewBroadcast from "./PreviewBroadcast.ts";
import * as PreviewEnvironment from "./PreviewEnvironment.ts";

export interface PreviewRuntimeOptions {
  /** Directory screenshots and screen recordings are written to. */
  readonly browserArtifactsDir: string;
}

export interface PreviewRuntimeHandle {
  /** Window hosting preview webviews; used for focus and input routing. */
  readonly setMainWindow: (window: BrowserWindow) => Promise<void>;
  /** True when a `<webview>` partition belongs to the preview browser session. */
  readonly isBrowserPartition: (partition: string) => boolean;
  /** Removes every preview IPC handler and releases preview resources. */
  readonly dispose: () => Promise<void>;
}

/**
 * Boots the collaborative browser preview runtime inside the existing Electron
 * main process.
 *
 * The desktop shell stays a plain Electron bootstrap; this is the only adapter
 * that owns the Effect runtime backing the preview manager, its IPC surface,
 * and renderer event forwarding.
 */
export const startPreviewRuntime = async (
  options: PreviewRuntimeOptions,
): Promise<PreviewRuntimeHandle> => {
  const layer = Layer.mergeAll(
    PreviewManager.layer.pipe(
      Layer.provideMerge(BrowserSession.layer),
      Layer.provideMerge(PreviewEnvironment.layer(options.browserArtifactsDir)),
    ),
    PreviewBroadcast.layer,
    Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(ipcMain)),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  let resolveManager: (manager: PreviewManager.PreviewManager["Service"]) => void = () => undefined;
  const managerReady = new Promise<PreviewManager.PreviewManager["Service"]>((resolve) => {
    resolveManager = resolve;
  });

  const program = Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* installPreviewIpcHandlers();
    resolveManager(manager);
    yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.orDie);

  const fiber = Effect.runFork(program);
  const manager = await managerReady;

  return {
    setMainWindow: (window) => Effect.runPromise(manager.setMainWindow(window).pipe(Effect.orDie)),
    isBrowserPartition: manager.isBrowserPartition,
    dispose: () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
  };
};
