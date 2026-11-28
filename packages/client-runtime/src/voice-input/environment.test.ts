import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type EnvironmentSpeechModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { installEnvironmentSpeechModel, startSpeechSynthesis } from "./environment.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test",
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote environment",
    connectionId: "connection-1",
  }),
};

const model = (
  state: EnvironmentSpeechModel["state"],
  active: boolean,
): EnvironmentSpeechModel => ({
  id: "voxtral-mini",
  name: "Voxtral Mini",
  description: "",
  size: 1,
  languages: ["en"],
  accuracy: 1,
  speed: 1,
  recommended: false,
  supportsStreaming: false,
  supportsLanguageDetection: false,
  supportsTranslation: false,
  active,
  state,
});

describe("installEnvironmentSpeechModel", () => {
  it.effect.each([
    {
      name: "keeps the current model after a cancelled download",
      downloaded: model("downloadable", false),
      selects: false,
    },
    {
      name: "selects the model once its download finishes",
      downloaded: model("installed", false),
      selects: true,
    },
    {
      name: "leaves a model already in use alone",
      downloaded: model("installed", true),
      selects: false,
    },
  ])("$name", ({ downloaded, selects }) =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const client = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        const answer = path.endsWith("/select") ? model("installed", true) : downloaded;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ models: [answer] })),
        );
      });

      const { models } = yield* installEnvironmentSpeechModel(PREPARED, downloaded.id).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(paths).toEqual([
        "/api/voice/models/download",
        ...(selects ? ["/api/voice/models/select"] : []),
      ]);
      expect(models[0]?.active).toBe(selects || downloaded.active);
    }),
  );

  it.effect("keeps the current model when cancellation leaves the weights installed", () =>
    Effect.gen(function* () {
      const downloaded = model("installed", false);
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              new URL(request.url).pathname.endsWith("/select")
                ? { models: [model("installed", true)] }
                : { models: [downloaded], cancelled: true },
            ),
          ),
        ),
      );
      const { models } = yield* installEnvironmentSpeechModel(PREPARED, downloaded.id).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(models).toEqual([downloaded]);
    }),
  );
});

const SPEECH_TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-speech" as never,
  label: "Speech",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const SPEECH_PREPARED: PreparedConnection = {
  environmentId: SPEECH_TARGET.environmentId,
  label: SPEECH_TARGET.label,
  httpBaseUrl: SPEECH_TARGET.httpBaseUrl,
  socketUrl: SPEECH_TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: SPEECH_TARGET,
};

const start = (response: Response) =>
  startSpeechSynthesis(SPEECH_PREPARED, "local", {
    text: "Hello",
    model: "",
    voice: "",
    speed: 1,
    language: "en",
  }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(() => Promise.resolve(response))));

describe("startSpeechSynthesis", () => {
  it.effect("returns the environment's stream URL and token for the started synthesis", () =>
    Effect.gen(function* () {
      expect(yield* start(Response.json({ token: "stream-token" }))).toEqual({
        url: "https://environment.example.test/api/voice/synthesis/audio?token=stream-token",
        token: "stream-token",
      });
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
