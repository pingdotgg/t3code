import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DictationModelId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeOS from "node:os";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Dictation from "./Dictation.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";
import { models } from "./models.ts";

const fixture = process.env.T3_DICTATION_E2E_FIXTURE;
const candidate = process.env.T3_DICTATION_E2E_MODEL ?? "parakeet-v3";
if (!Schema.is(DictationModelId)(candidate))
  throw new Error("Unknown dictation verification model.");
const model = candidate;
const home = process.env.T3_DICTATION_E2E_HOME;

/** Run explicitly with the spike model directory. Runtime + tokens use real HTTP; ONNX bytes stream from the verified cache. */
it.live.skipIf(!fixture)("installs and transcribes through the real native runtime", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const network = yield* HttpClient.HttpClient;
    const http = HttpClient.make((request) => {
      const name = request.url.split("/").at(-1)!;
      const file =
        model === "parakeet-v3"
          ? models[model].files.find(
              (candidate) => candidate.name === name && name.endsWith(".onnx"),
            )
          : undefined;
      if (!file) return network.execute(request);
      return Stream.toReadableStreamEffect(fs.stream(path.join(fixture!, name))).pipe(
        Effect.map((stream) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(stream, { headers: { "content-length": String(file.bytes) } }),
          ),
        ),
        Effect.orDie,
      );
    });
    const artifactsLayer = DictationArtifacts.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    );
    const layer = Dictation.layer.pipe(
      Layer.provide(DictationRecognizer.layer.pipe(Layer.provide(artifactsLayer))),
      Layer.provideMerge(artifactsLayer),
      Layer.provideMerge(
        ServerSettings.layerTest({ dictation: { engine: "local", localModel: model } }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), home ?? { prefix: "t3-dictation-e2e-" })),
    );
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* service.install({ model });
      assert.strictEqual((yield* service.state).ready, true);
      const wav = Buffer.from(yield* fs.readFile(path.join(fixture!, "test_wavs", "en.wav")));
      assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
      let sampleRate = 0;
      let channels = 0;
      let bits = 0;
      let audio = Buffer.alloc(0);
      for (let offset = 12; offset + 8 <= wav.length;) {
        const name = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        if (name === "fmt ") {
          assert.strictEqual(wav.readUInt16LE(offset + 8), 1);
          channels = wav.readUInt16LE(offset + 10);
          sampleRate = wav.readUInt32LE(offset + 12);
          bits = wav.readUInt16LE(offset + 22);
        }
        if (name === "data") audio = wav.subarray(offset + 8, offset + 8 + size);
        offset += 8 + size + (size % 2);
      }
      assert.strictEqual(channels, 1);
      assert.strictEqual(bits, 16);
      if (sampleRate !== 16000) {
        const converted = Buffer.alloc(Math.floor(((audio.length / 2) * 16000) / sampleRate) * 2);
        for (let i = 0; i < converted.length / 2; i++) {
          const position = (i * sampleRate) / 16000;
          const left = Math.floor(position);
          const right = Math.min(left + 1, audio.length / 2 - 1);
          converted.writeInt16LE(
            Math.round(
              audio.readInt16LE(left * 2) * (1 - (position - left)) +
                audio.readInt16LE(right * 2) * (position - left),
            ),
            i * 2,
          );
        }
        audio = converted;
      }
      const runs: {
        text: string;
        locale: string;
        finishMs: number;
        recordingSeconds: number;
        startMs: number;
      }[] = [];
      for (let run = 0; run < (model === "whisper-turbo" ? 4 : 3); run++) {
        if (model === "whisper-turbo" && run === 1)
          yield* settings.updateSettings({ dictation: { language: "en" } });
        if (model === "whisper-turbo" && run === 3)
          yield* settings.updateSettings({ dictation: { language: "nl" } });
        const recording =
          run !== 2
            ? audio
            : Buffer.concat(
                Array.from({ length: 4 }, () => Buffer.concat([audio, Buffer.alloc(12800)])),
              );
        const beforeStart = yield* Clock.currentTimeMillis;
        const { sessionId } = yield* service.start;
        const startMs = (yield* Clock.currentTimeMillis) - beforeStart;
        let chunkCount = 0;
        for (let offset = 0; offset < recording.length; offset += 3200) {
          yield* service.append({
            sessionId,
            seq: chunkCount++,
            pcm: recording.subarray(offset, offset + 3200).toString("base64"),
          });
        }
        const beforeFinish = yield* Clock.currentTimeMillis;
        const result = yield* service.finish({ sessionId, chunkCount });
        runs.push({
          text: result.text,
          locale: result.locale,
          finishMs: (yield* Clock.currentTimeMillis) - beforeFinish,
          recordingSeconds: recording.length / 32000,
          startMs,
        });
        assert.isTrue(result.text.length > 0);
        if (model === "whisper-turbo" && run === 3) assert.strictEqual(result.locale, "nl");
      }
      // This opt-in test reports the public fixture transcript; the product service never logs recordings.
      process.stdout.write(
        JSON.stringify(
          {
            model,
            availableParallelism: NodeOS.availableParallelism(),
            numThreads: Math.min(8, Math.max(1, NodeOS.availableParallelism())),
            runs,
            rssMB: Math.round(process.memoryUsage().rss / 1e6),
          },
          null,
          2,
        ) + "\n",
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)), Effect.scoped),
);
