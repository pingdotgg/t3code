// @effect-diagnostics nodeBuiltinImport:off - Feed transport fragments without opening a listener.
import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Protocol from "./CodexManagedTokenProtocol.ts";

const decodeRequest = Schema.decodeUnknownEffect(Protocol.Request);
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.Response));

it.effect(
  "maximum contract instance ID fits the request budget; wire parser does not invent a new ID contract",
  () =>
    Effect.gen(function* () {
      const request = {
        version: 1,
        instanceId: "A".repeat(64),
        environmentId: "00000000-0000-4000-8000-000000000001",
        profileKey: "a".repeat(64),
      };
      const text = JSON.stringify(request);
      assert.isBelow(Buffer.byteLength(text) + 1, Protocol.REQUEST_BYTES);
      assert.equal((yield* decodeRequest(request)).instanceId.length, 64);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeRequest({
              ...request,
              instanceId: "A".repeat(65),
            }),
          ),
        ),
      );
    }),
);

it.effect(
  "frame parser assembles fragments, rejects trailing frames and never truncates an oversized response",
  () =>
    Effect.gen(function* () {
      for (const [chunks, succeeds] of [
        [['{"token":', '"mock"}\n'], true],
        [["{}\n{}\n"], false],
        [["x".repeat(Protocol.RESPONSE_BYTES), "\n"], false],
      ] as const) {
        const socket = new NodeNet.Socket();
        const read = yield* Protocol.readFrame(
          socket,
          Protocol.RESPONSE_BYTES,
          Protocol.SOCKET_IDLE_MS,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        for (const text of chunks) socket.emit("data", Buffer.from(text));
        const result = yield* Fiber.await(read);
        assert.equal(Exit.isSuccess(result), succeeds);
        if (Exit.isSuccess(result))
          assert.deepEqual(yield* decodeResponse(result.value), { token: "mock" });
        socket.destroy();
      }
    }),
);

it.effect("incomplete frame deadline is absolute, not renewed by each byte", () =>
  Effect.gen(function* () {
    const socket = new NodeNet.Socket();
    const read = yield* Protocol.readFrame(
      socket,
      Protocol.REQUEST_BYTES,
      Protocol.SOCKET_IDLE_MS,
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust(Protocol.SOCKET_IDLE_MS - 1);
    socket.emit("data", Buffer.from("{"));
    assert.isUndefined(read.pollUnsafe());
    yield* TestClock.adjust(1);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(read)));
    socket.destroy();
  }),
);

it.effect("disconnected and oversized writes fail without writing a partial token", () =>
  Effect.gen(function* () {
    const socket = new NodeNet.Socket();
    let writes = 0;
    socket.on("data", () => {
      writes++;
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          Protocol.writeFrame(socket, "x".repeat(Protocol.RESPONSE_BYTES), Protocol.RESPONSE_BYTES),
        ),
      ),
    );
    socket.destroy();
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(Protocol.writeFrame(socket, "token", Protocol.RESPONSE_BYTES)),
      ),
    );
    assert.equal(writes, 0);
  }),
);
