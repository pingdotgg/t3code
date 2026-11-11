// Async (non-Effect) Worker that exercises the inbound `email()` handler
// against the local runtime's `/cdn-cgi/handler/email` trigger route.
// Referenced by path only (never value-imported by the test) so the
// top-level `cloudflare:email` import is evaluated exclusively inside
// workerd.
//
// Every `email()` invocation is recorded into a KV namespace (read back by
// the test via `GET /received`). The message subject drives extra behavior
// so one worker covers the accept/reject/reply cases:
// - `reject-me`   → `setReject(...)` (the trigger route answers 400)
// - `reply-me:<marker>` → `message.reply(new EmailMessage(...))` whose body
//   carries `reply-marker:<marker>` for the test to grep in the persisted
//   `.eml`.
import { EmailMessage } from "cloudflare:email";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

type Env = { KV: KVLike };

interface EmailMessageLike {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  setReject(reason: string): void;
  reply(message: unknown): Promise<{ messageId: string }>;
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/received") {
      const raw = await env.KV.get("received");
      return Response.json(raw ? JSON.parse(raw) : []);
    }
    return new Response("ok");
  },
  email: async (message: EmailMessageLike, env: Env) => {
    const subject = message.headers.get("subject") ?? "";
    const record = {
      from: message.from,
      to: message.to,
      rawSize: message.rawSize,
      raw: await new Response(message.raw).text(),
      subject,
      messageIdHeader: message.headers.get("message-id"),
    };
    const prior = await env.KV.get("received");
    const received: unknown[] = prior ? JSON.parse(prior) : [];
    received.push(record);
    await env.KV.put("received", JSON.stringify(received));

    if (subject === "reject-me") {
      await message.setReject("I don't like this email");
      return;
    }
    if (subject.startsWith("reply-me:")) {
      const marker = subject.slice("reply-me:".length);
      // The reply must be a valid RFC 5322 message whose `From:` matches the
      // reply envelope sender (the incoming envelope recipient), with an
      // `In-Reply-To` matching the incoming Message-ID and its own
      // Message-ID — the runtime validates all three before persisting.
      const replyRaw = [
        `From: recipient <${message.to}>`,
        `To: sender <${message.from}>`,
        `In-Reply-To: ${message.headers.get("message-id")}`,
        `Message-ID: <reply-${marker}@example.com>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain",
        "",
        `reply-marker:${marker}`,
      ].join("\n");
      await message.reply(new EmailMessage(message.to, message.from, replyRaw));
    }
  },
};
