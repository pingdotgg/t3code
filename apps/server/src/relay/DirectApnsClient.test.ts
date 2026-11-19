// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generates a throwaway P-256 key for signing.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DirectApnsClient from "./DirectApnsClient.ts";
import type { StoredPushDevice } from "./DirectApnsDevices.ts";

const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const device = (overrides: Partial<StoredPushDevice> = {}): StoredPushDevice => ({
  deviceId: "iphone",
  apnsToken: "ab".repeat(32),
  apsEnvironment: "sandbox",
  bundleId: "com.example.t3code",
  platform: "ios",
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
  ...overrides,
});

const notification = {
  title: "Fix the bug",
  body: "Needs approval: Project",
  environmentId: "env-1",
  threadId: "thread-1",
  deepLink: "/threads/env-1/thread-1",
  phase: "waiting_for_approval",
  updatedAt: "2026-09-04T11:59:30.000Z",
};

const ENV = {
  T3CODE_APNS_KEY_ID: "KEY1234567",
  T3CODE_APNS_TEAM_ID: "TEAM123456",
  T3CODE_APNS_PRIVATE_KEY_PATH: "/keys/AuthKey.p8",
};

const fileSystemWith = (files: Record<string, string>) =>
  FileSystem.layerNoop({
    readFileString: (path) =>
      path in files ? Effect.succeed(files[path]!) : Effect.die(`unexpected read of ${path}`),
  });

const secretsWith = (values: Record<string, string> = {}) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(
          name in values ? Option.some(new TextEncoder().encode(values[name]!)) : Option.none(),
        ),
      set: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );

const makeHarness = (options: {
  readonly env?: Record<string, string>;
  readonly secrets?: Record<string, string>;
  readonly respond?: (
    request: DirectApnsClient.ApnsHttp2Request,
  ) => DirectApnsClient.ApnsHttp2Response;
}) => {
  const requests: DirectApnsClient.ApnsHttp2Request[] = [];
  const transport = Layer.succeed(
    DirectApnsClient.DirectApnsTransport,
    DirectApnsClient.DirectApnsTransport.of({
      post: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return options.respond?.(request) ?? { status: 200, body: "" };
        }),
    }),
  );
  const layer = DirectApnsClient.layer.pipe(
    Layer.provide(transport),
    Layer.provide(fileSystemWith({ "/keys/AuthKey.p8": PRIVATE_PEM })),
    Layer.provide(secretsWith(options.secrets)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? ENV }))),
  );
  return { requests, layer };
};

const send = (input: Parameters<DirectApnsClient.DirectApnsClient["Service"]["send"]>[0]) =>
  DirectApnsClient.DirectApnsClient.use((client) => client.send(input));

