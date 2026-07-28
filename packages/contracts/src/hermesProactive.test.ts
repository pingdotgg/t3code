import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  HermesNotificationOutboxEntry,
  HermesProactiveEvent,
  HermesProactiveSourceStatus,
} from "./hermesProactive.ts";

const decodeHermesProactiveSourceStatus = Schema.decodeUnknownSync(HermesProactiveSourceStatus);
const decodeHermesProactiveEvent = Schema.decodeUnknownSync(HermesProactiveEvent);
const decodeHermesNotificationOutboxEntry = Schema.decodeUnknownSync(HermesNotificationOutboxEntry);

describe("Hermes proactive contracts", () => {
  it("decodes durable source diagnostics and provenance without claiming exactly-once delivery", () => {
    const source = decodeHermesProactiveSourceStatus({
      sourceId: "hermes-source:1",
      providerInstanceId: "hermes-local",
      profileKey: "default",
      state: "degraded",
      diagnosticCode: "missing_durable_global_cursor",
      missingCapabilities: ["cron.events.global_cursor", "events.stable_ids"],
      checkpointCursor: null,
      checkpointSequence: 0,
      lastCheckedAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    assert.strictEqual(source.state, "degraded");

    const event = decodeHermesProactiveEvent({
      eventId: "hermes-event:1",
      sourceId: source.sourceId,
      externalEventId: "upstream-event:1",
      externalCursor: "cursor:1",
      eventKind: "cron.completed",
      title: "Daily check completed",
      body: "The scheduled check completed.",
      projectId: "project:1",
      threadId: null,
      occurredAt: "2026-07-25T11:59:00.000Z",
      receivedAt: "2026-07-25T12:00:00.000Z",
      provenance: {
        provider: "hermes",
        providerInstanceId: source.providerInstanceId,
        profileKey: source.profileKey,
        sourceId: source.sourceId,
        externalEventId: "upstream-event:1",
        externalCursor: "cursor:1",
        gatewayRevision: "future-revision",
        protocolMajor: 1,
        protocolMinor: 2,
        ingestedAt: "2026-07-25T12:00:00.000Z",
      },
    });
    assert.strictEqual(event.provenance.externalEventId, "upstream-event:1");
  });

  it("models retryable notification delivery separately from source ingestion", () => {
    const entry = decodeHermesNotificationOutboxEntry({
      outboxId: "hermes-outbox:1",
      eventId: "hermes-event:1",
      state: "retry",
      attemptCount: 2,
      availableAt: "2026-07-25T12:02:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: "projection_busy",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:01:00.000Z",
      deliveredAt: null,
    });
    assert.strictEqual(entry.state, "retry");
    assert.strictEqual(entry.attemptCount, 2);
  });
});
