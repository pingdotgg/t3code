import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WorkflowEventStoreErrorCode } from "./Services/Errors.ts";
import { sanitizeExternalEventPayload } from "./externalEvent.ts";
import { WorkflowEngine } from "./Services/WorkflowEngine.ts";
import { WorkflowReadModel } from "./Services/WorkflowReadModel.ts";
import { WorkflowWebhook } from "./Services/WorkflowWebhook.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_DELIVERY_ID_LENGTH = 128;
const MAX_CORRELATION_LENGTH = 200;

const notFound = HttpServerResponse.text("Not Found", { status: 404 });
// Transient infrastructure failure (e.g. SQLITE_BUSY/locked under concurrent
// engine commits). 503 keeps the delivery RETRYABLE — a 404 here would be read
// by senders (CI/PR automation) as "endpoint gone" and silently dropped.
const serviceUnavailable = (detail: string) => HttpServerResponse.text(detail, { status: 503 });
const unprocessable = (detail: string) =>
  HttpServerResponse.json({ error: detail }, { status: 422 }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text(detail, { status: 422 })),
  );

interface ParsedHookBody {
  readonly name: string;
  readonly ticketId: string;
  readonly payload: unknown;
  readonly deliveryId: string | undefined;
}

const parseHookBody = (raw: string): ParsedHookBody | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "body must be JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "body must be a JSON object";
  }
  const body = parsed as Record<string, unknown>;
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    return "name is required (1-100 chars)";
  }
  const ticketId = typeof body["ticketId"] === "string" ? body["ticketId"].trim() : "";
  const branch = typeof body["branch"] === "string" ? body["branch"].trim() : "";
  if ((ticketId === "") === (branch === "")) {
    return "exactly one of ticketId or branch is required";
  }
  if (ticketId.length > MAX_CORRELATION_LENGTH || branch.length > MAX_CORRELATION_LENGTH) {
    return "correlation value too long";
  }
  let correlatedTicketId = ticketId;
  if (branch !== "") {
    const match = /^workflow\/(.+)$/.exec(branch);
    if (match === null || match[1] === undefined) {
      return 'branch must look like "workflow/<ticketId>"';
    }
    correlatedTicketId = match[1];
  }
  const rawDeliveryId = body["deliveryId"];
  if (rawDeliveryId !== undefined) {
    if (typeof rawDeliveryId !== "string" || rawDeliveryId.length > MAX_DELIVERY_ID_LENGTH) {
      return "deliveryId must be a string (max 128 chars)";
    }
  }
  return {
    name,
    ticketId: correlatedTicketId,
    payload: sanitizeExternalEventPayload(body["payload"] ?? null),
    deliveryId: typeof rawDeliveryId === "string" ? rawDeliveryId : undefined,
  };
};

/**
 * Per-board webhook ingress: external systems (CI, PR automation, cron) POST
 * events that move correlated tickets through their lane's onEvent matchers.
 * Unknown board and bad token are indistinguishable (404, no oracle).
 */
