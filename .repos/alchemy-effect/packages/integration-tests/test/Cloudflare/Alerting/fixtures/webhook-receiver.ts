// Minimal 200-responder used as a Notification webhook destination.
// Cloudflare fires a test POST when a webhook destination is created or
// updated; this worker answers 2xx for any method/path.
export default {
  fetch: async () => new Response("webhook-ok", { status: 200 }),
};
