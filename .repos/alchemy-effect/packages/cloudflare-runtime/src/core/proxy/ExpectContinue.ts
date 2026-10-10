/**
 * Answers `Expect: 100-continue` on behalf of workerd, which never sends an
 * interim `100 Continue`. Without it a client that asks (e.g. the AWS SDK v3
 * in Node for uploads of 2 MB or more, curl for large bodies) waits out its
 * own timeout before sending the body.
 *
 * The proxy relays raw bytes, so this is an observer over the client's
 * outbound stream: it tracks HTTP/1.1 request framing (head, then a
 * `Content-Length` or chunked body) only to find where each request head
 * starts, and never modifies forwarded bytes. When a complete head carries
 * the expectation, it writes `HTTP/1.1 100 Continue` to the client before
 * the head reaches the upstream, so the interim response always precedes
 * the final one.
 *
 * It is best-effort and fails open: an upgrade (WebSocket), `CONNECT`, an
 * oversized or malformed head, or malformed chunk framing stops tracking
 * for the rest of the connection, which is then a plain pipe again (the
 * client falls back to its own timeout, as before). Clients that send the
 * expectation wait before sending the body and do not pipeline, so the
 * previous response on the connection is complete when the next head
 * arrives and the interim response never lands inside it.
 */

/** Largest request head (request line + headers) the observer will buffer. */
const MAX_HEAD_BYTES = 64 * 1024;

/** Largest chunk-size line (hex size + extensions) accepted. */
const MAX_CHUNK_LINE_BYTES = 4 * 1024;

export const CONTINUE_RESPONSE = "HTTP/1.1 100 Continue\r\n\r\n";

const CRLF = Buffer.from("\r\n");
// Header bytes are opaque octets; decode 1:1 so framing offsets hold.
const latin1 = new TextDecoder("latin1");
const HEAD_END = Buffer.from("\r\n\r\n");

type State =
  /** Accumulating a request head. */
  | { readonly _tag: "Head"; buffer: Buffer }
  /** Skipping a `Content-Length` body. */
  | { readonly _tag: "Body"; remaining: number }
  /** Reading a chunk-size line. */
  | { readonly _tag: "ChunkSize"; buffer: Buffer }
  /** Skipping chunk data plus its trailing CRLF. */
  | { readonly _tag: "ChunkData"; remaining: number }
  /** Reading trailer lines after the last chunk, until an empty line. */
  | { readonly _tag: "Trailers"; buffer: Buffer }
  /** Not HTTP we understand (upgrade, CONNECT, malformed): stop tracking. */
  | { readonly _tag: "Off" };

const head = (): State => ({ _tag: "Head", buffer: Buffer.alloc(0) });

interface ParsedHead {
  readonly method: string;
  readonly version: string;
  readonly headers: ReadonlyMap<string, string>;
}

const parseHead = (raw: Buffer): ParsedHead | undefined => {
  const lines = latin1.decode(raw).split("\r\n");
  const requestLine = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) \S+ (HTTP\/\d\.\d)$/.exec(
    lines[0] ?? "",
  );
  if (requestLine === null) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  return { method: requestLine[1]!, version: requestLine[2]!, headers };
};

/**
 * Creates an observer for one client connection. Feed it every chunk the
 * client sends, in order; it calls `sendContinue` once per request head
 * that expects `100-continue`.
 */
