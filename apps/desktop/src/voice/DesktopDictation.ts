import { type DesktopDictationInput, type DesktopDictationResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import type { LocalWhisper } from "./localWhisper.ts";

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly execute: (
      input: DesktopDictationInput,
      owner: number,
    ) => Effect.Effect<DesktopDictationResult>;
  }
>()("@t3tools/desktop/voice/DesktopDictation") {}
export const layer = Layer.effect(
  DesktopDictation,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    let loading: Promise<LocalWhisper> | null = null;
    const owners = new Map<number, () => void>();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const manager = await loading?.catch(() => null);
        await manager?.dispose();
        for (const [owner, cleanup] of owners) {
          manager?.cancelOwner(owner);
          cleanup();
        }
        owners.clear();
      }),
    );
    return DesktopDictation.of({
      execute: Effect.fn("desktop.dictation.execute")(function* (input, owner) {
        const preferences = yield* settings.get.pipe(Effect.orElseSucceed(() => Option.none()));
        return yield* Effect.tryPromise({
          try: async () => {
            loading ??= import("./localWhisper.ts").then(
              ({ LocalWhisper }) =>
                new LocalWhisper(
                  environment.path.join(environment.stateDir, "dictation"),
                  environment.platform,
                  (url, init) => Electron.net.fetch(url, init),
                ),
            );
            const manager = await loading;
            const sender = Electron.webContents.fromId(owner);
            if (!sender || sender.isDestroyed())
              return {
                state: "cancelled" as const,
                message: "The dictation window closed.",
                downloadedBytes: 0,
                totalBytes: 0,
              };
            if (!owners.has(owner)) {
              /** Release the closing renderer's native operation and remove its ownership listener. */
              const cleanup = () => {
                manager.cancelOwner(owner);
                owners.delete(owner);
                sender.removeListener("destroyed", cleanup);
                sender.removeListener("render-process-gone", cleanup);
              };
              sender.once("destroyed", cleanup);
              sender.once("render-process-gone", cleanup);
              owners.set(owner, cleanup);
            }
            return await manager.execute(
              input,
              owner,
              Option.isSome(preferences) ? preferences.value.dictationExecutablePath : "",
            );
          },
          catch: () => ({
            state: "failed" as const,
            message:
              "Local dictation could not access its files or process. Check desktop permissions and try again.",
            downloadedBytes: 0,
            totalBytes: 0,
          }),
        }).pipe(Effect.catch((error) => Effect.succeed(error)));
      }),
    });
  }),
);
