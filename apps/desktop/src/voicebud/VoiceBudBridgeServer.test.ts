import {
  VOICE_BUD_PROTOCOL_VERSION,
  VoiceBudExternalResponse,
  VoiceBudRecordingId,
  VoiceBudRequestId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import {
  VOICE_BUD_CLOCK_SKEW_MS,
  VOICE_BUD_MAX_FRAME_BYTES,
  VoiceBudBridgeServer,
  type VoiceBudBridgeDescriptor,
} from "./VoiceBudBridgeServer.ts";

const SECRET = "s".repeat(43);
const NOW = 1_800_000_000_000;
const decodeExternalResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(VoiceBudExternalResponse),
);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const frame = (value: unknown) => `${encodeUnknownJson(value)}\n`;

class VoiceBudTestTransportError extends Schema.TaggedErrorClass<VoiceBudTestTransportError>()(
  "VoiceBudTestTransportError",
  {
    cause: Schema.Defect(),
  },
) {}

const sendFrame = Effect.fn("test.sendVoiceBudFrame")(function* (
  descriptor: VoiceBudBridgeDescriptor,
  frame: string,
) {
  return yield* Effect.callback<VoiceBudExternalResponse, VoiceBudTestTransportError>((resume) => {
    const socket = NodeNet.connect(descriptor.socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (cause) => resume(Effect.fail(new VoiceBudTestTransportError({ cause }))));
    socket.on("end", () => {
      resume(
        Effect.try({
          try: () => decodeExternalResponse(response.trim()),
          catch: (cause) => new VoiceBudTestTransportError({ cause }),
        }),
      );
    });
    return Effect.sync(() => socket.destroy());
  });
});

const makeServer = Effect.fn("test.makeVoiceBudServer")(function* (
  options: {
    readonly deferCompletion?: boolean;
    readonly rateLimit?: number;
    readonly readTimeoutMs?: number;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "t3vb-",
  });
  const recordings = new Set<string>();
  let releaseCompletion: () => void = () => {};
  const completionGate = options.deferCompletion
    ? new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      })
    : Promise.resolve();
  let currentTime = NOW;
  const server = new VoiceBudBridgeServer({
    directory,
    fileSystem,
    handler: {
      begin: (_requestId, recordingId) => {
        if (recordings.has(recordingId)) return Promise.resolve("duplicate_recording");
        recordings.add(recordingId);
        return Promise.resolve("accepted");
      },
      complete: async (_deliveryId, recordingId) => {
        if (!recordings.has(recordingId)) return "unknown_recording";
        await completionGate;
        recordings.delete(recordingId);
        return "accepted";
      },
      close: () => {
        releaseCompletion();
        return Promise.resolve();
      },
    },
    path,
    now: () => currentTime,
    secret: SECRET,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
  });
  const descriptor = yield* server.start();
  yield* Effect.addFinalizer(() => server.stop().pipe(Effect.orDie));
  return {
    descriptor,
    directory,
    fileSystem,
    path,
    releaseCompletion,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
  };
});

function startedRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: VOICE_BUD_PROTOCOL_VERSION,
    type: "recording.started",
    requestId: "request-1",
    recordingId: "recording-1",
    nonce: "nonce-1",
    sentAt: NOW,
    auth: SECRET,
    ...overrides,
  };
}

