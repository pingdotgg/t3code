import { assert, describe, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import type { OutboundEventContext } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OutboundConfigError,
  type OutboundTarget,
  WorkflowOutboundConnectionStore,
} from "../Services/WorkflowOutboundConnectionStore.ts";
import { OutboundUrlError, OutboundUrlValidator } from "../outbound/OutboundUrlValidator.ts";
import { WorkflowOutboundDispatcher } from "../Services/WorkflowOutboundDispatcher.ts";
import { makeWorkflowOutboundDispatcherLive } from "./WorkflowOutboundDispatcher.ts";

const ENV_ID = "env-1" as EnvironmentId;

// ---------------------------------------------------------------------------
// Stub HttpClient — records requests, returns a programmable response per call.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly contentType: string | undefined;
}

interface CannedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Virtual delay before the response resolves (used to exercise the timeout). */
  readonly delayMs?: number;
}

interface HttpRecorder {
  requests: Array<RecordedRequest>;
  responses: Array<CannedResponse>;
}

const makeHttpRecorder = (responses: ReadonlyArray<CannedResponse>): HttpRecorder => ({
  requests: [],
  responses: [...responses],
});

const decodeBody = (
  request: HttpClientRequest.HttpClientRequest,
): {
  readonly bodyText: string;
  readonly contentType: string | undefined;
} => {
  const body = request.body as { readonly _tag: string };
  if (body._tag === "Uint8Array") {
    const u8 = body as unknown as { readonly body: Uint8Array; readonly contentType: string };
    return { bodyText: new TextDecoder().decode(u8.body), contentType: u8.contentType };
  }
  return { bodyText: "", contentType: undefined };
};

const stubHttpClientLayer = (recorder: HttpRecorder) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const decoded = decodeBody(request);
        recorder.requests.push({
          url: request.url,
          method: request.method,
          headers: { ...(request.headers as Record<string, string>) },
          bodyText: decoded.bodyText,
          contentType: decoded.contentType,
        });
        const canned = recorder.responses.shift() ?? { status: 200 };
        if (canned.delayMs !== undefined) {
          // Virtual sleep (test clock) so the dispatcher's timeout can win the race.
          yield* Effect.sleep(Duration.millis(canned.delayMs));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(canned.body ?? "", {
            status: canned.status,
            headers: { ...canned.headers },
          }),
        );
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Stub connection store — getTarget resolves to a programmed target or fails.
// ---------------------------------------------------------------------------

const stubConnectionStoreLayer = (byRef: Record<string, OutboundTarget | "missing">) =>
  Layer.succeed(WorkflowOutboundConnectionStore, {
    getTarget: (connectionRef: string) => {
      const entry = byRef[connectionRef];
      if (entry === undefined || entry === "missing") {
        return Effect.fail(
          new OutboundConfigError({ reason: `no connection for ${connectionRef}` }),
        );
      }
      return Effect.succeed(entry);
    },
    create: () => Effect.die("not needed in test"),
    list: () => Effect.die("not needed in test"),
    remove: () => Effect.die("not needed in test"),
  } satisfies WorkflowOutboundConnectionStore["Service"]);

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENV_ID),
  getDescriptor: Effect.die("unsupported descriptor read"),
} as unknown as ServerEnvironment["Service"]) as Layer.Layer<ServerEnvironment>;

// ---------------------------------------------------------------------------
// Validator stub: ok (resolves to the parsed URL) or blocked (fails).
// ---------------------------------------------------------------------------

const okValidator: typeof OutboundUrlValidator.validate = (rawUrl) =>
  Effect.sync(() => new URL(rawUrl));

const blockedValidator: typeof OutboundUrlValidator.validate = () =>
  Effect.fail(new OutboundUrlError({ reason: "blocked host (test)" }));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const sampleContext = (over: Partial<OutboundEventContext> = {}): OutboundEventContext => ({
  trigger: "blocked",
  ticketId: "ticket-1",
  boardId: "board-1",
  title: "Fix the thing",
  status: "blocked",
  fromLane: "impl",
  toLane: "review",
  isTerminal: false,
  reason: "needs help",
  occurredAt: "2026-06-07T00:00:01.000Z",
  ...over,
});

