/**
 * Async (non-Effect) producer fixture for
 * `StreamingTailConsumers.local.test.ts`.
 *
 * Logs a stable marker on every request so each invocation produces a
 * streaming tail session (onset → log → outcome) for the consumers attached
 * via `streamingTailConsumers` — the local test polls the consumer's
 * `/events` route for a recorded session carrying this marker.
 *
 * The marker string is duplicated in `StreamingTailConsumers.local.test.ts`:
 * the default export must be this module's ONLY export — extra named exports
 * surface as workerd top-level exports and fail startup validation
 * ("Incorrect type for map entry ...: not of type 'function or
 * ExportedHandler'").
 */

export default {
  async fetch(): Promise<Response> {
    console.log("alchemy-local-streaming-tail-marker");
    return new Response("streaming-producer-ok");
  },
};
