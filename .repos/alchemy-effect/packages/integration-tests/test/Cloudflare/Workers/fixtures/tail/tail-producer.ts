/**
 * Async (non-Effect) producer fixture for `TailConsumers.local.test.ts`.
 *
 * Logs a stable marker on every request so each invocation produces trace
 * events for the tail consumers attached via `tailConsumers` — the local
 * test polls the consumer's `/events` route for a batch carrying this
 * marker (trace `scriptName` is workerd's internal service name locally,
 * so the marker — not the script name — anchors the assertion).
 *
 * The marker string is duplicated in `TailConsumers.local.test.ts`: the
 * default export must be this module's ONLY export — extra named exports
 * surface as workerd top-level exports and fail startup validation
 * ("Incorrect type for map entry ...: not of type 'function or
 * ExportedHandler'").
 */

export default {
  async fetch(): Promise<Response> {
    console.log("alchemy-local-tail-marker");
    return new Response("producer-ok");
  },
};
