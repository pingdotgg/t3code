import { HostScreenError, type HostScreenFrame } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Base64 from "effect/encoding/Base64";
import * as ProcessRunner from "../processRunner.ts";

export class HostScreen extends Context.Service<
  HostScreen,
  { readonly capture: () => Effect.Effect<HostScreenFrame, HostScreenError> }
>()("t3/screen/HostScreen") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const permit = yield* Semaphore.make(1);
  let nextCaptureAt = 0;

  const captureFrame = Effect.fn("HostScreen.captureFrame")(
    function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-screen-" });
      const file = path.join(directory, "screen.jpg");
      const capture = yield* runner.run({
        command: "/usr/sbin/screencapture",
        args: ["-x", "-m", "-t", "jpg", file],
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      });
      if (capture.code !== 0) return yield* new HostScreenError({ reason: "unavailable" });
      const resize = yield* runner.run({
        command: "/usr/bin/sips",
        args: ["-Z", "1600", "-s", "formatOptions", "60", file],
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      });
      if (resize.code !== 0) return yield* new HostScreenError({ reason: "unavailable" });
      const stat = yield* fs.stat(file);
      if (stat.size > 2_000_000) return yield* new HostScreenError({ reason: "invalid-image" });
      const bytes = yield* fs.readFile(file);
      const dimensions = readImageDimensions(bytes);
      if (
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        !dimensions ||
        dimensions.width > 1600 ||
        dimensions.height > 1600
      )
        return yield* new HostScreenError({ reason: "invalid-image" });
      return { jpegBase64: Base64.encode(bytes), ...dimensions };
    },
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
      ProcessSpawnError: (cause) =>
        Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
      ProcessStdinError: (cause) =>
        Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
      ProcessOutputLimitError: (cause) =>
        Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
      ProcessReadError: (cause) =>
        Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
      ProcessTimeoutError: (cause) =>
        Effect.fail(new HostScreenError({ reason: "unavailable", cause })),
    }),
  );

  const capture = Effect.fn("HostScreen.capture")(function* () {
    if (platform !== "darwin") return yield* new HostScreenError({ reason: "unsupported" });
    const now = yield* Clock.currentTimeMillis;
    if (now < nextCaptureAt) return yield* new HostScreenError({ reason: "busy" });
    nextCaptureAt = now + 1000;
    const frame = yield* captureFrame().pipe(permit.withPermitsIfAvailable(1));
    return Option.isSome(frame) ? frame.value : yield* new HostScreenError({ reason: "busy" });
  });
  return HostScreen.of({ capture });
});

export const layer = Layer.effect(HostScreen, make);
