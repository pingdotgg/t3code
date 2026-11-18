import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { startSpeechSynthesis } from "./environment.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-speech" as never,
  label: "Speech",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const start = (response: Response) =>
  startSpeechSynthesis(PREPARED, "local", {
    text: "Hello",
    model: "",
    voice: "",
    speed: 1,
    language: "en",
  }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(() => Promise.resolve(response))));

describe("startSpeechSynthesis", () => {
  it.effect("returns the environment's stream URL for the started synthesis", () =>
    Effect.gen(function* () {
      expect(yield* start(Response.json({ token: "stream-token" }))).toBe(
        "https://environment.example.test/api/voice/synthesis/audio?token=stream-token",
      );
    }),
  );

  it.effect("fails with the environment's speech error instead of a fetch failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        start(
          Response.json(
            { _tag: "SpeechSynthesisError", provider: "local", reason: "missing-model" },
            { status: 422 },
          ),
        ),
      );
      expect(error._tag).toBe("SpeechSynthesisError");
      expect(error.message).toBe("Download a local speech model in Settings → Voice.");
    }),
  );
});
