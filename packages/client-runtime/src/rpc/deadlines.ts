/**
 * Deadlines for a client RPC request.
 *
 * The transport already drops a socket that stops sending frames for
 * `PING_TIMEOUT` (see `protocol.ts`). That covers a host that is gone, and
 * nothing else: a host that is overloaded still answers small requests, so the
 * socket stays alive and a request that the server will never answer waits
 * forever. A user pressing Enter then watches a spinner that never resolves,
 * with no error to act on.
 *
 * A request deadline closes that gap. It bounds one request, independent of
 * the socket's health, and it fails with a named error the UI can show.
 *
 * The deadline is deliberately long. A legitimate request on a busy host can
 * take minutes - opening a long thread, starting a turn, waiting on a
 * provider. Cutting it off early turns a slow success into a failure the user
 * has to retry, which is worse than waiting. The value below is long enough
 * that it only fires when the host has genuinely stopped answering.
 */

/** How long a unary RPC request may wait before it fails with a timeout. */
export const REQUEST_TIMEOUT = "120 seconds";
