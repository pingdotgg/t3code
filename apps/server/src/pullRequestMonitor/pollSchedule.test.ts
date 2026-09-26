import { assert, it } from "@effect/vitest";

import {
  HOST_COOLDOWN_BASE_MS,
  HOST_COOLDOWN_MAX_MS,
  POLL_ACTIVE_MS,
  POLL_BATCH_LIMIT,
  POLL_BASE_MS,
  POLL_ERROR_BASE_MS,
  POLL_READY_MS,
  pollDelayMs,
  rateLimitCooldownMs,
} from "./pollSchedule.ts";

it("uses sustainable polling intervals for open pull requests", () => {
  assert.strictEqual(POLL_BATCH_LIMIT, 1);
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: null,
        failureCount: 0,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_BASE_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: {
          ready: false,
          label: "blocked",
          blockers: [{ kind: "check-pending" }],
        },
        failureCount: 0,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_ACTIVE_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: {
          ready: false,
          label: "blocked",
          blockers: [{ kind: "mergeability", detail: "unknown" }],
        },
        failureCount: 0,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_ACTIVE_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: {
          ready: false,
          label: "blocked",
          blockers: [{ kind: "required-check-coverage-unknown" }],
        },
        failureCount: 0,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_BASE_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: null,
        failureCount: 0,
        hadActionableEvents: true,
      },
      0.5,
    ),
    POLL_ACTIVE_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: {
          ready: true,
          label: "ready-to-merge",
          blockers: [],
        },
        failureCount: 0,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_READY_MS,
  );
  assert.strictEqual(
    pollDelayMs(
      {
        readiness: null,
        failureCount: 1,
        hadActionableEvents: false,
      },
      0.5,
    ),
    POLL_ERROR_BASE_MS,
  );
});

it("backs a rate-limited host off exponentially", () => {
  assert.strictEqual(rateLimitCooldownMs(1), HOST_COOLDOWN_BASE_MS);
  assert.strictEqual(rateLimitCooldownMs(2), HOST_COOLDOWN_BASE_MS * 2);
  assert.strictEqual(rateLimitCooldownMs(3), HOST_COOLDOWN_BASE_MS * 4);
  assert.strictEqual(rateLimitCooldownMs(99), HOST_COOLDOWN_MAX_MS);
});
