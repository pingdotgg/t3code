/**
 * Protocol-v0 fetch/clone choreography (DESIGN §2.3, §4) as pure functions
 * over a parsed request plus injected {@link ObjectSource} /
 * {@link ClosureSource}.
 *
 * Stateless-RPC reality (HTTP): each POST is independent; the client resends
 * all wants plus all previously-ACKed haves every round. With
 * `multi_ack_detailed` + `no-done` and the "lazy-ready" policy the
 * negotiation converges in ≤ 2 POSTs:
 *
 * - POST ends with flush (no `done`): `ACK <oid> common` per recognized
 *   have, `ACK <last> ready` once the want-closure is coverable, else `NAK`.
 *   With `no-done` the server continues straight from `ready` into the pack.
 * - POST ends with `done`: final `ACK <last common>` (else `NAK`), then the
 *   pack — on side-band band 1 when negotiated, raw bytes otherwise.
 * - A fresh clone is one POST: wants + flush + `done`, no haves ⇒ `NAK` +
 *   pack.
 *
 * Shallow (`deepen <n>`): `shallow <oid>` boundary lines (and `unshallow`
 * for previously-shallow client tips now complete), then a flush, before the
 * ACK/NAK section; the pack is depth-truncated.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { concatBytes, isOid, type Oid } from "./ObjectCodec.ts";
import {
  decodePktLines,
  flushPkt,
  PktLineError,
  pktPayloadText,
  pktText,
  ProtocolError,
} from "./Pkt.ts";
import { packDataBytes, type PackEvent, writePack } from "./PackWriter.ts";
import { progressMessage, sidebandFrames } from "./Sideband.ts";
import type { ClosureResult, ClosureSource, ObjectSource } from "./Store.ts";
import { StoreError } from "./Store.ts";

/**
 * A parsed `git-upload-pack` request body.
 */
export interface UploadPackRequest {
  /** Requested tips, in request order (first `want` carried the caps). */
  readonly wants: ReadonlyArray<Oid>;
  /** The client's `have` lines, in request order. */
  readonly haves: ReadonlyArray<Oid>;
  /** Whether the request ended with `done` (vs a bare flush). */
  readonly done: boolean;
  /** Capabilities requested on the first `want` line (space-separated). */
  readonly capabilities: ReadonlySet<string>;
  /** Depth bound from `deepen <n>`, when present. */
  readonly depth: number | undefined;
  /** The client's existing shallow tips (`shallow <oid>` lines). */
  readonly clientShallow: ReadonlyArray<Oid>;
}

const parseOidLine = (
  text: string,
  keyword: string,
): Effect.Effect<{ readonly oid: Oid; readonly rest: string }, ProtocolError> =>
  Effect.suspend(() => {
    const body = text.slice(keyword.length + 1);
    const oid = body.slice(0, 40);
    if (!isOid(oid)) {
      return Effect.fail(
        new ProtocolError({ reason: `malformed ${keyword} line: ${text}` }),
      );
    }
    return Effect.succeed({ oid, rest: body.slice(40).trim() });
  });

/**
 * Parses a `git-upload-pack` request body (already gunzipped) into a
 * {@link UploadPackRequest}. Rejects arguments we do not advertise
 * (`deepen-since`, `deepen-not`, `filter`) with a typed
 * {@link ProtocolError}.
 */
