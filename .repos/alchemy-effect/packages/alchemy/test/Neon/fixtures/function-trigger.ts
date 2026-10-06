import { FunctionTriggerEnvelope } from "@/Neon/FunctionTriggerEvent";
import * as Schema from "effect/Schema";

const events = new Map<string, FunctionTriggerEnvelope>();
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/events")
      return Response.json([...events.values()]);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const invocation = request.headers.get("x-neon-trigger-invocation-id");
    if (!invocation) return new Response(null, { status: 403 });
    let event: FunctionTriggerEnvelope;
    try {
      event = Schema.decodeUnknownSync(FunctionTriggerEnvelope)(
        await request.json(),
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    if (event.invocation_id !== invocation)
      return new Response(null, { status: 400 });
    if (!events.has(invocation)) events.set(invocation, event);
    return new Response(null, { status: 204 });
  },
};
