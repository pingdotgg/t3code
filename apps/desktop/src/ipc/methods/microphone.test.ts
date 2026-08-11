import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronSystemPreferences from "../../electron/ElectronSystemPreferences.ts";
import * as IpcChannels from "../channels.ts";
import { getMicrophoneAccessStatus, requestMicrophoneAccess } from "./microphone.ts";

describe("microphone IPC", () => {
  it.effect("wires the status and request methods to their exact channels", () => {
    let requestCount = 0;
    const layer = Layer.succeed(
      ElectronSystemPreferences.ElectronSystemPreferences,
      ElectronSystemPreferences.ElectronSystemPreferences.of({
        getMicrophoneAccessStatus: Effect.succeed("not-determined"),
        requestMicrophoneAccess: Effect.sync(() => {
          requestCount += 1;
          return "granted" as const;
        }),
      }),
    );

    return Effect.gen(function* () {
      assert.equal(
        getMicrophoneAccessStatus.channel,
        IpcChannels.GET_MICROPHONE_ACCESS_STATUS_CHANNEL,
      );
      assert.equal(requestMicrophoneAccess.channel, IpcChannels.REQUEST_MICROPHONE_ACCESS_CHANNEL);
      assert.equal(yield* getMicrophoneAccessStatus.handler(undefined), "not-determined");
      assert.equal(yield* requestMicrophoneAccess.handler(undefined), "granted");
      assert.equal(requestCount, 1);
    }).pipe(Effect.provide(layer));
  });
});