export const parseUploadPackRequest = Effect.fn(function* (body: Uint8Array) {
  const pkts = yield* decodePktLines(body);
  const wants: Array<Oid> = [];
  const haves: Array<Oid> = [];
  const clientShallow: Array<Oid> = [];
  const capabilities = new Set<string>();
  let depth: number | undefined;
  let done = false;
  let inHaves = false;

  for (const pkt of pkts) {
    if (pkt._tag === "flush") {
      inHaves = true;
      continue;
    }
    if (pkt._tag !== "data") {
      return yield* new ProtocolError({
        reason: `unexpected ${pkt._tag} packet in upload-pack request`,
      });
    }
    const text = pktPayloadText(pkt.payload);
    if (!inHaves) {
      if (text.startsWith("want ")) {
        const { oid, rest } = yield* parseOidLine(text, "want");
        wants.push(oid);
        if (rest.length > 0) {
          for (const cap of rest.split(" ")) {
            if (cap.length > 0) capabilities.add(cap);
          }
        }
      } else if (text.startsWith("shallow ")) {
        const { oid } = yield* parseOidLine(text, "shallow");
        clientShallow.push(oid);
      } else if (text.startsWith("deepen ")) {
        const n = Number.parseInt(text.slice(7), 10);
        if (!Number.isInteger(n) || n <= 0) {
          return yield* new ProtocolError({
            reason: `invalid deepen depth: ${text}`,
          });
        }
        depth = n;
      } else if (
        text.startsWith("deepen-since ") ||
        text.startsWith("deepen-not ") ||
        text.startsWith("filter ")
      ) {
        return yield* new ProtocolError({
          reason: `unsupported argument: ${text.split(" ")[0]}`,
        });
      } else {
        return yield* new ProtocolError({
          reason: `unexpected line in want section: ${text}`,
        });
      }
    } else {
      if (text.startsWith("have ")) {
        const { oid } = yield* parseOidLine(text, "have");
        haves.push(oid);
      } else if (text === "done") {
        done = true;
      } else {
        return yield* new ProtocolError({
          reason: `unexpected line in have section: ${text}`,
        });
      }
    }
  }

  if (wants.length === 0) {
    return yield* new ProtocolError({
      reason: "upload-pack request has no want lines",
    });
  }
  const request: UploadPackRequest = {
    wants,
    haves,
    done,
    capabilities,
    depth,
    clientShallow,
  };
  return request;
});

/**
 * The outcome of one negotiation round.
 */
export interface Negotiation {
  /** Haves that exist in the store, in the client's request order. */
  readonly common: ReadonlyArray<Oid>;
  /** Whether the server declared `ready` (lazy-ready: any common found). */
  readonly ready: boolean;
  /** Whether this response continues into a pack. */
  readonly sendPack: boolean;
  /** The encoded ACK/NAK pkt-line section. */
  readonly ackSection: Uint8Array;
}

/**
 * Runs the v0 `multi_ack_detailed` (+ `no-done`) negotiation for one
 * stateless round: acks `common` for each recognized have, declares `ready`
 * as soon as any common exists, and decides whether the pack follows in this
 * response (`done` received, or `ready` under `no-done`).
 */
export const negotiate = Effect.fn(function* (
  request: UploadPackRequest,
  objects: ObjectSource,
) {
  const existing = new Set(yield* objects.filterExisting(request.haves));
  const common = request.haves.filter((oid) => existing.has(oid));
  const noDone = request.capabilities.has("no-done");
  const multiAckDetailed = request.capabilities.has("multi_ack_detailed");
  const last = common[common.length - 1];

  const lines: Array<Uint8Array> = [];
  let ready = false;
  let sendPack: boolean;
  if (request.done) {
    // final round: single ACK of the last common oid, else NAK, then pack
    lines.push(last !== undefined ? pktText(`ACK ${last}`) : pktText("NAK"));
    sendPack = true;
  } else if (last === undefined) {
    lines.push(pktText("NAK"));
    sendPack = false;
  } else if (multiAckDetailed) {
    for (const oid of common) {
      lines.push(pktText(`ACK ${oid} common`));
    }
    lines.push(pktText(`ACK ${last} ready`));
    ready = true;
    if (noDone) {
      // continue straight into the pack after `ready`
      sendPack = true;
    } else {
      // every non-final round ends with NAK; the client sends `done` next
      lines.push(pktText("NAK"));
      sendPack = false;
    }
  } else {
    // legacy single-ack fallback: ack the last common, wait for `done`
    lines.push(pktText(`ACK ${last}`));
    ready = true;
    sendPack = false;
  }
  const negotiation: Negotiation = {
    common,
    ready,
    sendPack,
    ackSection: concatBytes(lines),
  };
  return negotiation;
});

/**
 * A fully assembled upload-pack response.
 */
