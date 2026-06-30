import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthConnectClients from "./AuthConnectClients.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const layer = AuthConnectClients.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const client = {
  label: "Client",
  ipAddress: null,
  userAgent: null,
  deviceType: "desktop",
  os: "macOS",
  browser: null,
} satisfies AuthConnectClients.AuthConnectClientMetadataRecord;

it.effect("clears stale last-seen timestamps when a revoked client re-registers", () =>
  Effect.gen(function* () {
    const clients = yield* AuthConnectClients.AuthConnectClientRepository;
    const clientProofKeyThumbprint = "client-thumbprint";

    yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T12:00:00.000Z"),
    });
    yield* clients.updateStatus({
      clientProofKeyThumbprint,
      status: "approved",
      decidedAt: DateTime.makeUnsafe("2026-06-27T12:01:00.000Z"),
    });
    const seen = yield* clients.markSeen({
      clientProofKeyThumbprint,
      seenAt: DateTime.makeUnsafe("2026-06-27T12:02:00.000Z"),
    });
    expect(Option.isSome(seen) ? seen.value.lastSeenAt : null).not.toBeNull();

    yield* clients.revoke({
      clientProofKeyThumbprint,
      revokedAt: DateTime.makeUnsafe("2026-06-27T12:03:00.000Z"),
    });
    const reregistered = yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T12:04:00.000Z"),
    });

    expect(reregistered.status).toBe("pending");
    expect(reregistered.lastSeenAt).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("resets approval when the same proof key is requested by a different cloud user", () =>
  Effect.gen(function* () {
    const clients = yield* AuthConnectClients.AuthConnectClientRepository;
    const clientProofKeyThumbprint = "client-thumbprint-cloud-user-change";

    yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user-a",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T13:00:00.000Z"),
    });
    yield* clients.updateStatus({
      clientProofKeyThumbprint,
      status: "approved",
      decidedAt: DateTime.makeUnsafe("2026-06-27T13:01:00.000Z"),
    });
    yield* clients.markSeen({
      clientProofKeyThumbprint,
      seenAt: DateTime.makeUnsafe("2026-06-27T13:02:00.000Z"),
    });

    const reregistered = yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user-b",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T13:03:00.000Z"),
    });

    expect(reregistered.cloudUserId).toBe("cloud-user-b");
    expect(reregistered.status).toBe("pending");
    expect(reregistered.approvedAt).toBeNull();
    expect(reregistered.rejectedAt).toBeNull();
    expect(reregistered.lastSeenAt).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("clears the opposite decision timestamp when approval status changes", () =>
  Effect.gen(function* () {
    const clients = yield* AuthConnectClients.AuthConnectClientRepository;
    const clientProofKeyThumbprint = "client-thumbprint-status-flip";

    yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T14:00:00.000Z"),
    });
    const rejected = yield* clients.updateStatus({
      clientProofKeyThumbprint,
      status: "rejected",
      decidedAt: DateTime.makeUnsafe("2026-06-27T14:01:00.000Z"),
    });
    expect(Option.isSome(rejected) ? rejected.value.rejectedAt : null).not.toBeNull();
    expect(Option.isSome(rejected) ? rejected.value.approvedAt : null).toBeNull();

    const approved = yield* clients.updateStatus({
      clientProofKeyThumbprint,
      status: "approved",
      decidedAt: DateTime.makeUnsafe("2026-06-27T14:02:00.000Z"),
    });
    expect(Option.isSome(approved) ? approved.value.approvedAt : null).not.toBeNull();
    expect(Option.isSome(approved) ? approved.value.rejectedAt : null).toBeNull();
  }).pipe(Effect.provide(layer)),
);
