// Mirrors `@cloudflare/vite-plugin`'s `playground/partyserver`: PartyServer
// routes `/parties/my-server/<room>` WebSockets to the `MyServer` Durable
// Object binding, and everything else falls through to the assets.
import { routePartykitRequest, Server } from "partyserver";
import type { Connection } from "partyserver";

interface Env extends Record<string, unknown> {
  ASSETS: Fetcher;
  MyServer: DurableObjectNamespace<MyServer>;
}

export class MyServer extends Server<Env> {
  override onMessage(connection: Connection<unknown>, message: string) {
    connection.send(`Message from the server: received '${message}'`);
  }
}

export default {
  async fetch(request, env) {
    const response = await routePartykitRequest(request, env);

    return response ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
