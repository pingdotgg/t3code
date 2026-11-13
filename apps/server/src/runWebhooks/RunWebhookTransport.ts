// @effect-diagnostics nodeBuiltinImport:off -- DNS pinning, address classification and HMAC need Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class RunWebhookTransportError extends Schema.TaggedError<RunWebhookTransportError>()(
  "RunWebhookTransportError",
  {
    reason: Schema.Literals(["configuration", "destination", "dns", "network", "response"]),
    entryId: Schema.optional(Schema.String),
    check: Schema.optional(Schema.Literals(["format", "duplicate-id", "url", "secret"])),
  },
) {
  override get message() {
    return `Run webhook ${this.reason} check failed${this.entryId ? ` for entry ${this.entryId}` : ""}${this.check ? ` (${this.check})` : ""}.`;
  }
}

const EndpointConfig = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  secretEnv: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)),
});

export interface RunWebhookEndpoint {
  readonly id: string;
  readonly sessionId: string;
  readonly url: Redacted.Redacted<string>;
  readonly secret: Redacted.Redacted<string>;
  readonly fingerprint: string;
}

export class RunWebhookEndpoints extends Context.Service<
  RunWebhookEndpoints,
  {
    readonly endpoints: ReadonlyArray<RunWebhookEndpoint>;
  }
>()("t3/runWebhooks/RunWebhookTransport/RunWebhookEndpoints") {}

export const validateWebhookUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#") ||
      url.hostname.endsWith(".") ||
      !url.hostname.includes(".") ||
      NodeNet.isIP(url.hostname) ||
      url.hostname.includes(":")
    )
      return;
    return url;
  } catch {
    return;
  }
};

const blocked = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
const globalV6 = new NodeNet.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

export const isPublicWebhookAddress = (address: string): boolean => {
  const family = NodeNet.isIP(address);
  if (!family || address.includes("%")) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  return !blocked.check(address, type) && (family === 4 || globalV6.check(address, "ipv6"));
};

export const layerEndpoints = Layer.effect(
  RunWebhookEndpoints,
  Effect.gen(function* () {
    const raw = yield* Config.String("T3CODE_RUN_WEBHOOKS").pipe(Config.withDefault("[]"));
    const configs = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(EndpointConfig).check(Schema.isMaxLength(32))),
    )(raw).pipe(
      Effect.mapError(
        () => new RunWebhookTransportError({ reason: "configuration", check: "format" }),
      ),
    );
    const duplicate = configs.find(
      (config, index) => configs.findIndex((entry) => entry.id === config.id) !== index,
    );
    if (duplicate)
      return yield* new RunWebhookTransportError({
        reason: "configuration",
        entryId: duplicate.id,
        check: "duplicate-id",
      });
    const endpoints = yield* Effect.forEach(configs, (config) =>
      Effect.gen(function* () {
        const url = validateWebhookUrl(config.url);
        if (!url)
          return yield* new RunWebhookTransportError({
            reason: "configuration",
            entryId: config.id,
            check: "url",
          });
        const secret = yield* Config.Redacted(config.secretEnv).pipe(
          Effect.mapError(
            () =>
              new RunWebhookTransportError({
                reason: "configuration",
                entryId: config.id,
                check: "secret",
              }),
          ),
        );
        if (Buffer.byteLength(Redacted.value(secret)) < 32)
          return yield* new RunWebhookTransportError({
            reason: "configuration",
            entryId: config.id,
            check: "secret",
          });
        return {
          id: config.id,
          sessionId: config.sessionId,
          url: Redacted.make(url.href),
          secret,
          fingerprint: NodeCrypto.createHash("sha256").update(url.href).digest("hex"),
        };
      }),
    );
    return { endpoints };
  }),
);

export class RunWebhookTransport extends Context.Service<
  RunWebhookTransport,
  {
    readonly send: (
      endpoint: RunWebhookEndpoint,
      body: string,
      timestamp: number,
    ) => Effect.Effect<void, RunWebhookTransportError>;
  }
>()("t3/runWebhooks/RunWebhookTransport") {}

export const layer = Layer.succeed(RunWebhookTransport, {
  send: Effect.fn("RunWebhookTransport.send")(
    function* (endpoint, body, timestamp) {
      const url = validateWebhookUrl(Redacted.value(endpoint.url));
      if (!url) return yield* new RunWebhookTransportError({ reason: "destination" });
      const addresses = yield* Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(url.hostname, { all: true, verbatim: true }),
        catch: () => new RunWebhookTransportError({ reason: "dns" }),
      });
      const own = new NodeNet.BlockList();
      for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
        if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
      }
      if (
        addresses.length === 0 ||
        addresses.some(
          ({ address, family }) =>
            !isPublicWebhookAddress(address) || own.check(address, family === 6 ? "ipv6" : "ipv4"),
        )
      )
        return yield* new RunWebhookTransportError({ reason: "destination" });
      const signature = NodeCrypto.createHmac("sha256", Redacted.value(endpoint.secret))
        .update(`${timestamp}.${body}`)
        .digest("hex");
      yield* Effect.callback<void, RunWebhookTransportError>((resume) => {
        const request = NodeHttps.request(
          url,
          {
            method: "POST",
            agent: false,
            // The connection uses only this lookup's checked addresses; TLS still verifies the hostname.
            lookup: (_hostname, options, callback) =>
              options.all
                ? callback(null, addresses)
                : callback(null, addresses[0]!.address, addresses[0]!.family),
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "t3-webhook-timestamp": String(timestamp),
              "t3-webhook-signature": `v1=${signature}`,
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            response.destroy();
            resume(
              status >= 200 && status < 300
                ? Effect.void
                : Effect.fail(new RunWebhookTransportError({ reason: "response" })),
            );
          },
        );
        request.on("error", () =>
          resume(Effect.fail(new RunWebhookTransportError({ reason: "network" }))),
        );
        request.end(body);
        return Effect.sync(() => request.destroy());
      });
    },
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new RunWebhookTransportError({ reason: "network" })),
    }),
  ),
});
