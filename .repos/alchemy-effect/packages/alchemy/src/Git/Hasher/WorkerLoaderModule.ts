/**
 * The dynamic hasher (DESIGN §22.12): a module Worker loaded by
 * `HasherWorkerLoader` through a `WorkerLoader` binding, one isolate per
 * slot. It answers the hash route's own protocol — coordinates in the
 * query, the part in the body, the scan as one framed response — and
 * nothing else; it has no bindings and no network.
 */
import * as Effect from "effect/Effect";
import {
  decodeDeltaBatch,
  encodeDeltaResults,
  encodeScanResult,
  frame,
} from "./Protocol.ts";
import { resolveDeltas, scanPart } from "../Protocol/PartialScan.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    if (query.get("mode") === "deltas") {
      const maxObjectSize = Number(query.get("max"));
      const { bases, jobs } = decodeDeltaBatch(
        new Uint8Array(await request.arrayBuffer()),
      );
      const resolved = await Effect.runPromise(
        Effect.result(resolveDeltas(bases, jobs, { maxObjectSize })),
      );
      if (resolved._tag === "Failure") {
        const failure = resolved.failure;
        return new Response(
          `${failure._tag}: ${"reason" in failure ? failure.reason : ""}`,
          { status: 422 },
        );
      }
      return new Response(
        frame(encodeDeltaResults(resolved.success)) as unknown as BodyInit,
        { headers: { "content-type": "application/octet-stream" } },
      );
    }
    const base = Number(query.get("base"));
    const remaining = Number(query.get("remaining"));
    const maxObjectSize = Number(query.get("max"));
    const skip = Number(query.get("skip") ?? "0");
    if (![base, remaining, maxObjectSize, skip].every(Number.isFinite)) {
      return new Response("bad coordinates", { status: 400 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    const result = await Effect.runPromise(
      Effect.result(
        scanPart(skip > 0 ? body.subarray(skip) : body, {
          base,
          remaining,
          maxObjectSize,
          resync: query.get("resync") === "1",
        }),
      ),
    );
    if (result._tag === "Failure") {
      const failure = result.failure;
      return new Response(
        `${failure._tag}: ${"reason" in failure ? failure.reason : ""}`,
        { status: 422 },
      );
    }
    return new Response(
      frame(encodeScanResult(result.success)) as unknown as BodyInit,
      {
        headers: { "content-type": "application/octet-stream" },
      },
    );
  },
};
