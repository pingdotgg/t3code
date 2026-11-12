// Mirrors `@cloudflare/vite-plugin`'s `playground/containers`: Durable Objects
// drive their containers through the native `ctx.container` API. The
// `dockerfile` class's container is built from `../Dockerfile`; the
// `named-images` class reads the same build from `ctx.container.images`.
import { DurableObject } from "cloudflare:workers";

class ContainerObject extends DurableObject {
  override async fetch(req: Request) {
    const container = this.ctx.container;
    if (container === undefined) {
      return new Response("Container is not configured.", { status: 404 });
    }
    const images = (container as unknown as { images: Record<string, string> }).images;
    const path = new URL(req.url).pathname;
    switch (path) {
      case "/status":
        return new Response(JSON.stringify(container.running));

      case "/images":
        return Response.json(Object.keys(images));

      case "/start":
        container.start({
          ...(images.app === undefined ? {} : ({ image: images.app } as {})),
          entrypoint: ["node", "app.js"],
          env: { A: "B", C: "D", L: "F", MESSAGE: "from vite" },
          enableInternet: false,
        });
        // this doesn't instantly start, so we will need to poll /fetch
        return new Response("Container create request sent...");

      case "/fetch": {
        const res = await container
          .getTcpPort(8080)
          // actual request doesn't matter
          .fetch("http://foo/bar/baz", { method: "POST", body: "hello" });
        return new Response(await res.text());
      }

      default:
        return new Response("Hi from Container DO");
    }
  }
}

export class DockerfileContainer extends ContainerObject {}
export class NamedImagesContainer extends ContainerObject {}

type Exports = {
  DockerfileContainer: DurableObjectNamespace<DockerfileContainer>;
  NamedImagesContainer: DurableObjectNamespace<NamedImagesContainer>;
};

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const exports = ctx.exports as unknown as Exports;

    let service: Fetcher | undefined;
    let prefix = "";
    if (url.pathname === "/dockerfile" || url.pathname.startsWith("/dockerfile/")) {
      service = exports.DockerfileContainer.getByName("container");
      prefix = "/dockerfile";
    } else if (url.pathname === "/named-images" || url.pathname.startsWith("/named-images/")) {
      service = exports.NamedImagesContainer.getByName("container");
      prefix = "/named-images";
    }

    if (!service) {
      return new Response("Not found. Use `/dockerfile/...` or `/named-images/...`.", {
        status: 404,
      });
    }

    const forwardedUrl = new URL(url);
    forwardedUrl.pathname = url.pathname.slice(prefix.length) || "/";
    return service.fetch(new Request(forwardedUrl.toString(), request));
  },
} satisfies ExportedHandler;
