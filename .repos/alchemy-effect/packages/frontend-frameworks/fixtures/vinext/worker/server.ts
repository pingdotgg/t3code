import handler from "vinext/server/fetch-handler";

// Deliberately not `index.ts`: Vinext's rsc environment also declares an
// `index` entry, which the Worker main must take over.
export default {
  fetch(request: Request, env: unknown, ctx: Parameters<typeof handler.fetch>[2]) {
    return handler.fetch(request, env as Parameters<typeof handler.fetch>[1], ctx);
  },
};