const insertDelivery = (over: {
  readonly deliveryId: string;
  readonly boardId?: string;
  readonly ticketId?: string;
  readonly ruleId?: string;
  readonly eventSequence?: number;
  readonly connectionRef: string;
  readonly formatter?: string;
  readonly context?: OutboundEventContext;
  /** Escape hatch: store this exact string as context_json (e.g. malformed). */
  readonly rawContextJson?: string;
  readonly deliveryState?: string;
  readonly attemptCount?: number;
  readonly nextAttemptAt?: string | null;
  readonly createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ctx = over.context ?? sampleContext();
    // @effect-diagnostics-next-line preferSchemaOverJson:off - serializing the test fixture context into the stored context_json column.
    const contextJson = over.rawContextJson ?? JSON.stringify(ctx);
    yield* sql`
      INSERT INTO workflow_outbound_delivery (
        delivery_id, board_id, ticket_id, rule_id, event_sequence,
        connection_ref, formatter, context_json, delivery_state, attempt_count,
        next_attempt_at, created_at
      ) VALUES (
        ${over.deliveryId},
        ${over.boardId ?? ctx.boardId},
        ${over.ticketId ?? ctx.ticketId},
        ${over.ruleId ?? "r1"},
        ${over.eventSequence ?? 1},
        ${over.connectionRef},
        ${over.formatter ?? "generic"},
        ${contextJson},
        ${over.deliveryState ?? "pending"},
        ${over.attemptCount ?? 0},
        ${over.nextAttemptAt ?? null},
        ${over.createdAt ?? "2026-06-07T00:00:00.000Z"}
      )
    `;
  });

const readDelivery = (deliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly delivery_state: string;
      readonly attempt_count: number;
      readonly next_attempt_at: string | null;
      readonly last_error: string | null;
    }>`
      SELECT
        delivery_state AS "delivery_state",
        attempt_count AS "attempt_count",
        next_attempt_at AS "next_attempt_at",
        last_error AS "last_error"
      FROM workflow_outbound_delivery WHERE delivery_id = ${deliveryId}
    `;
    return rows[0]!;
  });

// MAX_ATTEMPTS is 5 (mirrors the notification dispatcher / source syncer).
const MAX_ATTEMPTS = 5;

// Module-level (non-Effect) ISO→epoch-ms helper for test assertions, so we do
// not construct `new Date()` inside an Effect generator.
const isoToMs = (iso: string): number => Date.parse(iso);

