/// <reference types="@cloudflare/workers-types" />

// Minimal worker fixture used by QueueConsumer.test.ts. The handler
// bodies are no-ops — the tests assert against the consumer
// registration, not against message delivery.
export default {
  fetch: async () => new Response("ok"),
  queue: async () => {},
};
