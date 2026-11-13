// @effect-diagnostics nodeBuiltinImport:off -- Exercise the Node network boundary without external requests.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttps from "node:https";
import type * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Transport from "./RunWebhookTransport.ts";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const endpoint: Transport.RunWebhookEndpoint = {
  id: "bot",
  sessionId: "client",
  url: Redacted.make("https://hooks.example.com/completion"),
  secret: Redacted.make("test-only-signing-secret-with-32-bytes"),
  fingerprint: "test",
};
const dnsLookup = vi.mocked(
  NodeDnsPromises.lookup as (
    host: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>,
);
const setup = () => {
  dnsLookup.mockReset();
  vi.mocked(NodeHttps.request).mockReset();
  dnsLookup.mockImplementation(async () => [{ address: "8.8.8.8", family: 4 }]);
};

it("rejects non-HTTPS, credentials, query strings, fragments, nonstandard ports and IP spellings", () => {
  for (const url of [
    "http://hooks.example.com/",
    "file:///etc/passwd",
    "https://user:pass@hooks.example.com/",
    "https://hooks.example.com/?secret=x",
    "https://hooks.example.com/#secret",
    "https://hooks.example.com/#",
    "https://hooks.example.com/?",
    "https://hooks.example.com:8443/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://hooks.example.com./",
    "invalid",
  ])
    expect(Transport.validateWebhookUrl(url), url).toBeUndefined();
  expect(Transport.validateWebhookUrl("https://hooks.example.com:443/completion")?.href).toBe(
    "https://hooks.example.com/completion",
  );
});

it("blocks special-use IPv4, translated and nonglobal IPv6, and permits public addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "2606:4700::1%lo0",
    "invalid",
  ])
    expect(Transport.isPublicWebhookAddress(address), address).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    expect(Transport.isPublicWebhookAddress(address), address).toBe(true);
});

it.effect(
  "rejects mixed public/private DNS answers before opening a socket and sanitizes lookup failures",
  () => {
    setup();
    return Effect.gen(function* () {
      const transport = yield* Transport.RunWebhookTransport;
      for (const answers of [
        [],
        [{ address: "127.0.0.1", family: 4 }],
        [
          { address: "8.8.8.8", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      ]) {
        dnsLookup.mockImplementation(async () => answers);
        expect(yield* transport.send(endpoint, "{}", 1).pipe(Effect.flip)).toMatchObject({
          reason: "destination",
        });
      }
      dnsLookup.mockRejectedValue(new Error("private URL and secret"));
      const error = yield* transport.send(endpoint, "{}", 1).pipe(Effect.flip);
      expect(String(error)).not.toContain("private URL");
      expect(NodeHttps.request).not.toHaveBeenCalled();
    }).pipe(Effect.provide(Transport.layer));
  },
);

it.effect(
  "pins checked DNS addresses, signs exact bytes and rejects redirects without reading their body",
  () => {
    setup();
    return Effect.gen(function* () {
      const transport = yield* Transport.RunWebhookTransport;
      const body = '{"status":"completed","text":"é"}';
      for (const status of [204, 302, 500]) {
        let options: NodeHttps.RequestOptions | undefined;
        const response = { statusCode: status, destroy: vi.fn() };
        const request = Object.assign(new NodeEvents.EventEmitter(), {
          end: vi.fn(),
          destroy: vi.fn(),
        });
        vi.mocked(NodeHttps.request).mockImplementation((_url, opts, callback) => {
          options = opts;
          request.end.mockImplementation(() => {
            callback?.(response as unknown as NodeHttp.IncomingMessage);
          });
          return request as unknown as NodeHttp.ClientRequest;
        });
        expect(yield* transport.send(endpoint, body, 123).pipe(Effect.isSuccess)).toBe(
          status === 204,
        );
        const signature = NodeCrypto.createHmac("sha256", Redacted.value(endpoint.secret))
          .update(`123.${body}`)
          .digest("hex");
        expect(options?.headers).toMatchObject({
          "t3-webhook-timestamp": "123",
          "t3-webhook-signature": `v1=${signature}`,
          "content-length": Buffer.byteLength(body),
        });
        expect(options?.agent).toBe(false);
        const lookedUp = vi.fn();
        options?.lookup?.("hooks.example.com", { all: true }, lookedUp);
        expect(lookedUp).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
        expect(request.end).toHaveBeenCalledWith(body);
        expect(response.destroy).toHaveBeenCalled();
      }
      expect(NodeDnsPromises.lookup).toHaveBeenCalledTimes(3);
      expect(NodeHttps.request).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(Transport.layer));
  },
);

it.effect("bounds hung requests and destroys the socket when the deadline expires", () => {
  setup();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const request = Object.assign(new NodeEvents.EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn(),
    });
    vi.mocked(NodeHttps.request).mockImplementation(
      () => request as unknown as NodeHttp.ClientRequest,
    );
    const transport = yield* Transport.RunWebhookTransport;
    request.end.mockImplementation(() => {
      Deferred.doneUnsafe(started, Effect.void);
    });
    const sending = yield* transport.send(endpoint, "{}", 1).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    expect(yield* Fiber.join(sending).pipe(Effect.flip)).toMatchObject({ reason: "network" });
    expect(request.destroy).toHaveBeenCalled();
  }).pipe(Effect.provide(Transport.layer));
});

it.effect(
  "loads a client-bound allowlist without exposing secrets, and fails closed on invalid configuration",
  () =>
    Effect.gen(function* () {
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      for (const config of [
        [
          {
            id: "bot",
            sessionId: "client",
            url: "https://hooks.example.com/",
            secretEnv: "TEST_WEBHOOK_KEY",
          },
        ],
        [
          {
            id: "bot",
            sessionId: "client",
            url: "http://hooks.example.com/",
            secretEnv: "TEST_WEBHOOK_KEY",
          },
        ],
        [
          {
            id: "bot",
            sessionId: "client",
            url: "https://hooks.example.com/",
            secretEnv: "MISSING_KEY",
          },
        ],
      ]) {
        const load = Transport.RunWebhookEndpoints.use((value) =>
          Effect.succeed(value.endpoints),
        ).pipe(
          Effect.provide(Transport.layerEndpoints),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              T3CODE_RUN_WEBHOOKS: yield* encode(config),
              TEST_WEBHOOK_KEY: Redacted.value(endpoint.secret),
            }),
          ),
        );
        if (config[0]?.url.startsWith("https:") && config[0].secretEnv === "TEST_WEBHOOK_KEY") {
          const endpoints = yield* load;
          expect(endpoints[0]?.sessionId).toBe("client");
          expect(String(endpoints[0]?.secret)).not.toContain(Redacted.value(endpoint.secret));
        } else {
          const error = yield* load.pipe(Effect.flip);
          expect(error).toMatchObject({
            reason: "configuration",
            entryId: "bot",
            check: config[0]?.secretEnv === "MISSING_KEY" ? "secret" : "url",
          });
          expect(error.message).not.toContain(config[0]!.url);
          expect(error.message).not.toContain(Redacted.value(endpoint.secret));
        }
      }
    }),
);
