import type { Workflow } from "@cloudflare/workers-types";

export default {
  async fetch(
    request: Request,
    env: { MY_WORKFLOW: Workflow<{ value: string }> },
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
