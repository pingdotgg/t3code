import {
  environmentExtensionApiStream,
  environmentResumableExtensionApiStream,
} from "@t3tools/client-runtime/state/extensions";
import type { EnvironmentId, ExtensionApiSubscribeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

type ApiStream = ReturnType<typeof environmentExtensionApiStream>;

/**
 * A pull-driven iterator retains only the stream's bounded window: the RPC
 * delivery window, plus one frame queued at the session switch on the
 * resumable path.
 */
async function* authenticatedValues<A>(
  stream: Stream.Stream<A, unknown, Stream.Services<ApiStream>>,
  signal: AbortSignal,
) {
  const context = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime),
    { signal },
  );
  const iterable = Stream.toAsyncIterableWith(stream, context);
  const iterator = iterable[Symbol.asyncIterator]();
  const cancel = () => {
    void iterator.return?.().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Extension stream cancelled");
    while (!signal.aborted) {
      const next = await iterator.next();
      if (signal.aborted) throw new Error("Extension stream cancelled");
      if (next.done) return;
      yield next.value;
    }
    throw new Error("Extension stream cancelled");
  } finally {
    signal.removeEventListener("abort", cancel);
    await iterator.return?.();
  }
}

function apiFrame({ cursor, ...frame }: Stream.Success<ApiStream>) {
  return { ...frame, ...(cursor === undefined ? {} : { cursor }) };
}

export async function* authenticatedApiFrames(stream: ApiStream, signal: AbortSignal) {
  for await (const frame of authenticatedValues(stream, signal)) yield apiFrame(frame);
}

/**
 * `ClientHost.resumableStreams` transport. The allowlisted streams are
 * server-provided, so the payload carries no client connection hint and the
 * first open does not wait for the client-provider seam to register: an
 * environment-keyed hint read at resubscription could belong to an earlier
 * transport session. A client-routed stream needs a registration receipt
 * matched to each new session before it can be allowlisted here.
 *
 * `onSuspended` runs inside the pull that follows the last frame delivered
 * before the transport dropped, as the stream starts waiting for a session.
 */
export async function* resumableApiFrames(
  environmentId: EnvironmentId,
  payload: ExtensionApiSubscribeInput,
  signal: AbortSignal,
  onSuspended?: () => void,
) {
  const stream = environmentResumableExtensionApiStream(environmentId, () => payload);
  for await (const value of authenticatedValues(stream, signal)) {
    if (Option.isSome(value)) yield apiFrame(value.value);
    else onSuspended?.();
  }
}
