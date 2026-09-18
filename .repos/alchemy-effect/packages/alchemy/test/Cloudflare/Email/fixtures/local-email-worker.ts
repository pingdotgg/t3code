// Async (non-Effect) Worker that exercises a native `send_email` binding
// against the local simulator. Referenced by path only (never value-imported
// by the test) so the top-level `cloudflare:email` import is evaluated
// exclusively inside workerd.
import { EmailMessage } from "cloudflare:email";

interface SendEmailLike {
  send(message: unknown): Promise<{ messageId: string }>;
}

type Env = { EMAIL: SendEmailLike };

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/send-raw") {
        // EmailMessage API: raw MIME message carrying a per-run marker the
        // test greps for in the persisted `.eml`.
        const marker = url.searchParams.get("marker") ?? "no-marker";
        const raw = [
          "From: sender <sender@example.com>",
          "To: recipient <allowed@example.com>",
          `Message-ID: <${marker}@example.com>`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "",
          `marker:${marker}`,
        ].join("\r\n");
        const result = await env.EMAIL.send(
          new EmailMessage("sender@example.com", "allowed@example.com", raw),
        );
        return Response.json({ ok: true, messageId: result.messageId });
      }
      if (url.pathname === "/send-builder") {
        // MessageBuilder API: destination from the query string so the test
        // can exercise both the allowed and the disallowed address.
        const to = url.searchParams.get("to") ?? "allowed@example.com";
        const result = await env.EMAIL.send({
          from: "sender@example.com",
          to,
          subject: "local send_email test",
          text: "hello from the local simulator",
        });
        return Response.json({ ok: true, messageId: result.messageId });
      }
      return new Response("ok");
    } catch (e) {
      return Response.json(
        { ok: false, message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
};