describe("DirectApnsClient", () => {
  it.effect("posts an alert push to the sandbox host with the APNs headers and payload", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const result = yield* send({ device: device(), notification });
      assert.strictEqual(result.outcome, "sent");
      const [request] = harness.requests;
      assert.strictEqual(request?.origin, "https://api.sandbox.push.apple.com");
      assert.strictEqual(request?.path, `/3/device/${"ab".repeat(32)}`);
      assert.strictEqual(request?.headers["apns-push-type"], "alert");
      assert.strictEqual(request?.headers["apns-topic"], "com.example.t3code");
      assert.strictEqual(request?.headers["apns-priority"], "10");
      assert.match(request?.headers.authorization ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      assert.deepStrictEqual(JSON.parse(request?.body ?? ""), {
        aps: {
          alert: { title: "Fix the bug", body: "Needs approval: Project" },
          sound: "default",
          "thread-id": "env-1/thread-1",
        },
        body: {
          environmentId: "env-1",
          threadId: "thread-1",
          deepLink: "/threads/env-1/thread-1",
          phase: "waiting_for_approval",
          updatedAt: "2026-09-04T11:59:30.000Z",
        },
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("picks the APNs host per device token, not per server", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      yield* send({ device: device({ apsEnvironment: "production" }), notification });
      yield* send({ device: device({ apsEnvironment: "sandbox" }), notification });
      assert.deepStrictEqual(
        harness.requests.map((request) => request.origin),
        ["https://api.push.apple.com", "https://api.sandbox.push.apple.com"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reuses one provider token across pushes", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      yield* send({ device: device(), notification });
      yield* send({ device: device({ deviceId: "ipad" }), notification });
      assert.strictEqual(
        harness.requests[0]?.headers.authorization,
        harness.requests[1]?.headers.authorization,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("is a silent no-op that sends nothing when credentials are not configured", () => {
    const harness = makeHarness({ env: {} });
    return Effect.gen(function* () {
      const client = yield* DirectApnsClient.DirectApnsClient;
      assert.strictEqual(yield* client.isConfigured, false);
      const result = yield* client.send({ device: device(), notification });
      assert.strictEqual(result.outcome, "unconfigured");
      assert.strictEqual(harness.requests.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to credentials in the secret store", () => {
    const harness = makeHarness({
      env: {},
      secrets: {
        "apns-key-id": "KEY1234567",
        "apns-team-id": "TEAM123456",
        "apns-private-key": PRIVATE_PEM,
      },
    });
    return Effect.gen(function* () {
      const result = yield* send({ device: device(), notification });
      assert.strictEqual(result.outcome, "sent");
      assert.strictEqual(harness.requests.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ] as const)("flags the token for removal on %s %s", ([status, reason]) => {
    const harness = makeHarness({ respond: () => ({ status, body: JSON.stringify({ reason }) }) });
    return Effect.gen(function* () {
      const result = yield* send({ device: device(), notification });
      assert.deepStrictEqual(result, { outcome: "rejected", status, reason, removeToken: true });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the token after a transient rejection", () => {
    const harness = makeHarness({
      respond: () => ({ status: 429, body: JSON.stringify({ reason: "TooManyRequests" }) }),
    });
    return Effect.gen(function* () {
      const result = yield* send({ device: device(), notification });
      assert.deepStrictEqual(result, {
        outcome: "rejected",
        status: 429,
        reason: "TooManyRequests",
        removeToken: false,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a transport failure instead of failing the caller", () => {
    const layer = DirectApnsClient.layer.pipe(
      Layer.provide(
        Layer.succeed(
          DirectApnsClient.DirectApnsTransport,
          DirectApnsClient.DirectApnsTransport.of({
            post: () =>
              Effect.fail(new DirectApnsClient.DirectApnsTransportError({ cause: "boom" })),
          }),
        ),
      ),
      Layer.provide(fileSystemWith({ "/keys/AuthKey.p8": PRIVATE_PEM })),
      Layer.provide(secretsWith()),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: ENV }))),
    );
    return Effect.gen(function* () {
      const result = yield* send({ device: device(), notification });
      assert.deepStrictEqual(result, { outcome: "error", removeToken: false });
    }).pipe(Effect.provide(layer));
  });
});

describe("node http2 transport", () => {
  it.live("speaks HTTP/2 and returns the status and body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Array<{ headers: NodeHttp2.IncomingHttpHeaders; body: string }> = [];
        const server = NodeHttp2.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ reason: "BadDeviceToken" }));
          });
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
        const port = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) =>
              server.listen(0, "127.0.0.1", () =>
                resolve((server.address() as { port: number }).port),
              ),
            ),
        );
        const transport = yield* DirectApnsClient.makeNodeHttp2Transport;
        const response = yield* transport.post({
          origin: `http://127.0.0.1:${port}`,
          path: "/3/device/abc",
          headers: { "apns-topic": "com.example.t3code", authorization: "bearer x" },
          body: '{"aps":{}}',
        });
        assert.deepStrictEqual(response, { status: 400, body: '{"reason":"BadDeviceToken"}' });
        assert.strictEqual(seen[0]?.headers[":method"], "POST");
        assert.strictEqual(seen[0]?.headers[":path"], "/3/device/abc");
        assert.strictEqual(seen[0]?.headers["apns-topic"], "com.example.t3code");
        assert.strictEqual(seen[0]?.body, '{"aps":{}}');
      }),
    ),
  );
});