const provideTestServices = <A, E, R>(
  effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("VoiceBudBridgeServer", () => {
  effectIt.live("publishes a private Unix socket and descriptor", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { directory, descriptor, fileSystem, path } = yield* makeServer();
        expect(descriptor.transport).toBe("unix");
        expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
        expect((yield* fileSystem.stat(path.join(directory, "bridge.json"))).mode & 0o777).toBe(
          0o600,
        );
        expect((yield* fileSystem.stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  effectIt.live("requires authentication and rejects replayed request ids or nonces", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { descriptor } = yield* makeServer();
        const unauthenticated = yield* sendFrame(
          descriptor,
          frame(startedRequest({ auth: "x".repeat(43) })),
        );
        expect(unauthenticated.code).toBe("authentication_failed");

        const accepted = yield* sendFrame(descriptor, frame(startedRequest()));
        expect(accepted).toMatchObject({ accepted: true, code: "accepted" });

        const replay = yield* sendFrame(descriptor, frame(startedRequest()));
        expect(replay.code).toBe("replay");

        const nonceReplay = yield* sendFrame(
          descriptor,
          frame(
            startedRequest({
              requestId: "request-2",
              recordingId: "recording-2",
            }),
          ),
        );
        expect(nonceReplay.code).toBe("replay");
      }),
    ),
  );

  effectIt.live("retains replay keys for every timestamp that can still be valid", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { advanceTime, descriptor } = yield* makeServer();
        const start = startedRequest({ sentAt: NOW + VOICE_BUD_CLOCK_SKEW_MS });
        expect((yield* sendFrame(descriptor, frame(start))).code).toBe("accepted");
        expect(
          (yield* sendFrame(
            descriptor,
            frame({
              ...startedRequest({
                type: "transcription.completed",
                requestId: "complete",
                nonce: "complete-nonce",
              }),
              transcript: "hello",
            }),
          )).code,
        ).toBe("accepted");

        advanceTime(VOICE_BUD_CLOCK_SKEW_MS * 2);
        expect((yield* sendFrame(descriptor, frame(start))).code).toBe("replay");
      }),
    ),
  );

  effectIt.live("rate limits requests before dispatching them", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { descriptor } = yield* makeServer({ rateLimit: 1 });
        expect((yield* sendFrame(descriptor, frame(startedRequest()))).code).toBe("accepted");
        expect(
          (yield* sendFrame(
            descriptor,
            frame(
              startedRequest({
                requestId: "request-2",
                recordingId: "recording-2",
                nonce: "nonce-2",
              }),
            ),
          )).code,
        ).toBe("rate_limited");
      }),
    ),
  );

  effectIt.live("stops the frame-read timeout while renderer delivery is in progress", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { descriptor, releaseCompletion } = yield* makeServer({
          deferCompletion: true,
          readTimeoutMs: 5,
        });
        expect((yield* sendFrame(descriptor, frame(startedRequest()))).code).toBe("accepted");
        const complete = {
          ...startedRequest({
            type: "transcription.completed",
            requestId: "complete-delayed",
            nonce: "nonce-delayed",
          }),
          transcript: "hello",
        };
        const delivery = yield* sendFrame(descriptor, frame(complete)).pipe(Effect.forkChild);
        yield* Effect.sleep(25);
        releaseCompletion();
        expect((yield* Fiber.join(delivery)).code).toBe("accepted");
      }),
    ),
  );

  effectIt.live("rejects malformed, oversized, expired, and unknown-recording payloads", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { descriptor } = yield* makeServer();
        expect((yield* sendFrame(descriptor, "{not-json}\n")).code).toBe("malformed");
        expect(
          (yield* sendFrame(descriptor, frame(startedRequest({ sentAt: NOW - 60_000 })))).code,
        ).toBe("expired");
        expect(
          (yield* sendFrame(
            descriptor,
            frame({
              ...startedRequest({
                type: "transcription.completed",
                requestId: "complete-unknown",
                recordingId: "missing",
                nonce: "nonce-unknown",
              }),
              transcript: "hello",
            }),
          )).code,
        ).toBe("unknown_recording");
        expect(
          (yield* sendFrame(descriptor, `${"x".repeat(VOICE_BUD_MAX_FRAME_BYTES + 1)}\n`)).code,
        ).toBe("oversized");
      }),
    ),
  );

  effectIt.live("consumes an accepted recording exactly once", () =>
    provideTestServices(
      Effect.gen(function* () {
        const { descriptor } = yield* makeServer();
        expect((yield* sendFrame(descriptor, frame(startedRequest()))).code).toBe("accepted");
        const complete = {
          ...startedRequest({
            type: "transcription.completed",
            requestId: VoiceBudRequestId.make("complete-1"),
            recordingId: VoiceBudRecordingId.make("recording-1"),
            nonce: "nonce-complete",
          }),
          transcript: "hello",
        };
        expect((yield* sendFrame(descriptor, frame(complete))).code).toBe("accepted");
        expect(
          (yield* sendFrame(
            descriptor,
            frame({
              ...complete,
              requestId: "complete-2",
              nonce: "nonce-complete-2",
            }),
          )).code,
        ).toBe("unknown_recording");
      }),
    ),
  );
});