const buildLayer = (input: {
  readonly http: HttpRecorder;
  readonly connections: Record<string, OutboundTarget | "missing">;
  readonly validator?: typeof OutboundUrlValidator.validate;
  readonly webBaseUrl?: string | URL;
  readonly httpTimeoutMs?: number;
}) =>
  makeWorkflowOutboundDispatcherLive({
    validate: input.validator ?? okValidator,
    ...(input.webBaseUrl !== undefined && { webBaseUrl: input.webBaseUrl }),
    ...(input.httpTimeoutMs !== undefined && { httpTimeoutMs: input.httpTimeoutMs }),
  }).pipe(
    Layer.provideMerge(stubHttpClientLayer(input.http)),
    Layer.provideMerge(stubConnectionStoreLayer(input.connections)),
    Layer.provideMerge(serverEnvironmentLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const WEBHOOK_TARGET: OutboundTarget = { kind: "webhook", url: "https://hooks.example.com/x" };
const SLACK_TARGET: OutboundTarget = { kind: "slack", url: "https://hooks.slack.com/services/x" };

describe.sequential("WorkflowOutboundDispatcher", () => {
  it.effect("delivers a pending generic row → sent, with Idempotency-Key + Content-Type", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({ deliveryId: "dlv-1", connectionRef: "conn-1" });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-1");
      assert.strictEqual(row.delivery_state, "sent");
      assert.strictEqual(http.requests.length, 1);
      const req = http.requests[0]!;
      assert.strictEqual(req.method, "POST");
      assert.strictEqual(req.url, WEBHOOK_TARGET.url);
      assert.strictEqual(req.headers["idempotency-key"], "dlv-1");
      assert.strictEqual(req.contentType, "application/json");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the POSTed body for assertions in a test.
      const sent = JSON.parse(req.bodyText) as Record<string, unknown>;
      assert.strictEqual(sent.event, "blocked");
      assert.deepStrictEqual(sent.board, { id: "board-1" });
      const ticket = sent.ticket as Record<string, unknown>;
      assert.strictEqual(ticket.id, "ticket-1");
      assert.strictEqual(ticket.title, "Fix the thing");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect(
    "HTTP 500 → attempt_count=1, stays pending with future next_attempt_at + last_error",
    () => {
      const http = makeHttpRecorder([{ status: 500, body: "boom" }]);
      return Effect.gen(function* () {
        yield* insertDelivery({ deliveryId: "dlv-2", connectionRef: "conn-1" });
        const dispatcher = yield* WorkflowOutboundDispatcher;
        const now = yield* Clock.currentTimeMillis;
        yield* dispatcher.sweep();

        const row = yield* readDelivery("dlv-2");
        assert.strictEqual(row.delivery_state, "pending");
        assert.strictEqual(row.attempt_count, 1);
        assert.isNotNull(row.next_attempt_at);
        assert.isNotNull(row.last_error);
        assert.isTrue(isoToMs(row.next_attempt_at!) > now, "next_attempt_at must be in the future");
      }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
    },
  );

  it.effect("at MAX_ATTEMPTS-1 + HTTP 500 → row becomes 'failed'", () => {
    const http = makeHttpRecorder([{ status: 500 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-3",
        connectionRef: "conn-1",
        attemptCount: MAX_ATTEMPTS - 1,
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-3");
      assert.strictEqual(row.delivery_state, "failed");
      assert.strictEqual(row.attempt_count, MAX_ATTEMPTS);
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect("HTTP 429 Retry-After: 120 → next_attempt_at ≈ now + 120s", () => {
    const http = makeHttpRecorder([{ status: 429, headers: { "retry-after": "120" } }]);
    return Effect.gen(function* () {
      yield* insertDelivery({ deliveryId: "dlv-4", connectionRef: "conn-1" });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      const now = yield* Clock.currentTimeMillis;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-4");
      assert.strictEqual(row.delivery_state, "pending");
      assert.strictEqual(row.attempt_count, 1);
      const delta = isoToMs(row.next_attempt_at!) - now;
      // within a small tolerance of 120_000ms
      assert.isTrue(Math.abs(delta - 120_000) <= 2_000, `expected ≈120s, got ${delta}ms`);
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect(
    "isolation: one ok + one dangling-conn row → ok sent, missing backs off, sweep ok",
    () => {
      const http = makeHttpRecorder([{ status: 200 }]);
      return Effect.gen(function* () {
        yield* insertDelivery({
          deliveryId: "dlv-ok",
          connectionRef: "conn-ok",
          ticketId: "t-ok",
          eventSequence: 1,
          ruleId: "r-ok",
        });
        yield* insertDelivery({
          deliveryId: "dlv-miss",
          connectionRef: "conn-miss",
          ticketId: "t-miss",
          eventSequence: 2,
          ruleId: "r-miss",
          createdAt: "2026-06-07T00:00:01.000Z",
        });
        const dispatcher = yield* WorkflowOutboundDispatcher;
        // sweep must not throw even though one row's connection is missing.
        yield* dispatcher.sweep();

        assert.strictEqual((yield* readDelivery("dlv-ok")).delivery_state, "sent");
        const miss = yield* readDelivery("dlv-miss");
        assert.strictEqual(miss.delivery_state, "pending");
        assert.strictEqual(miss.attempt_count, 1);
        assert.isNotNull(miss.next_attempt_at);
        // Only one POST issued (the ok row); the missing one never reached HTTP.
        assert.strictEqual(http.requests.length, 1);
      }).pipe(
        Effect.provide(
          buildLayer({
            http,
            connections: { "conn-ok": WEBHOOK_TARGET, "conn-miss": "missing" },
          }),
        ),
      );
    },
  );

  it.effect("validator blocks the host → row backs off, NO POST issued", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({ deliveryId: "dlv-ssrf", connectionRef: "conn-1" });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-ssrf");
      assert.strictEqual(row.delivery_state, "pending");
      assert.strictEqual(row.attempt_count, 1);
      assert.isNotNull(row.last_error);
      assert.strictEqual(http.requests.length, 0, "no POST when host is blocked");
    }).pipe(
      Effect.provide(
        buildLayer({
          http,
          connections: { "conn-1": WEBHOOK_TARGET },
          validator: blockedValidator,
        }),
      ),
    );
  });

  it.effect("a row with future next_attempt_at is NOT picked up", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      const future = "2999-01-01T00:00:00.000Z";
      yield* insertDelivery({
        deliveryId: "dlv-future",
        connectionRef: "conn-1",
        nextAttemptAt: future,
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-future");
      assert.strictEqual(row.delivery_state, "pending");
      assert.strictEqual(row.attempt_count, 0);
      assert.strictEqual(row.next_attempt_at, future);
      assert.strictEqual(http.requests.length, 0, "future row not swept");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect("slack row: webBaseUrl set → absolute button url; unset → no actions block", () => {
    const httpWithBase = makeHttpRecorder([{ status: 200 }]);
    const httpNoBase = makeHttpRecorder([{ status: 200 }]);
    const base = "https://app.t3.example.com";
    const slackCtx = sampleContext({ boardId: "board-9", ticketId: "ticket-9" });

    const withBase = Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-slack-base",
        connectionRef: "conn-slack",
        formatter: "slack",
        context: slackCtx,
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      assert.strictEqual(httpWithBase.requests.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the POSTed Slack body for assertions in a test.
      const sent = JSON.parse(httpWithBase.requests[0]!.bodyText) as {
        readonly blocks: ReadonlyArray<Record<string, unknown>>;
      };
      const actions = sent.blocks.find((b) => b.type === "actions");
      assert.isDefined(actions, "actions block present when webBaseUrl is set");
      const elements = actions!.elements as ReadonlyArray<Record<string, unknown>>;
      assert.strictEqual(
        elements[0]!.url,
        `${base}/${encodeURIComponent(ENV_ID)}/board?boardId=${encodeURIComponent(
          "board-9",
        )}&ticket=${encodeURIComponent("ticket-9")}`,
      );
    }).pipe(
      Effect.provide(
        buildLayer({
          http: httpWithBase,
          connections: { "conn-slack": SLACK_TARGET },
          webBaseUrl: base,
        }),
      ),
    );

    const noBase = Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-slack-nobase",
        connectionRef: "conn-slack",
        formatter: "slack",
        context: slackCtx,
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      assert.strictEqual(httpNoBase.requests.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the POSTed Slack body for assertions in a test.
      const sent = JSON.parse(httpNoBase.requests[0]!.bodyText) as {
        readonly blocks: ReadonlyArray<Record<string, unknown>>;
      };
      const actions = sent.blocks.find((b) => b.type === "actions");
      assert.isUndefined(actions, "no actions block when webBaseUrl is unset");
    }).pipe(
      Effect.provide(buildLayer({ http: httpNoBase, connections: { "conn-slack": SLACK_TARGET } })),
    );

    return Effect.gen(function* () {
      yield* withBase;
      yield* noBase;
    });
  });

  it.effect(
    "malformed context_json → that row is parked failed; a SECOND healthy row still delivers",
    () => {
      // Two due rows, poison sorts FIRST (earlier created_at). The poison row must
      // NOT abort the sweep — the healthy row must still get POSTed in the SAME sweep.
      const http = makeHttpRecorder([{ status: 200 }]);
      return Effect.gen(function* () {
        yield* insertDelivery({
          deliveryId: "dlv-poison",
          connectionRef: "conn-1",
          ticketId: "t-poison",
          eventSequence: 1,
          ruleId: "r-poison",
          rawContextJson: "{not json",
          createdAt: "2026-06-07T00:00:00.000Z",
        });
        yield* insertDelivery({
          deliveryId: "dlv-healthy",
          connectionRef: "conn-1",
          ticketId: "t-healthy",
          eventSequence: 2,
          ruleId: "r-healthy",
          createdAt: "2026-06-07T00:00:01.000Z",
        });
        const dispatcher = yield* WorkflowOutboundDispatcher;
        // Must not throw despite the poison row.
        yield* dispatcher.sweep();

        // Poison row is non-retryable → parked 'failed', and it issued NO POST.
        const poison = yield* readDelivery("dlv-poison");
        assert.strictEqual(poison.delivery_state, "failed");
        assert.isNotNull(poison.last_error);

        // The healthy row was still delivered in the same sweep — isolation proof.
        const healthy = yield* readDelivery("dlv-healthy");
        assert.strictEqual(healthy.delivery_state, "sent");
        assert.strictEqual(http.requests.length, 1, "exactly one POST (the healthy row)");
        assert.strictEqual(http.requests[0]!.headers["idempotency-key"], "dlv-healthy");
      }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
    },
  );

  it.effect("unknown formatter → row parked failed, NO POST", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-badfmt",
        connectionRef: "conn-1",
        formatter: "teams", // not in {generic, slack}
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-badfmt");
      assert.strictEqual(row.delivery_state, "failed");
      assert.strictEqual(row.attempt_count, 0, "non-retryable: attempt_count not burned");
      assert.isNotNull(row.last_error);
      assert.strictEqual(http.requests.length, 0, "unknown formatter never POSTs");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  // it.live (real clock): the dispatcher's Effect.timeoutOrElse and the stub's
  // delay both rely on real time. With a 20ms test timeout and a 5s stub hang,
  // the timeout wins at ~20ms and interrupts the hung sleep — no long wait.
  it.live("a hung target times out → row backs off (retryable), sweep continues", () => {
    const http = makeHttpRecorder([{ status: 200, delayMs: 5_000 }, { status: 200 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-hang",
        connectionRef: "conn-1",
        ticketId: "t-hang",
        eventSequence: 1,
        ruleId: "r-hang",
        createdAt: "2026-06-07T00:00:00.000Z",
      });
      yield* insertDelivery({
        deliveryId: "dlv-after",
        connectionRef: "conn-1",
        ticketId: "t-after",
        eventSequence: 2,
        ruleId: "r-after",
        createdAt: "2026-06-07T00:00:01.000Z",
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      // Hung row backed off (retryable), still pending with a future next_attempt_at.
      const hung = yield* readDelivery("dlv-hang");
      assert.strictEqual(hung.delivery_state, "pending");
      assert.strictEqual(hung.attempt_count, 1);
      assert.isNotNull(hung.next_attempt_at);
      assert.isNotNull(hung.last_error);

      // The following row still got delivered — sweep did not freeze.
      const after = yield* readDelivery("dlv-after");
      assert.strictEqual(after.delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET }, httpTimeoutMs: 20 }),
      ),
    );
  });

  it.effect(
    "3xx redirect response → row backs off (retryable), NOT sent, and NO follow request is made",
    () => {
      // SSRF hardening: with redirect-following disabled, a webhook that responds
      // with a 302 + Location pointing at a private host must NOT be followed. The
      // stub returns the 3xx itself (mirroring fetch `redirect:"manual"`); the
      // dispatcher must treat it as a non-2xx backoff and issue exactly ONE POST.
      const http = makeHttpRecorder([
        { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
      ]);
      return Effect.gen(function* () {
        yield* insertDelivery({ deliveryId: "dlv-redir", connectionRef: "conn-1" });
        const dispatcher = yield* WorkflowOutboundDispatcher;
        const now = yield* Clock.currentTimeMillis;
        yield* dispatcher.sweep();

        const row = yield* readDelivery("dlv-redir");
        assert.strictEqual(row.delivery_state, "pending", "3xx must not be treated as sent");
        assert.strictEqual(row.attempt_count, 1);
        assert.isNotNull(row.next_attempt_at);
        assert.isTrue(
          isoToMs(row.next_attempt_at!) > now,
          "next_attempt_at must be in the future (backoff)",
        );
        assert.isNotNull(row.last_error);
        // Exactly one POST — the redirect target was never requested.
        assert.strictEqual(http.requests.length, 1, "redirect must not be followed");
        assert.strictEqual(http.requests[0]!.url, WEBHOOK_TARGET.url);
      }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
    },
  );

  it.effect("slack row: non-http(s) webBaseUrl → no actions block (treated as absent)", () => {
    // Finding 4: webBaseUrl is Config.url which accepts any scheme (ftp:, file:).
    // A non-http(s) base must be treated as absent so the Slack button is omitted
    // (Slack rejects non-http(s) button URLs with 400).
    const http = makeHttpRecorder([{ status: 200 }]);
    const slackCtx = sampleContext({ boardId: "board-9", ticketId: "ticket-9" });
    return Effect.gen(function* () {
      yield* insertDelivery({
        deliveryId: "dlv-slack-ftp",
        connectionRef: "conn-slack",
        formatter: "slack",
        context: slackCtx,
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      assert.strictEqual(http.requests.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the POSTed Slack body for assertions in a test.
      const sent = JSON.parse(http.requests[0]!.bodyText) as {
        readonly blocks: ReadonlyArray<Record<string, unknown>>;
      };
      const actions = sent.blocks.find((b) => b.type === "actions");
      assert.isUndefined(actions, "no actions block when webBaseUrl is non-http(s)");
    }).pipe(
      Effect.provide(
        buildLayer({
          http,
          connections: { "conn-slack": SLACK_TARGET },
          webBaseUrl: new URL("ftp://x/"),
        }),
      ),
    );
  });

  it.effect("Retry-After far in the future is CAPPED at the backoff cap", () => {
    const http = makeHttpRecorder([{ status: 429, headers: { "retry-after": "99999999" } }]);
    return Effect.gen(function* () {
      yield* insertDelivery({ deliveryId: "dlv-cap", connectionRef: "conn-1" });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      const now = yield* Clock.currentTimeMillis;
      yield* dispatcher.sweep();

      const row = yield* readDelivery("dlv-cap");
      assert.strictEqual(row.delivery_state, "pending");
      const delta = isoToMs(row.next_attempt_at!) - now;
      // Capped at BACKOFF_CAP_MS (1h), NOT ~99999999s (years).
      assert.isAtMost(delta, 3_600_000 + 2_000, "429 delay must be capped at the backoff cap");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect("a row already claimed by another instance ('processing') is NOT re-POSTed", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      // Simulate another instance mid-flight: the row sits in 'processing'. The
      // sweep selects only 'pending', and even a direct claim would fail, so no
      // duplicate POST is issued.
      yield* insertDelivery({
        deliveryId: "dlv-claimed",
        connectionRef: "conn-1",
        deliveryState: "processing",
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.sweep();

      assert.strictEqual(
        http.requests.length,
        0,
        "a processing row is never POSTed by this instance",
      );
      const row = yield* readDelivery("dlv-claimed");
      assert.strictEqual(row.delivery_state, "processing", "state untouched by this instance");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect("recoverStaleClaims resets a stranded 'processing' row → it IS re-processed", () => {
    const http = makeHttpRecorder([{ status: 200 }]);
    return Effect.gen(function* () {
      // A crash after claimRow but before markSent/recordFailure leaves the row
      // stranded 'processing'. Without recovery the sweep (which selects only
      // 'pending') would never re-select it. recoverStaleClaims resets it so the
      // next sweep delivers it.
      yield* insertDelivery({
        deliveryId: "dlv-stranded",
        connectionRef: "conn-1",
        deliveryState: "processing",
      });
      const dispatcher = yield* WorkflowOutboundDispatcher;

      // Boot-time recovery flips the stranded claim back to 'pending'.
      yield* dispatcher.recoverStaleClaims();
      const reclaimed = yield* readDelivery("dlv-stranded");
      assert.strictEqual(reclaimed.delivery_state, "pending", "stranded row reset to pending");

      // The next sweep now re-selects and delivers it.
      yield* dispatcher.sweep();
      assert.strictEqual(http.requests.length, 1, "reclaimed row is POSTed after recovery");
      const sent = yield* readDelivery("dlv-stranded");
      assert.strictEqual(sent.delivery_state, "sent");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });

  it.effect("two concurrent drains of the same pending row POST it exactly once", () => {
    // Both sweeps SELECT the single pending row, but only the one whose atomic
    // claim (UPDATE ... WHERE state='pending') wins proceeds to POST; the loser
    // skips it. Multi-instance double-POST protection.
    const http = makeHttpRecorder([{ status: 200 }, { status: 200 }]);
    return Effect.gen(function* () {
      yield* insertDelivery({ deliveryId: "dlv-race", connectionRef: "conn-1" });
      const dispatcher = yield* WorkflowOutboundDispatcher;

      yield* Effect.all([dispatcher.sweep(), dispatcher.sweep()], { concurrency: 2 });

      assert.strictEqual(http.requests.length, 1, "exactly one POST despite two concurrent drains");
      const row = yield* readDelivery("dlv-race");
      assert.strictEqual(row.delivery_state, "sent");
    }).pipe(Effect.provide(buildLayer({ http, connections: { "conn-1": WEBHOOK_TARGET } })));
  });
});
