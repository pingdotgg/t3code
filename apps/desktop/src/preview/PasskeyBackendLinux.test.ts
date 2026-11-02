import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Subprocess fixtures need actual Node pipes.
import * as NodeStream from "node:stream";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), window: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({
  BrowserWindow: function (options: unknown) {
    return mocks.window(options);
  },
}));

import { linuxPasskeyBackend } from "./PasskeyBackendLinux.ts";
import type { PasskeyCeremonyContext } from "./PasskeyBackend.ts";

const setup = () => {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    kill: vi.fn(() => true),
  });
  const prompt = Object.assign(new NodeEvents.EventEmitter(), {
    setMenu: vi.fn(),
    loadURL: vi.fn(async () => {}),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
    webContents: Object.assign(new NodeEvents.EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
    }),
  });
  mocks.spawn.mockReset().mockReturnValue(child);
  mocks.window.mockReset().mockReturnValue(prompt);
  const controller = new AbortController();
  const context = {
    origin: "https://accounts.example.com",
    window: {},
    signal: controller.signal,
  } as PasskeyCeremonyContext;
  const send = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
  return { child, prompt, controller, context, send, backend: linuxPasskeyBackend("/helper") };
};

describe("Linux phone passkeys", () => {
  it("forwards the committed origin and exact buffer slices and preserves discoverable account data", async () => {
    const { backend, context, child, send } = setup();
    const pending = backend.get(
      {
        challenge: new Uint8Array([9, 1, 2, 9]).subarray(1, 3),
        allowCredentials: [{ type: "public-key", id: new Uint8Array([3, 4]) }],
      },
      context,
    );
    assert.deepStrictEqual(JSON.parse(child.stdin.read().toString()), {
      operation: "get",
      origin: context.origin,
      publicKey: { challenge: "AQI", allowCredentials: [{ type: "public-key", id: "AwQ" }] },
    });
    send({
      type: "result",
      credential: {
        id: "AwQ",
        response: {
          clientDataJSON: "BQ",
          authenticatorData: "Bg",
          signature: "Bw",
          userHandle: "CA",
        },
        clientExtensionResults: { prf: { results: { first: "CQ" } } },
      },
    });
    assert.deepStrictEqual(await pending, {
      success: true,
      data: {
        credentialId: "AwQ",
        clientDataJSON: "BQ",
        authenticatorData: "Bg",
        signature: "Bw",
        userHandle: "CA",
        extensions: { prf: { results: { first: "CQ" } } },
      },
    });
    assert.strictEqual(child.kill.mock.calls.length, 1);
  });

  it.each([true, undefined])(
    "preserves registration attestation when credProps.rk is %s",
    async (rk) => {
      const { backend, context, send } = setup();
      const pending = backend.create(
        {
          challenge: new Uint8Array([1]),
          rp: { name: "Example" },
          user: { id: new Uint8Array([2]), name: "alice", displayName: "Alice" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
        context,
      );
      send({
        type: "result",
        credential: {
          id: "AQ",
          response: {
            clientDataJSON: "Ag",
            attestationObject: "Aw",
            authenticatorData: "BA",
            publicKey: "BQ",
            publicKeyAlgorithm: -7,
          },
          clientExtensionResults: { credProps: rk === undefined ? {} : { rk } },
        },
      });
      assert.deepStrictEqual(await pending, {
        success: true,
        data: {
          credentialId: "AQ",
          clientDataJSON: "Ag",
          attestationObject: "Aw",
          authData: "BA",
          publicKey: "BQ",
          publicKeyAlgorithm: -7,
          transports: ["hybrid"],
          extensions: { credProps: rk === undefined ? {} : { rk } },
        },
      });
    },
  );

  it.each(["abort", "close", "malformed", "error"])(
    "stops native discovery on %s",
    async (ending) => {
      const { backend, context, send, child, prompt, controller } = setup();
      const pending = backend.get({ challenge: new Uint8Array([1]) }, context);
      if (ending !== "error") send({ type: "qr", url: "FIDO:/12345678901234567890" });
      if (ending === "abort") controller.abort();
      if (ending === "close") prompt.emit("closed");
      if (ending === "malformed") send({ type: "result", credential: {} });
      if (ending === "error") child.emit("error", new Error("missing helper"));
      assert.deepStrictEqual(
        await pending,
        ending === "error"
          ? { success: false, error: "NotSupportedError", fallbackToNative: true }
          : { success: false, error: "NotAllowedError" },
      );
      assert.strictEqual(child.kill.mock.calls.length, 1);
      assert.strictEqual(prompt.destroy.mock.calls.length, ending === "error" ? 0 : 1);
      assert.strictEqual(child.stdout.listenerCount("data"), 0);
    },
  );
});