export const makeExpectContinueObserver = (sendContinue: () => void) => {
  let state: State = head();

  /** State after a complete head: the body to skip, or off. */
  const afterHead = (parsed: ParsedHead | undefined): State => {
    if (parsed === undefined) return { _tag: "Off" };
    const { method, version, headers } = parsed;
    // A tunnel follows: nothing after this head is HTTP framing.
    if (method === "CONNECT" || headers.has("upgrade")) return { _tag: "Off" };
    // HTTP/1.0 requests' expectations must be ignored (RFC 9110 §10.1.1)
    if (
      version === "HTTP/1.1" &&
      headers.get("expect")?.toLowerCase() === "100-continue"
    ) {
      sendContinue();
    }
    const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
    if (transferEncoding !== undefined) {
      // Only a final `chunked` coding has self-delimiting framing
      return transferEncoding.split(",").at(-1)?.trim() === "chunked"
        ? { _tag: "ChunkSize", buffer: Buffer.alloc(0) }
        : { _tag: "Off" };
    }
    const contentLength = headers.get("content-length");
    if (contentLength === undefined) return head();
    if (!/^\d+$/.test(contentLength)) return { _tag: "Off" };
    const length = Number(contentLength);
    return length === 0 ? head() : { _tag: "Body", remaining: length };
  };

  const step = (chunk: Buffer): Buffer => {
    switch (state._tag) {
      case "Off":
        return Buffer.alloc(0);
      case "Head": {
        const buffer = Buffer.concat([state.buffer, chunk]);
        // Tolerate CRLFs between messages (RFC 9112 §2.2)
        let start = 0;
        while (buffer.subarray(start, start + 2).equals(CRLF)) start += 2;
        const end = buffer.indexOf(HEAD_END, start);
        if (end === -1) {
          state =
            buffer.length - start > MAX_HEAD_BYTES
              ? { _tag: "Off" }
              : { _tag: "Head", buffer: buffer.subarray(start) };
          return Buffer.alloc(0);
        }
        state = afterHead(parseHead(buffer.subarray(start, end)));
        return buffer.subarray(end + HEAD_END.length);
      }
      case "Body": {
        const taken = Math.min(state.remaining, chunk.length);
        state.remaining -= taken;
        if (state.remaining === 0) state = head();
        return chunk.subarray(taken);
      }
      case "ChunkSize": {
        const buffer = Buffer.concat([state.buffer, chunk]);
        const end = buffer.indexOf(CRLF);
        if (end === -1) {
          state =
            buffer.length > MAX_CHUNK_LINE_BYTES
              ? { _tag: "Off" }
              : { _tag: "ChunkSize", buffer };
          return Buffer.alloc(0);
        }
        const sizeField = latin1
          .decode(buffer.subarray(0, end))
          .split(";")[0]!
          .trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeField)) {
          state = { _tag: "Off" };
          return Buffer.alloc(0);
        }
        const size = Number.parseInt(sizeField, 16);
        state =
          size === 0
            ? { _tag: "Trailers", buffer: Buffer.alloc(0) }
            : { _tag: "ChunkData", remaining: size + CRLF.length };
        return buffer.subarray(end + CRLF.length);
      }
      case "ChunkData": {
        const taken = Math.min(state.remaining, chunk.length);
        state.remaining -= taken;
        if (state.remaining === 0) {
          state = { _tag: "ChunkSize", buffer: Buffer.alloc(0) };
        }
        return chunk.subarray(taken);
      }
      case "Trailers": {
        const buffer = Buffer.concat([state.buffer, chunk]);
        let offset = 0;
        for (;;) {
          const end = buffer.indexOf(CRLF, offset);
          if (end === -1) {
            const rest = buffer.subarray(offset);
            state =
              rest.length > MAX_HEAD_BYTES
                ? { _tag: "Off" }
                : { _tag: "Trailers", buffer: rest };
            return Buffer.alloc(0);
          }
          if (end === offset) {
            // Empty line: the message is complete
            state = head();
            return buffer.subarray(end + CRLF.length);
          }
          offset = end + CRLF.length;
        }
      }
    }
  };

  return {
    /** Observe the next chunk the client sent. */
    observe: (chunk: Buffer) => {
      let rest = chunk;
      while (rest.length > 0 && state._tag !== "Off") rest = step(rest);
    },
    /** Whether tracking stopped (exposed for tests). */
    get stopped() {
      return state._tag === "Off";
    },
  };
};
