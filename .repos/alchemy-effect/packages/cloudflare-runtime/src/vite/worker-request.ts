import * as NodeHttp from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream";
import { URL as NodeURL } from "node:url";
import type * as vite from "vite";
import { proxyRequestHeaders } from "./forwarded-host.ts";
import { HEADER_ERROR_STACK } from "./module-runner/constants.shared.ts";

/**
 * The Worker runtime URL for a request target (`req.url`): the path and
 * query of the request on the runtime's `address`.
 *
 * Never `new URL(requestTarget, address)`: a target starting with `//` is a
 * protocol-relative reference there, so `//127.0.0.1:8080/x` would replace
 * the host and send the request to another service on the machine (#2344).
 * An absolute-form target (`GET http://host/x`) keeps only its path too.
 */
export function workerRequestUrl(
  requestTarget: string | undefined,
  address: string | URL,
): NodeURL {
  const url = new NodeURL(address.toString());
  const target = requestTarget || "/";
  if (target.startsWith("/")) {
    const query = target.indexOf("?");
    url.pathname = query === -1 ? target : target.slice(0, query);
    url.search = query === -1 ? "" : target.slice(query);
  } else {
    const parsed = new NodeURL(target, url);
    url.pathname = parsed.pathname;
    url.search = parsed.search;
  }
  return url;
}

/**
 * Forwards a dev or preview server request to the Worker runtime at `target`
 * and relays the Worker's response.
 *
 * When the client hangs up, the Worker request is cancelled, as it would be in
 * production. Otherwise a stream the client abandoned (a closed page's SSE
 * subscription) keeps running in workerd.
 */
export function forwardWorkerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: NodeURL,
  proxySharedSecret: string,
  logger: vite.Logger,
  /** Receives the Worker's uncaught error, for Vite's error page. */
  next?: (error: Error) => void,
): void {
  const client = request.socket;
  // The client hung up while earlier middlewares ran.
  if (client.destroyed) {
    return;
  }
  // A connection per request, as a defense: with a pooled connection, requests
  // were reported to fail with a 502 under load after workerd cut a stream
  // short (#1869). We couldn't reproduce that against workerd, but a fresh
  // loopback connection costs next to nothing. See
  // https://github.com/alchemy-run/alchemy/pull/2242.
  //
  // A request with a body asks workerd for `100 Continue` first, and the body
  // is only forwarded once workerd sends it, which it does when the Worker
  // starts reading. A Worker that answers without reading (a 413 for an
  // oversized upload) then never receives the body: workerd closes the
  // connection after such a response, and an upload still in flight races the
  // response, which macOS can lose to the connection reset.
  const hasBody =
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0;
  const upstream = NodeHttp.request(target, {
    agent: false,
    method: request.method,
    headers: {
      ...proxyRequestHeaders(request, target, proxySharedSecret),
      ...(hasBody ? { expect: "100-continue" } : {}),
    },
  });
  // Watch the socket, not the response: Bun's `ServerResponse` emits no `close`
  // on a hang-up. Once the request body has been read, Bun reports no hang-up
  // at all, so there the Worker request runs to completion.
  let hungUp = false;
  const onHangUp = () => {
    hungUp = true;
    upstream.destroy();
  };
  client.once("close", onHangUp);
  let settled = false;
  const settle = () => {
    const first = !settled;
    settled = true;
    client.off("close", onHangUp);
    return first;
  };
  const fail = (error: Error) => {
    // A failure caused by the hang-up has nobody to answer.
    if (!settle() || hungUp) {
      return;
    }
    logger.error(`Worker request failed: ${error.message}`, { error, timestamp: true });
    if (response.headersSent) {
      // A partial body must not be completed with a 502.
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("Bad Gateway");
  };
  // Without a listener a connection error is an unhandled `error` event, which
  // takes down the server. Requests in flight while the Worker runtime is
  // being replaced hit exactly that.
  //
  // The Worker may also answer part-way through reading the body. workerd
  // then closes the connection, so forwarding the rest of the body fails.
  // That is no failure of the response, which `workerResponse` reports on its
  // own.
  let answered = false;
  upstream.on("error", (error) => {
    if (!answered) {
      fail(error);
    }
  });
  // Drain what is left of the body: a request whose body is never read makes
  // Node drop the client's kept-alive connection, failing its next request.
  // Forwarding continues until workerd closes the connection, so a Worker can
  // stream its response while it still reads the body.
  upstream.on("close", () => {
    if (answered) {
      request.unpipe(upstream);
      request.resume();
    }
  });
  upstream.on("response", (workerResponse) => {
    answered = true;
    if (next !== undefined && workerResponse.headers[HEADER_ERROR_STACK.toLowerCase()]) {
      // The Worker threw: revive its error for Vite's error page, as
      // `@cloudflare/vite-plugin` does.
      const chunks: Array<Buffer> = [];
      workerResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      finished(workerResponse, (error) => {
        if (error) {
          fail(error);
        } else if (settle()) {
          next(reviveError(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        }
      });
      return;
    }
    // The Worker's status text (`new Response(body, { statusText })`) is
    // relayed as written, as `@cloudflare/vite-plugin` does since 1.65.
    response.writeHead(
      workerResponse.statusCode ?? 500,
      workerResponse.statusMessage,
      workerResponse.headers,
    );
    workerResponse.pipe(response);
    // `pipe` alone would leave the client's response open forever when the
    // Worker's is cut short.
    finished(workerResponse, (error) => {
      if (error) {
        fail(error);
      } else {
        settle();
      }
    });
  });
  let forwarding = !hasBody;
  if (hasBody) {
    upstream.once("continue", () => {
      forwarding = true;
      request.pipe(upstream);
    });
  } else {
    request.pipe(upstream);
  }
  // Answered without the body: drain the client's (see above), and close the
  // upstream request, which never sent one.
  upstream.once("response", (workerResponse) => {
    if (forwarding) return;
    request.resume();
    finished(workerResponse, () => upstream.destroy());
  });
}

interface ReducedError {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly cause?: ReducedError;
}

/** Revives an error the Worker serialized with `reduceError`. */
function reviveError(reduced: ReducedError): Error {
  const error = new Error(reduced.message, {
    cause: reduced.cause === undefined ? undefined : reviveError(reduced.cause),
  });
  if (reduced.name !== undefined) error.name = reduced.name;
  if (reduced.stack !== undefined) error.stack = reduced.stack;
  return error;
}
