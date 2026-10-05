/**
 * Inbound email worker: drive it locally by POSTing a raw MIME message to
 * `/cdn-cgi/handler/email?from=...&to=...`. The `email()` handler records
 * every message into the INBOX KV namespace (read back via
 * `GET /email/received`); a subject starting with `reject-me` is rejected
 * via `setReject`, which the sender observes as a 400.
 *
 * NOTE: this handler lives on its own worker (not MediaWorker) because in
 * local dev the images/stream simulators insert a fetch-only middleware
 * between the dev entry and the user worker, which currently swallows the
 * entry's RPC dispatch of non-fetch events (`email()`, `queue()`,
 * `scheduled()`). Keep inbound email handlers on workers without images or
 * stream bindings until that is fixed in the local runtime.
 */
interface InboxKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  INBOX: InboxKV;
}

interface InboundEmailLike {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  // `void` in production; locally the message crosses JSRPC, so the call
  // returns a promise that must be awaited for the rejection to register.
  setReject(reason: string): void | Promise<void>;
  reply(message: unknown): Promise<{ messageId: string }>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/email/received") {
      const raw = await env.INBOX.get("received");
      return Response.json(raw ? JSON.parse(raw) : []);
    }
    return new Response("ok");
  },

  async email(message: InboundEmailLike, env: Env): Promise<void> {
    const subject = message.headers.get("subject") ?? "";
    const record = {
      from: message.from,
      to: message.to,
      rawSize: message.rawSize,
      subject,
      messageIdHeader: message.headers.get("message-id"),
    };
    const prior = await env.INBOX.get("received");
    const received: unknown[] = prior ? JSON.parse(prior) : [];
    received.push(record);
    await env.INBOX.put("received", JSON.stringify(received));

    if (subject.startsWith("reject-me")) {
      await message.setReject("I don't like this email");
    }
  },
};
