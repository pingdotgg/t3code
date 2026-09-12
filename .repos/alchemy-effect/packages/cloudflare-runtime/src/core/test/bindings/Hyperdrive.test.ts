import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Net from "node:net";
import * as Hyperdrive from "../../bindings/hyperdrive/Hyperdrive.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const HYPERDRIVE_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/info") {
      return Response.json({
        connectionString: env.HYP.connectionString,
        host: env.HYP.host,
        port: env.HYP.port,
        database: env.HYP.database,
        user: env.HYP.user,
      });
    }
    if (url.pathname === "/connect") {
      const socket = env.HYP.connect();
      const reader = socket.readable.getReader();
      const decoder = new TextDecoder();
      let output = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
        output += decoder.decode();
      } finally {
        try { await socket.close(); } catch {}
      }
      return new Response(output);
    }
    return new Response("not found", { status: 404 });
  },
};
`;

const startTcpEcho = (greeting: string) =>
  Effect.acquireRelease(
    Effect.callback<{ host: string; port: number; server: Net.Server }>(
      (resume) => {
        const server = Net.createServer((socket) => {
          socket.write(greeting);
          socket.end();
        });
        server.once("error", (err) => resume(Effect.die(err)));
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as Net.AddressInfo;
          resume(
            Effect.succeed({ host: "127.0.0.1", port: addr.port, server }),
          );
        });
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

layer(localRuntimeLayer)("Hyperdrive binding", (it) => {
  it.effect(
    "exposes the configured origin and connects to it via cloudflare:sockets",
    () =>
      Effect.gen(function* () {
        const greeting = "hello-hyperdrive\n";
        const origin = yield* startTcpEcho(greeting);
        const { fetch } = yield* startTestWorker({
          name: "hyperdrive-test",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: HYPERDRIVE_SCRIPT },
          ],
          hyperdrives: {
            db: {
              scheme: "postgresql",
              host: origin.host,
              port: origin.port,
              user: "alice",
              password: "s3cret",
              database: "mydb",
            },
          },
          bindings: [Hyperdrive.local("HYP", "db")],
        });

        const info = yield* fetch("/info");
        expect(yield* Effect.promise(() => info.json())).toEqual({
          connectionString: `postgresql://alice:s3cret@${origin.host}:${origin.port}/mydb`,
          host: origin.host,
          port: origin.port,
          database: "mydb",
          user: "alice",
        });

        const connected = yield* fetch("/connect");
        expect(yield* Effect.promise(() => connected.text())).toBe(greeting);
      }),
  );

  it.effect("fails with a ConfigError when the origin is missing", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "hyperdrive-missing",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [
          {
            name: "main.js",
            type: "ESModule",
            content: "export default { fetch: () => new Response('hi') };",
          },
        ],
        bindings: [Hyperdrive.local("HYP", "missing")],
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConfigError",
        subtag: "HyperdriveOriginMissing",
      });
    }),
  );
});
