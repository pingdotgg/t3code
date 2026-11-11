import handler from "vinext/server/fetch-handler";

// A custom entry (`Website.Vinext({ main })`) that marks its responses and
// logs on every request, so tests can tell it is the Worker serving.
export default {
  async fetch(request: Request, env: unknown, ctx: Parameters<typeof handler.fetch>[2]) {
    console.log("vinext-custom-entry");
    const response = await handler.fetch(request, env as Parameters<typeof handler.fetch>[1], ctx);
    const marked = new Response(response.body, response);
    marked.headers.set("x-alchemy-entry", "custom");
    return marked;
  },
};
