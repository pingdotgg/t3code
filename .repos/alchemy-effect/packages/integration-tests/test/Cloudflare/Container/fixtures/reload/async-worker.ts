import { Container, getContainer } from "@cloudflare/containers";

/**
 * Container-backed Durable Object for the "running container survives a
 * Worker restart" reload case. `sleepAfter` keeps the container alive across
 * the redeploy so the replacement workerd generation finds it RUNNING.
 */
export class ReloadEchoObject extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
}

interface Env {
  ECHO: DurableObjectNamespace<ReloadEchoObject>;
  MARKER: string;
}

/**
 * - `GET /marker` → the `MARKER` env var (proves which generation serves)
 * - anything else → proxied to the echo server inside the container
 */
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/marker") {
      return new Response(env.MARKER);
    }
    return getContainer(env.ECHO, "default").fetch(request);
  },
};
