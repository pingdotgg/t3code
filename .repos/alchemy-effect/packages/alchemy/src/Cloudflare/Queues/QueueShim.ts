/**
 * Dev-mode remote-producer shim for `Alchemy.remote()` queues.
 *
 * Cloudflare's preview/remote-binding sessions reject queue bindings
 * outright (a preview worker carrying one serves 503 for every request;
 * wrangler has the same gap — cloudflare/workers-sdk#9929), so a locally
 * running worker cannot produce to a live queue through the usual
 * remote-binding proxy. Instead, alchemy deploys a REAL shim worker that
 * holds the actual queue binding:
 *
 *   local worker ── env.QUEUE.send() ──▶ forwarder service (local workerd)
 *        POST /message | /batch  +  Authorization: Bearer <token>
 *                                   │
 *                                   ▼
 *                     deployed shim worker (workers.dev)
 *                                   │  env.QUEUE.send(body, { contentType })
 *                                   ▼
 *                            real Cloudflare Queue
 *
 * The shim and its bearer token are ordinary engine-managed resources
 * ({@link Worker} + {@link Random}), conditionally instantiated at eval
 * time when a LOCAL worker binds a LIVE queue — the same idiom as
 * `AccountApiToken` (capability layers minting token resources) and
 * event-source mappings. The engine gives the full lifecycle for free:
 * Output-based ordering (shim deploys before the local worker serves),
 * stable-name updates, deletion on destroy, and orphan GC on promotion
 * (`alchemy deploy` no longer registers the shim, so it is cleaned up).
 *
 * NOT exported from `index.ts` — binding-internal scaffolding.
 */
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Output from "../../Output.ts";
import {
  defaultProviderMode,
  remote,
  type ProviderMode,
} from "../../ProviderMode.ts";
import { Random } from "../../Random.ts";
import { Worker } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";

/**
 * The deployed shim's script: decodes workerd's queue wire protocol
 * (`POST /message` with raw bytes + `X-Msg-Fmt`, `POST /batch` with base64
 * payloads) back into `send()`/`sendBatch()` calls on its real queue
 * binding, gated by a bearer token.
 *
 * `v8`-serialized messages cannot cross the boundary — deserializing V8
 * payloads in userland is not possible — so they are rejected with a clear
 * error telling the caller to pass an explicit contentType.
 */
const QUEUE_SHIM_SCRIPT = `class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function decodeBody(contentType, bytes) {
  switch (contentType) {
    case "text":
      return { contentType, body: new TextDecoder().decode(bytes) };
    case "json":
      return { contentType, body: JSON.parse(new TextDecoder().decode(bytes)) };
    case "bytes":
      return { contentType, body: bytes.slice().buffer };
    case "v8":
      throw new HttpError(
        422,
        'v8-serialized queue messages cannot be produced to a live queue from local dev; pass an explicit contentType of "json", "text", or "bytes" to send()/sendBatch()',
      );
    default:
      throw new HttpError(400, "message content type " + contentType + " is invalid");
  }
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getDelay(value) {
  if (!value) return undefined;
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 0) {
    throw new HttpError(400, "message delay " + value + " is invalid");
  }
  return delay;
}

// workerd's queue client requires this response shape (SendMetadata);
// the metrics are informational and synthesized as zeros here.
const sendResponse = () =>
  Response.json({
    metadata: {
      metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 },
    },
  });

export default {
  async fetch(request, env) {
    try {
      const auth = request.headers.get("authorization");
      if (auth !== "Bearer " + env.SHIM_TOKEN) {
        throw new HttpError(401, "unauthorized");
      }
      if (request.method !== "POST") {
        throw new HttpError(405, "method " + request.method + " not allowed");
      }
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/message": {
          // workerd's absent-header default is "v8" — mirrored here so an
          // unmarked payload is rejected rather than misparsed.
          const contentType = request.headers.get("X-Msg-Fmt") ?? "v8";
          const delaySeconds = getDelay(request.headers.get("X-Msg-Delay-Secs"));
          const bytes = new Uint8Array(await request.arrayBuffer());
          const decoded = decodeBody(contentType, bytes);
          await env.QUEUE.send(decoded.body, {
            contentType: decoded.contentType,
            ...(delaySeconds !== undefined && { delaySeconds }),
          });
          return sendResponse();
        }
        case "/batch": {
          const delaySeconds = getDelay(request.headers.get("X-Msg-Delay-Secs"));
          const body = await request.json();
          const messages = body.messages.map((message) => {
            const decoded = decodeBody(message.contentType, base64ToBytes(message.body));
            const delay = message.delaySecs ?? delaySeconds;
            return {
              body: decoded.body,
              contentType: decoded.contentType,
              ...(delay !== undefined && { delaySeconds: delay }),
            };
          });
          await env.QUEUE.sendBatch(messages);
          return sendResponse();
        }
        default:
          throw new HttpError(404, "not found");
      }
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(e.message, { status: e.status });
      }
      const message = e instanceof Error ? e.message : String(e);
      return new Response("queue shim failed: " + message, { status: 500 });
    }
  },
};`;

export interface QueueShimBinding {
  url: Output.Output<string | undefined>;
  token: Output.Output<Redacted.Redacted<string>>;
}

/**
 * Conditionally instantiate the queue shim for a producer binding: when a
 * LOCAL host worker binds a LIVE queue (dev run + `Alchemy.remote()` on the
 * queue), register the shim worker + its token and return their outputs
 * for the binding data. Any other mode combination returns `undefined` —
 * including the shim worker's own eval of its queue binding (the shim is
 * pinned live, so no recursion).
 */
export const maybeQueueShim = Effect.fn(function* (
  queue: Queue,
  host: { Mode?: ProviderMode | undefined },
) {
  const runDefault = yield* defaultProviderMode;
  const hostMode = host.Mode ?? runDefault;
  const queueMode = queue.Mode ?? runDefault;
  if (hostMode !== "local" || queueMode !== "live") {
    return undefined;
  }
  const token = yield* Random(`${queue.LogicalId}ShimToken`);
  const shim = yield* Worker(`${queue.LogicalId}Shim`, {
    script: QUEUE_SHIM_SCRIPT,
    env: {
      QUEUE: queue,
      SHIM_TOKEN: token.text,
    },
  }).pipe(remote());
  return {
    url: shim.url,
    token: token.text,
  } satisfies QueueShimBinding;
});