export interface UploadPackResponse {
  /** The response body, streamed chunked (`HttpServerResponse.stream`). */
  readonly body: Stream.Stream<Uint8Array, StoreError>;
  /** Whether side-band-64k framing was negotiated. */
  readonly sideband: boolean;
  /** Whether this response carries a pack (vs a negotiation-only round). */
  readonly packSent: boolean;
  /** Number of objects in the pack (0 when `packSent` is false). */
  readonly objectCount: number;
}

/** Emit a progress event on band 2 every N pack entries. */
const PROGRESS_EVERY = 1000;

const shallowSection = (closure: ClosureResult): Uint8Array =>
  concatBytes([
    ...closure.shallow.map((oid) => pktText(`shallow ${oid}`)),
    ...closure.unshallow.map((oid) => pktText(`unshallow ${oid}`)),
    flushPkt,
  ]);

const muxPackEvent = (event: PackEvent): Stream.Stream<Uint8Array> =>
  event._tag === "data"
    ? Stream.fromArray(sidebandFrames(1, event.bytes))
    : Stream.succeed(
        progressMessage(`Counting objects: ${event.written}/${event.total}\r`),
      );

/**
 * Runs one full upload-pack round: validates the wants, negotiates, computes
 * the closure when a pack is due, and assembles the streaming response body
 * (shallow section, ACK/NAK section, then the pack — sideband-muxed with
 * band-2 progress when negotiated, raw otherwise).
 *
 * Wants that do not exist in the store fail with `ProtocolError`
 * (`not our ref`); the caller converts pre-stream failures into an `ERR`
 * pkt / HTTP status. Mid-stream `StoreError`s surface on the body stream for
 * the caller to translate into a band-3 fatal.
 */
export const uploadPack = Effect.fn(function* (
  request: UploadPackRequest,
  objects: ObjectSource,
  closure: ClosureSource,
) {
  const sideband = request.capabilities.has("side-band-64k");

  const existingWants = new Set(yield* objects.filterExisting(request.wants));
  for (const want of request.wants) {
    if (!existingWants.has(want)) {
      return yield* new ProtocolError({ reason: `not our ref ${want}` });
    }
  }

  const negotiation = yield* negotiate(request, objects);
  const shallowRequested =
    request.depth !== undefined || request.clientShallow.length > 0;

  if (!negotiation.sendPack) {
    // negotiation-only round: shallow section (when requested) + acks
    const sections: Array<Uint8Array> = [];
    if (shallowRequested) {
      const result = yield* closure.commitClosure({
        wants: request.wants,
        haves: negotiation.common,
        depth: request.depth,
        clientShallow: request.clientShallow,
      });
      sections.push(shallowSection(result));
    }
    sections.push(negotiation.ackSection);
    const response: UploadPackResponse = {
      body: Stream.fromArray(sections),
      sideband,
      packSent: false,
      objectCount: 0,
    };
    return response;
  }

  const result = yield* closure.commitClosure({
    wants: request.wants,
    haves: negotiation.common,
    depth: request.depth,
    clientShallow: request.clientShallow,
  });

  const prelude: Array<Uint8Array> = [];
  if (shallowRequested) prelude.push(shallowSection(result));
  prelude.push(negotiation.ackSection);

  const events = writePack(result.entries, objects, {
    progressEvery: sideband ? PROGRESS_EVERY : undefined,
  });

  const body = sideband
    ? Stream.concat(
        Stream.concat(
          Stream.fromArray([
            ...prelude,
            progressMessage(
              `Enumerating objects: ${result.entries.length}, done.`,
            ),
          ]),
          Stream.flatMap(events, muxPackEvent),
        ),
        Stream.succeed(flushPkt),
      )
    : Stream.concat(Stream.fromArray(prelude), packDataBytes(events));

  const response: UploadPackResponse = {
    body,
    sideband,
    packSent: true,
    objectCount: result.entries.length,
  };
  return response;
});

/**
 * Convenience: parses the request body and runs {@link uploadPack} in one
 * step.
 */
export const handleUploadPack = (
  body: Uint8Array,
  objects: ObjectSource,
  closure: ClosureSource,
): Effect.Effect<
  UploadPackResponse,
  PktLineError | ProtocolError | StoreError
> =>
  parseUploadPackRequest(body).pipe(
    Effect.flatMap((request) => uploadPack(request, objects, closure)),
  );
