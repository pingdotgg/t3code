import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { testRelayConfiguration } from "../testRelayConfiguration.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
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
  fcm: null,
  fcmDeliveryEnabled: false,
  fcmDeliveryJobSigningSecret: Redacted.make("fcm-job-secret"),
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  managedEndpointNamespace: "dev_julius",
});

interface TunnelCall {
  readonly operation: "list" | "create" | "putConfiguration" | "getToken" | "delete";
  readonly input: unknown;
}

interface DnsCall {
  readonly operation: "listRecords" | "createRecord" | "updateRecord" | "deleteRecord";
  readonly input: unknown;
}

interface AllocationCall {
  readonly operation: "get" | "reserve" | "recordTunnel" | "recordDns" | "markReady" | "remove";
  readonly input: unknown;
}

function allocationKey(input: { readonly userId: string; readonly environmentId: string }) {
  return `${input.userId}:${input.environmentId}`;
}

function makeTunnelClient(calls: TunnelCall[] = []) {
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: [] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        return { id: "tunnel-id", name: request.name };
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
      }),
  });
}

function makePersistentTunnelClient(calls: TunnelCall[] = []) {
  let tunnel: { readonly id: string; readonly name: string } | null = null;
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: tunnel === null ? [] : [tunnel] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        tunnel = { id: "tunnel-id", name: request.name };
        return tunnel;
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
        tunnel = null;
      }),
  });
}

function makeDnsClient(
  calls: DnsCall[] = [],
  records: ReadonlyArray<{ readonly id: string }> = [],
) {
  let currentRecords = [...records];
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.sync(() => {
        calls.push({ operation: "listRecords", input: hostname });
        return currentRecords;
      }),
    createRecord: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "createRecord", input: request });
        const record = { id: "created-record-id" };
        currentRecords = [record];
        return record;
      }),
    updateRecord: (dnsRecordId, request) =>
      Effect.gen(function* () {
        calls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        if (!currentRecords.some((record) => record.id === dnsRecordId)) {
          return yield* new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation: "update-record",
            hostname: request.name,
            dnsRecordId,
            cause: { _tag: "NotFound", dnsRecordId },
          });
        }
      }),
    deleteRecord: (dnsRecordId) =>
      Effect.sync(() => {
        calls.push({ operation: "deleteRecord", input: dnsRecordId });
        currentRecords = currentRecords.filter((record) => record.id !== dnsRecordId);
      }),
  });
}

function makeAllocations(calls: AllocationCall[] = []) {
  const allocations = new Map<string, ManagedEndpointAllocations.ManagedEndpointAllocation>();
  return ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "get", input });
        return allocations.get(allocationKey(input)) ?? null;
      }),
    reserve: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "reserve", input });
        const allocation = allocations.get(allocationKey(input)) ?? {
          ...input,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
        };
        allocations.set(allocationKey(input), allocation);
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordTunnel", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation !== undefined) {
          allocations.set(allocationKey(input), { ...allocation, tunnelId: input.tunnelId });
        }
      }),
    recordDns: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordDns", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation !== undefined) {
          allocations.set(allocationKey(input), { ...allocation, dnsRecordId: input.dnsRecordId });
        }
      }),
    markReady: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "markReady", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation !== undefined) {
          allocations.set(allocationKey(input), {
            ...allocation,
            readyAt: "2026-06-02T00:00:00.000Z",
          });
        }
      }),
    remove: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "remove", input });
        allocations.delete(allocationKey(input));
      }),
  });
}

function providerLayer(
  tunnelClient = makeTunnelClient(),
  dnsClient = makeDnsClient(),
  allocations = makeAllocations(),
) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient)),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, allocations),
    ),
  );
}

function expectedManagedHostname(environmentId: string, userId = "user_ABC"): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${userId}:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `dev-julius-${hash}.t3code.test`;
}

