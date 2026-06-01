import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  cloudflareAccountId: "account-id",
  cloudflareZoneId: "zone-id",
  cloudflareApiToken: Redacted.make("api-token"),
});

function decodeBody(request: HttpClientRequest.HttpClientRequest): unknown {
  return request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : null;
}

function expectedManagedHostname(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `tunnels-env-abc-${hash}.t3code.test`;
}

function expectedManagedTunnelName(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `t3-code-env-abc-${hash}`;
}

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a Cloudflare tunnel endpoint and connector token", () => {
    const calls: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
      readonly authorization: string | undefined;
    }> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push({
          method: request.method,
          url: request.url,
          body: decodeBody(request),
          authorization: request.headers.authorization,
        });
        if (request.url.includes("/cfd_tunnel?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/token")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: "connector-token" }, { status: 200 }),
          );
        }
        if (request.url.includes("/dns_records?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/dns_records")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/configurations")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true }, { status: 200 }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { success: true, result: { id: "tunnel-id", name: "tunnel-name" } },
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const hostname = expectedManagedHostname("env_ABC");
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(result).toEqual({
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: "tunnel-name",
        },
      });
      expect(calls.map((call) => call.method)).toEqual([
        "GET",
        "POST",
        "PUT",
        "GET",
        "POST",
        "GET",
      ]);
      expect(calls.every((call) => call.authorization === "Bearer api-token")).toBe(true);
      expect(calls[2]?.body).toMatchObject({
        config: {
          ingress: [
            {
              hostname,
              service: "http://127.0.0.1:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
      expect(calls[0]?.url).toContain(
        `name=${expectedManagedTunnelName("env_ABC")}&is_deleted=false`,
      );
    }).pipe(
      Effect.provide(
        ManagedEndpointProvider.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
        ),
      ),
    );
  });

  it.effect(
    "normalizes unusual environment ids before using them in Cloudflare tunnel names",
    () => {
      const calls: Array<{
        readonly method: string;
        readonly url: string;
        readonly body: unknown;
      }> = [];
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => {
          calls.push({
            method: request.method,
            url: request.url,
            body: decodeBody(request),
          });
          if (request.url.includes("/cfd_tunnel?")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, result: [] }, { status: 200 }),
            );
          }
          if (request.url.endsWith("/token")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, result: "connector-token" }, { status: 200 }),
            );
          }
          if (request.url.includes("/dns_records?")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, result: [] }, { status: 200 }),
            );
          }
          if (request.url.endsWith("/dns_records") || request.url.endsWith("/configurations")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true }, { status: 200 }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { success: true, result: { id: "tunnel-id", name: "normalized-name" } },
              { status: 200 },
            ),
          );
        });

      return Effect.gen(function* () {
        const environmentId = "ENV With Spaces/../Symbols!" + "x".repeat(80);
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        yield* provider.provision({
          environmentId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });

        const listUrl = calls[0]?.url ?? "";
        const createBody = calls[1]?.body;
        const requestedName = new URL(listUrl).searchParams.get("name");
        expect(requestedName).toMatch(/^t3-code-env-with-spaces-symbols-x+-[a-f0-9]{16}$/);
        expect(requestedName?.length).toBeLessThanOrEqual(89);
        const configBody = calls.find((call) => call.url.endsWith("/configurations"))?.body;
        expect(configBody).toMatchObject({
          config: {
            ingress: [
              {
                hostname: expect.stringMatching(
                  /^tunnels-env-with-spaces-symbols-x+-[a-f0-9]{16}\.t3code\.test$/,
                ),
              },
              { service: "http_status:404" },
            ],
          },
        });
        const hostname = (
          configBody as
            | {
                readonly config?: {
                  readonly ingress?: readonly [{ readonly hostname?: unknown }, unknown];
                };
              }
            | undefined
        )?.config?.ingress?.[0]?.hostname;
        expect(
          typeof hostname === "string" ? hostname.split(".")[0]?.length : 0,
        ).toBeLessThanOrEqual(63);
        expect(createBody).toMatchObject({
          name: requestedName,
          config_src: "cloudflare",
        });
      }).pipe(
        Effect.provide(
          ManagedEndpointProvider.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
          ),
        ),
      );
    },
  );

  it.effect("formats IPv6 loopback origins as valid Cloudflare ingress service URLs", () => {
    const calls: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
    }> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push({
          method: request.method,
          url: request.url,
          body: decodeBody(request),
        });
        if (request.url.includes("/cfd_tunnel?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/token")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: "connector-token" }, { status: 200 }),
          );
        }
        if (request.url.includes("/dns_records?")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, result: [] }, { status: 200 }),
          );
        }
        if (request.url.endsWith("/dns_records") || request.url.endsWith("/configurations")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true }, { status: 200 }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { success: true, result: { id: "tunnel-id", name: "normalized-name" } },
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        environmentId: "env-ipv6",
        origin: { localHttpHost: "::1", localHttpPort: 3773 },
      });

      expect(calls[2]?.body).toMatchObject({
        config: {
          ingress: [
            {
              service: "http://[::1]:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
    }).pipe(
      Effect.provide(
        ManagedEndpointProvider.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
        ),
      ),
    );
  });

  it.effect("rejects non-loopback managed endpoint origins before calling Cloudflare", () => {
    const calls: Array<HttpClientRequest.HttpClientRequest> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, result: [] }, { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "192.168.1.10", localHttpPort: 3773 },
        }),
      );

      expect(calls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(
      Effect.provide(
        ManagedEndpointProvider.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
        ),
      ),
    );
  });

  it.effect("rejects invalid managed endpoint origin ports before calling Cloudflare", () => {
    const calls: Array<HttpClientRequest.HttpClientRequest> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        calls.push(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, result: [] }, { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 65_536 },
        }),
      );

      expect(calls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(
      Effect.provide(
        ManagedEndpointProvider.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
        ),
      ),
    );
  });

  it.effect("fails provisioning when Cloudflare returns a 2xx application error", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              success: false,
              result: [],
              errors: [{ code: 10_000, message: "Cloudflare application failure" }],
            },
            { status: 200 },
          ),
        ),
      );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error._tag).toBe("ManagedEndpointProvisioningFailed");
      expect(error.cause).toMatchObject({
        success: false,
        errors: [{ message: "Cloudflare application failure" }],
      });
    }).pipe(
      Effect.provide(
        ManagedEndpointProvider.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
        ),
      ),
    );
  });
});