export const workflowHooksRouteLayer = HttpRouter.add(
  "POST",
  "/hooks/workflow/:boardId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (url._tag === "None") {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const segments = url.value.pathname.split("/").filter((segment) => segment.length > 0);
    const rawBoardId = segments[2] ?? "";
    let boardId: string;
    // @effect-diagnostics-next-line tryCatchInEffectGen:off — synchronous decodeURIComponent parse guard; not an Effect failure
    try {
      boardId = decodeURIComponent(rawBoardId);
    } catch {
      // Malformed percent-encoding — keep the no-oracle 404 discipline.
      return notFound;
    }
    if (boardId === "" || boardId.length > MAX_CORRELATION_LENGTH) {
      return notFound;
    }
    // Reject oversized bodies before buffering when the client declares a
    // length; the post-read byte check below covers lying clients.
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return yield* unprocessable("body must be 1 byte to 64 KiB of JSON");
    }

    const headerToken = request.headers["x-t3-webhook-token"];
    const token = typeof headerToken === "string" ? headerToken : "";
    if (token === "") {
      return notFound;
    }
    // Resolved optionally so servers composed without the workflow runtime
    // (tests, trimmed deployments) simply 404 instead of failing to build.
    const webhookOption = yield* Effect.serviceOption(WorkflowWebhook);
    const engineOption = yield* Effect.serviceOption(WorkflowEngine);
    const readModelOption = yield* Effect.serviceOption(WorkflowReadModel);
    if (
      webhookOption._tag === "None" ||
      engineOption._tag === "None" ||
      readModelOption._tag === "None"
    ) {
      return notFound;
    }
    const webhook = webhookOption.value;
    // Distinguish a real DB error from a legitimate `false` (bad/absent token).
    // A transient store failure during verification must NOT collapse into the
    // no-oracle 404 (which senders treat as permanently gone); surface it as a
    // retryable 503 instead, matching the recordDelivery/ingest branches below.
    const verified = yield* webhook.verifyToken(boardId as never, token).pipe(Effect.result);
    if (verified._tag === "Failure") {
      return serviceUnavailable("token verification temporarily unavailable");
    }
    if (!verified.success) {
      return notFound;
    }

    const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return yield* unprocessable("body must be 1 byte to 64 KiB of JSON");
    }
    const parsed = parseHookBody(raw);
    if (typeof parsed === "string") {
      return yield* unprocessable(parsed);
    }

    // Board must exist and own the ticket; the engine re-verifies, but a
    // cheap read keeps error shapes clean. As with verifyToken, separate a real
    // DB error (retryable 503) from a legitimate `null` (board absent → 404) so a
    // transient store failure is not mis-reported as a permanent not-found.
    const boardResult = yield* readModelOption.value.getBoard(boardId as never).pipe(Effect.result);
    if (boardResult._tag === "Failure") {
      return serviceUnavailable("board lookup temporarily unavailable");
    }
    if (boardResult.success === null) {
      return notFound;
    }

    if (parsed.deliveryId !== undefined) {
      // Best-effort at-least-once dedupe. recordDelivery returns `true` for an
      // already-seen id (skip → 202 duplicate) and `false` for a fresh id
      // (proceed to ingest). Fail closed: if the row cannot be recorded at all,
      // a retried delivery could route twice — surface a retryable 503.
      const recorded = yield* webhook
        .recordDelivery(boardId as never, parsed.deliveryId)
        .pipe(Effect.result);
      if (recorded._tag === "Failure") {
        return HttpServerResponse.text("delivery could not be recorded", { status: 503 });
      }
      if (recorded.success) {
        return yield* HttpServerResponse.json({ outcome: "duplicate" }, { status: 202 }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.text("duplicate", { status: 202 })),
        );
      }
    }

    const result = yield* engineOption.value
      .ingestExternalEvent({
        boardId: boardId as never,
        name: parsed.name,
        ticketId: parsed.ticketId as never,
        payload: parsed.payload,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      // TERMINAL vs RETRYABLE classification. A permanent ingest failure (the
      // ticket is not on this board — the event can NEVER succeed) must return a
      // 4xx so the sender stops retrying; mapping it to 503 would loop forever.
      // We branch on the machine-checkable error CODE, never the message string.
      if (result.failure.code === WorkflowEventStoreErrorCode.ticketNotOnBoard) {
        // Terminal: do NOT release the dedup row. Retrying is futile, so leaving
        // the row recorded means a same-deliveryId retry is answered "duplicate"
        // (202) rather than re-running ingest to the same permanent 422.
        return yield* unprocessable("ticket not found on this board");
      }

      // The delivery row was recorded before ingest. Best-effort release on a
      // TRANSIENT failure so the sender's retry re-ingests rather than being
      // answered "duplicate". 503 keeps the failure retryable.
      //
      // ACCEPTED v1 LIMITATION (concurrency-safe at-least-once, NOT exactly-once):
      // recordDelivery's INSERT ... ON CONFLICT DO NOTHING RETURNING already makes
      // concurrent same-id deliveries safe — exactly one wins the claim and
      // ingests; the loser is answered "duplicate". The only residual hole is a
      // COMPOUND failure: ingest fails (transient DB error) AND this releaseDelivery
      // also fails — then the dedupe row persists and the sender's retry is wrongly
      // skipped (lost delivery). Two independent DB errors in sequence.
      //
      // True exactly-once would mean claiming the deliveryId in the SAME
      // transaction as the ingest's event append. That is NOT a localized change:
      // a single ingest's side effects already span multiple transactions (the
      // route/move commit, then admitNext's backfill-admission commit, then
      // post-lock runPipelineStarts), so atomicity would require collapsing the
      // whole ingest into one transaction — fighting the admission-lock-outside /
      // tx-inside design and the post-lock pipeline starts. High regression risk
      // for a compound-failure window on a human-gated path whose senders already
      // assume at-least-once retry semantics. Deliberately NOT pursued for v1.
      if (parsed.deliveryId !== undefined) {
        yield* webhook
          .releaseDelivery(boardId as never, parsed.deliveryId)
          .pipe(Effect.orElseSucceed(() => undefined));
      }
      return HttpServerResponse.text("event could not be ingested", { status: 503 });
    }
    return yield* HttpServerResponse.json(
      {
        outcome: result.success.outcome,
        ...(result.success.toLane === undefined ? {} : { toLane: result.success.toLane }),
      },
      { status: 202 },
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("accepted", { status: 202 })));
  }),
);
