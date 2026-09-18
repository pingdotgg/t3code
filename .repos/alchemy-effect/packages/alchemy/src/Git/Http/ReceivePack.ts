/** Streaming smart-HTTP decoding and report-status encoding. No authorization policy. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { concatBytes } from "../Protocol/ObjectCodec.ts";
import { errPkt, flushPkt, pktText } from "../Protocol/Pkt.ts";
import { sidebandFrames } from "../Protocol/Sideband.ts";
import { StoreError } from "../Protocol/Store.ts";
import { incomingStates, type PushInput } from "../Push.ts";
import {
  parseReceivePackRequest,
  type CommitPushResult,
} from "../RepoObject.ts";
import { feedBody, HEAD_BYTES } from "../Store/IncomingBody.ts";
import { makeStreamingSource } from "../Store/StreamingSource.ts";

export { ReceivePack as endpoint } from "../Api/Protocol.ts";

export interface Push {
  readonly _tag: "Push";
  readonly input: PushInput;
  readonly updates: PushInput["updates"];
  readonly capabilities: ReadonlySet<string>;
}

const headers = {
  "cache-control": "no-cache",
  "content-type": "application/x-git-receive-pack-result",
};
const reply = (bytes: Uint8Array) =>
  HttpServerResponse.uint8Array(bytes, { headers });
export const probeResponse = () =>
  HttpServerResponse.empty({ status: 200, headers });

/** Decode only the bounded command header. The body remains streaming until preparePush. */
export const decode = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const web = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(
        (error) =>
          new StoreError({ reason: `incoming body: ${error.message}` }),
      ),
    );
    const feeder = makeStreamingSource();
    const gzip = /\bgzip\b/i.test(request.headers["content-encoding"] ?? "");
    const body =
      gzip && web.body !== null
        ? web.body.pipeThrough(new DecompressionStream("gzip"))
        : web.body;
    const receiving = yield* Effect.forkScoped(
      Effect.result(feedBody(body, feeder)),
    );
    const state = {
      feeder,
      receiving,
      packStart: 0,
      declaredBytes: undefined as number | undefined,
      active: true,
      claimed: false,
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.active = false;
        feeder.fail(new StoreError({ reason: "push scope closed" }));
        yield* Fiber.interrupt(receiving);
      }),
    );
    const head = yield* feeder.source.read(0, HEAD_BYTES);
    if (!gzip && head[0] === 0x1f && head[1] === 0x8b) {
      return yield* new StoreError({
        reason: "gzip-encoded push without content-encoding",
      });
    }
    const parsed = yield* parseReceivePackRequest(head);
    if (parsed.probe) return { _tag: "Probe" } as const;
    const updates = Object.freeze(
      parsed.commands.map((command) => Object.freeze({ ...command })),
    );
    const input: PushInput = Object.freeze({
      updates,
      atomic: parsed.capabilities.has("atomic"),
    });
    state.packStart = parsed.packStart;
    const length = Number.parseInt(request.headers["content-length"] ?? "", 10);
    state.declaredBytes = Number.isNaN(length) ? undefined : length;
    incomingStates.set(input, state);
    return {
      _tag: "Push",
      input,
      updates,
      capabilities: parsed.capabilities,
    } satisfies Push;
  });

/** Encode the negotiated Git report; policy rejection is a Git result, not JSON. */
export const response = (push: Push, result: CommitPushResult) => {
  if (
    !push.capabilities.has("report-status") &&
    !push.capabilities.has("report-status-v2")
  )
    return probeResponse();
  const lines = [
    pktText(`unpack ${result.unpack}`),
    ...result.results.map((ref) =>
      pktText(
        ref.ok ? `ok ${ref.ref}` : `ng ${ref.ref} ${ref.reason ?? "failed"}`,
      ),
    ),
    flushPkt,
  ];
  const report = concatBytes(lines);
  return reply(
    push.capabilities.has("side-band-64k")
      ? concatBytes([...sidebandFrames(1, report), flushPkt])
      : report,
  );
};

/** Refuse the whole push without ingesting objects or moving any refs. */
export const reject = (push: Push, reason: string) =>
  response(push, {
    unpack: "ok",
    results: push.updates.map((update) => ({
      ref: update.ref,
      ok: false,
      reason: reason.replace(/[\r\n\0]/g, " "),
    })),
  });

/** Encode malformed protocol input or a failed unpack operation. */
export const failure = (reason: string) =>
  reply(errPkt(reason.replace(/[\r\n\0]/g, " ")));