function expectedManagedTunnelName(environmentId: string, userId = "user_ABC"): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${userId}:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `t3coderelay-managedendpoint-dev-julius-${hash}`;
}

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a Cloudflare tunnel endpoint and connector token", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];

    return Effect.gen(function* () {
      const hostname = expectedManagedHostname("env_ABC");
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user_ABC",
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
          tunnelName: expectedManagedTunnelName("env_ABC"),
        },
      });
      expect(dnsCalls).toEqual([
        { operation: "listRecords", input: hostname },
        {
          operation: "createRecord",
          input: {
            type: "CNAME",
            name: hostname,
            content: "tunnel-id.cfargotunnel.com",
            ttl: 1,
            proxied: true,
          },
        },
      ]);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
      expect(tunnelCalls[2]?.input).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              hostname,
              service: "http://127.0.0.1:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
      expect(tunnelCalls[0]?.input).toEqual({
        name: expectedManagedTunnelName("env_ABC"),
        isDeleted: false,
      });
      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
      ]);
    }).pipe(
      Effect.provide(
        providerLayer(
          makeTunnelClient(tunnelCalls),
          makeDnsClient(dnsCalls),
          makeAllocations(allocationCalls),
        ),
      ),
    );
  });

  it.effect("uses stage-scoped stable names without leaking unusual environment ids", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const environmentId = "ENV With Spaces/../Symbols!" + "x".repeat(80);
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      const requestedName = (
        tunnelCalls.find((call) => call.operation === "list")?.input as
          | { readonly name?: string }
          | undefined
      )?.name;
      expect(requestedName).toMatch(/^t3coderelay-managedendpoint-dev-julius-[a-f0-9]{16}$/);
      const configBody = (
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input as
          | { readonly tunnelConfig?: unknown }
          | undefined
      )?.tunnelConfig;
      expect(configBody).toMatchObject({
        ingress: [
          {
            hostname: expect.stringMatching(/^dev-julius-[a-f0-9]{16}\.t3code\.test$/),
          },
          { service: "http_status:404" },
        ],
      });
      const hostname = (
        configBody as
          | {
              readonly ingress?: readonly [{ readonly hostname?: unknown }, unknown];
            }
          | undefined
      )?.ingress?.[0]?.hostname;
      expect(typeof hostname === "string" ? hostname.split(".")[0]?.length : 0).toBeLessThanOrEqual(
        63,
      );
      expect(tunnelCalls.find((call) => call.operation === "create")?.input).toMatchObject({
        name: requestedName,
        configSrc: "cloudflare",
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("formats IPv6 loopback origins as valid Cloudflare ingress service URLs", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env-ipv6",
        origin: { localHttpHost: "::1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input,
      ).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              service: "http://[::1]:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("rejects non-loopback managed endpoint origins before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "192.168.1.10", localHttpPort: 3773 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "ManagedEndpointOriginNotAllowed",
          userId: "user_ABC",
          environmentId: "env_ABC",
          host: "192.168.1.10",
          port: 3773,
        });
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("rejects invalid managed endpoint origin ports before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 65_536 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("reconciles an existing same-host DNS record through the DNS client", () => {
    const dnsCalls: DnsCall[] = [];
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(dnsCalls.map((call) => call.operation)).toEqual(["listRecords", "updateRecord"]);
      expect(dnsCalls[1]?.input).toMatchObject({ dnsRecordId: "existing-record-id" });
    }).pipe(
      Effect.provide(
        providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls, [{ id: "existing-record-id" }])),
      ),
    );
  });

  it.effect("reuses checkpointed resources when provisioning is retried", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      yield* provider.provision(request);

      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
        "list",
        "putConfiguration",
        "getToken",
      ]);
      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "updateRecord",
      ]);
      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("recreates a checkpointed DNS record when it was removed externally", () => {
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const dnsClient = makeDnsClient(dnsCalls);
    const layer = providerLayer(
      makePersistentTunnelClient(),
      dnsClient,
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      yield* dnsClient.deleteRecord("created-record-id");
      yield* provider.provision(request);

      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "deleteRecord",
        "updateRecord",
        "listRecords",
        "createRecord",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not hide non-not-found checkpoint update failures", () => {
    const dnsCalls: DnsCall[] = [];
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "update-record",
      dnsRecordId: "created-record-id",
      cause: new Error("Cloudflare DNS unavailable"),
    });
    let records: ReadonlyArray<{ readonly id: string }> = [];
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: (hostname) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "listRecords", input: hostname });
          return records;
        }),
      createRecord: (request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "createRecord", input: request });
          const record = { id: "created-record-id" };
          records = [record];
          return record;
        }),
      updateRecord: (dnsRecordId, request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        }).pipe(Effect.andThen(Effect.fail(failure))),
      deleteRecord: () => Effect.void,
    });
    const layer = providerLayer(makePersistentTunnelClient(), dnsClient, makeAllocations());

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      const error = yield* Effect.flip(provider.provision(request));

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "ensure-dns-record",
        userId: "user_ABC",
        environmentId: "env_ABC",
      });
      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "updateRecord",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "deprovisions checkpointed DNS and tunnel resources before removing the allocation",
    () => {
      const tunnelCalls: TunnelCall[] = [];
      const dnsCalls: DnsCall[] = [];
      const allocationCalls: AllocationCall[] = [];
      const layer = providerLayer(
        makePersistentTunnelClient(tunnelCalls),
        makeDnsClient(dnsCalls),
        makeAllocations(allocationCalls),
      );

      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
        yield* provider.provision({
          ...key,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });
        yield* provider.deprovision(key);

        expect(dnsCalls.map((call) => call.operation)).toEqual([
          "listRecords",
          "createRecord",
          "deleteRecord",
        ]);
        expect(tunnelCalls.map((call) => call.operation)).toEqual([
          "list",
          "create",
          "putConfiguration",
          "getToken",
          "delete",
        ]);
        expect(allocationCalls.map((call) => call.operation)).toEqual([
          "reserve",
          "recordTunnel",
          "recordDns",
          "markReady",
          "get",
          "remove",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("treats an absent allocation as already deprovisioned", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.deprovision(key);

      expect(tunnelCalls).toEqual([]);
      expect(dnsCalls).toEqual([]);
      expect(allocationCalls).toEqual([{ operation: "get", input: key }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the allocation when tunnel cleanup fails so unlink can retry", () => {
    const allocationCalls: AllocationCall[] = [];
    const tunnelCalls: TunnelCall[] = [];
    let deleteAttempts = 0;
    const failure = new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
      operation: "delete",
      tunnelId: "tunnel-id",
      cause: "Cloudflare tunnel deletion failed",
    });
    const tunnels = makePersistentTunnelClient(tunnelCalls);
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...tunnels,
      delete: (tunnelId) =>
        Effect.gen(function* () {
          tunnelCalls.push({ operation: "delete", input: tunnelId });
          deleteAttempts++;
          if (deleteAttempts === 1) {
            return yield* failure;
          }
        }),
    });
    const layer = providerLayer(tunnelClient, makeDnsClient(), makeAllocations(allocationCalls));

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      const first = yield* Effect.result(provider.deprovision(key));
      expect(first._tag).toBe("Failure");
      if (first._tag === "Failure") {
        expect(first.failure).toMatchObject({
          _tag: "ManagedEndpointDeprovisioningFailed",
          stage: "delete-tunnel",
          userId: key.userId,
          environmentId: key.environmentId,
          tunnelId: "tunnel-id",
        });
        expect(first.failure.cause).toBe(failure);
      }
      yield* provider.deprovision(key);

      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
        "get",
        "get",
        "remove",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats already deleted remote resources as successfully deprovisioned", () => {
    const allocationCalls: AllocationCall[] = [];
    const notFound = { _tag: "NotFound" } as const;
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      delete: () =>
        Effect.fail(
          new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
            operation: "delete",
            tunnelId: "tunnel-id",
            cause: notFound,
          }),
        ),
    });
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      ...makeDnsClient(),
      deleteRecord: () =>
        Effect.fail(
          new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation: "delete-record",
            dnsRecordId: "created-record-id",
            cause: notFound,
          }),
        ),
    });
    const layer = providerLayer(tunnelClient, dnsClient, makeAllocations(allocationCalls));

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      yield* provider.deprovision(key);

      expect(allocationCalls.map((call) => call.operation)).toContain("remove");
    }).pipe(Effect.provide(layer));
  });

  it.effect("scopes managed endpoint resources by user", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_shared",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      yield* provider.provision({
        userId: "user_DEF",
        environmentId: "env_shared",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.filter((call) => call.operation === "list").map((call) => call.input),
      ).toEqual([
        { name: expectedManagedTunnelName("env_shared", "user_ABC"), isDeleted: false },
        { name: expectedManagedTunnelName("env_shared", "user_DEF"), isDeleted: false },
      ]);
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("recovers when DNS creation reports failure after the record became visible", () => {
    const dnsCalls: DnsCall[] = [];
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "create-record",
      hostname: expectedManagedHostname("env_ABC"),
      cause: "ambiguous Cloudflare DNS response",
    });
    let records: ReadonlyArray<{ readonly id: string }> = [];
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: (hostname) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "listRecords", input: hostname });
          return records;
        }),
      createRecord: (request) =>
        Effect.gen(function* () {
          dnsCalls.push({ operation: "createRecord", input: request });
          records = [{ id: "created-record-id" }];
          return yield* failure;
        }),
      updateRecord: (dnsRecordId, request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        }),
      deleteRecord: (dnsRecordId) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "deleteRecord", input: dnsRecordId });
        }),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "listRecords",
        "updateRecord",
      ]);
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), dnsClient)));
  });

  it.effect("reports mismatched tunnel responses without manufacturing a cause", () => {
    const dnsCalls: DnsCall[] = [];
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      create: () => Effect.succeed({ id: "returned-tunnel-id", name: "unexpected-tunnel" }),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "validate-tunnel-response",
        userId: "user_ABC",
        environmentId: "env_ABC",
        hostname: expectedManagedHostname("env_ABC"),
        tunnelName: expectedManagedTunnelName("env_ABC"),
        returnedTunnelId: "returned-tunnel-id",
        returnedTunnelName: "unexpected-tunnel",
      });
      if (error._tag === "ManagedEndpointProvisioningFailed") {
        expect(error.cause).toBeUndefined();
      }
      expect(dnsCalls).toHaveLength(0);
    }).pipe(Effect.provide(providerLayer(tunnelClient, makeDnsClient(dnsCalls))));
  });

  it.effect("fails provisioning when the DNS client fails", () => {
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "list-records",
      hostname: expectedManagedHostname("env_ABC"),
      cause: "Cloudflare DNS failure",
    });
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: () => Effect.fail(failure),
      createRecord: () => Effect.die("unused"),
      updateRecord: () => Effect.die("unused"),
      deleteRecord: () => Effect.die("unused"),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "ensure-dns-record",
        userId: "user_ABC",
        environmentId: "env_ABC",
        hostname: expectedManagedHostname("env_ABC"),
        tunnelName: expectedManagedTunnelName("env_ABC"),
        tunnelId: "tunnel-id",
      });
      if (error._tag === "ManagedEndpointProvisioningFailed") {
        expect(error.cause).toBe(failure);
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), dnsClient)));
  });
});
