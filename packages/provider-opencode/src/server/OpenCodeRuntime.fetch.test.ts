// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises undici response timeouts against a real local server.
import * as NodeHttp from "node:http";

import * as Undici from "undici";
import { describe, expect, it } from "vite-plus/test";

import { fetchWithoutResponseTimeouts } from "./OpenCodeRuntime.ts";

async function heldServer() {
  const held = new Map<string, NodeHttp.ServerResponse>();
  const waiters = new Map<string, () => void>();
  const server = NodeHttp.createServer((request, response) => {
    held.set(request.url!, response);
    waiters.get(request.url!)?.();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: (path: string) => `http://127.0.0.1:${address.port}${path}`,
    received: (path: string) =>
      held.has(path)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.set(path, resolve)),
    reply: (path: string) => held.get(path)!.end("true"),
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function withGlobalDispatcher(dispatcher: Undici.Dispatcher) {
  const previous = Undici.getGlobalDispatcher();
  Undici.setGlobalDispatcher(dispatcher);
  return {
    [Symbol.asyncDispose]: async () => {
      Undici.setGlobalDispatcher(previous);
      await dispatcher.close();
    },
  };
}

describe("fetchWithoutResponseTimeouts", () => {
  it("outlives the dispatcher's header timeout and still aborts", async () => {
    await using _dispatcher = withGlobalDispatcher(new Undici.Agent({ headersTimeout: 10 }));
    await using server = await heldServer();

    const command = fetchWithoutResponseTimeouts(
      new Request(server.url("/command"), { method: "POST", body: "{}" }),
    );
    await server.received("/command");

    // Starts after the command, so the command's header timer would have fired first.
    const probe = fetch(server.url("/probe"));
    await server.received("/probe");
    const probeError = await probe.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((probeError as Error).cause).toMatchObject({ code: "UND_ERR_HEADERS_TIMEOUT" });

    server.reply("/command");
    expect(await (await command).text()).toBe("true");

    const controller = new AbortController();
    const cancelled = fetchWithoutResponseTimeouts(
      new Request(server.url("/cancelled"), {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    );
    await server.received("/cancelled");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});
