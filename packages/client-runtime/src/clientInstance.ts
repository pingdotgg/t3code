import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/**
 * One identity per client runtime instance — a browser tab, an app process,
 * a mobile session. The id is announced on the `/ws` upgrade URL and echoed
 * on every environment HTTP request so the server can attribute a
 * connectionless HTTP invocation to THIS client's live socket rather than a
 * session-global "newest" connection. It is intentionally per-process: a
 * reconnect re-announces the same id, while a second tab is a distinct
 * instance with its own socket and mints.
 */
const hex = (): string =>
  Random.nextIntBetween(0, 0xffffffff).pipe(
    Effect.map((value) => value.toString(16).padStart(8, "0")),
    Effect.runSync,
  );

export const clientInstanceId: string = `i-${hex()}${hex()}${hex()}${hex()}`;
