import handler from "vinext/server/fetch-handler";

export default {
  fetch(request: Request, env: unknown, ctx: Parameters<typeof handler.fetch>[2]) {
    return handler.fetch(request, env as Parameters<typeof handler.fetch>[1], ctx);
  },
};
