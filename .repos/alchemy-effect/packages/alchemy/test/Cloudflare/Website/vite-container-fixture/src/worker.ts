import { Container } from "@cloudflare/containers";

/**
 * Container-backed Durable Object class hosted by a Vite Worker (issue #997):
 * the `Cloudflare.Container` declaration on the site's `env` is the DO
 * namespace binding plus its ContainerApplication. `Container.fetch` starts
 * the container on demand and forwards requests to the echo server listening
 * on port 8080 inside it.
 */
export class EchoObject extends Container {
  defaultPort = 8080;
}

type EchoStub = {
  fetch(request: Request): Promise<Response>;
};

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  ECHO: {
    getByName(name: string): EchoStub;
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/echo") {
      return env.ECHO.getByName("vite-container-fixture").fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
