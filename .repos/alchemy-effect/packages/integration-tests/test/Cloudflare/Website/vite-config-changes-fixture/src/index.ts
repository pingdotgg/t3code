// Mirrors `@cloudflare/vite-plugin`'s `playground/config-changes`.
// @ts-expect-error -- `abortIsolate` is an internal runtime test hook.
import { abortIsolate } from "cloudflare:workers";

interface Env {
  MY_VAR: string;
  MY_SECRET: string;
}

const runtimeId = crypto.randomUUID();

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__crash-workerd") {
      abortIsolate("Vite runtime restart test");
    }
    if (pathname === "/__runtime-id") {
      return new Response(runtimeId);
    }
    return new Response(
      `The value of MY_VAR is "${env.MY_VAR}" and the value of MY_SECRET is "${env.MY_SECRET}"`,
    );
  },
} satisfies ExportedHandler<Env>;
