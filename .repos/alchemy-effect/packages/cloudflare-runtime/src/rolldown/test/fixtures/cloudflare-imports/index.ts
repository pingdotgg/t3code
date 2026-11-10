import { durableObjectName } from "@fixtures/cloudflare-builtins";
import { connect } from "cloudflare:sockets";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export default {
  async fetch(request: Request) {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/external") {
      return Response.json({
        "(EXTERNAL) (cloudflare:workers) DurableObject.name": durableObjectName,
      });
    }

    return Response.json({
      "(cloudflare:workers) WorkerEntrypoint.name": WorkerEntrypoint.name,
      "(cloudflare:workers) DurableObject.name": DurableObject.name,
      "(cloudflare:sockets) typeof connect": typeof connect,
    });
  },
} satisfies ExportedHandler;
