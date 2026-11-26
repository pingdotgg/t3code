// @effect-diagnostics nodeBuiltinImport:off - proxies Metro's HTTP and inspector sockets.
/**
 * mobile:metrics' `--build release`: the dev client runs Metro's production bundle as `hermesc -O`
 * bytecode, like a store build, so timings and heap growth leave out React's and Hermes's dev
 * machinery. A proxy on the port the app opens answers bundle requests with that bytecode and passes
 * everything else, inspector websockets included, through to Metro.
 */
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "../scenarios/shell.ts";
import { DeviceError } from "./device.ts";

const BUNDLE_PATH =
  "/apps/mobile/index.ts.bundle?platform=ios&dev=false&hot=false&minify=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&transform.reactCompiler=true&unstable_transformProfile=hermes-stable";

/** The checkout's own hermesc, so the bytecode matches the Hermes in its dev client. */
function hermesc(checkout: string, host: string) {
  const fromApp = NodeModule.createRequire(NodePath.join(checkout, "apps/mobile/package.json"));
  const fromReactNative = NodeModule.createRequire(fromApp.resolve("react-native/package.json"));
  const platform = host === "darwin" ? "osx-bin" : "linux64-bin";
  return NodePath.join(
    NodePath.dirname(fromReactNative.resolve("hermes-compiler/package.json")),
    "hermesc",
    platform,
    "hermesc",
  );
}

// node:http, not fetch: Metro answers only once the bundle is built, past undici's header timeout.
const metroGet = (port: number, path: string) =>
  Effect.callback<Buffer, DeviceError>((resume) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resume(
          response.statusCode === 200
            ? Effect.succeed(body)
            : Effect.fail(
                new DeviceError({
                  message: `Metro's production bundle failed (${response.statusCode}): ${body.toString().slice(0, 500)}`,
                }),
              ),
        );
      });
    });
    request.on("error", (error) =>
      resume(Effect.fail(new DeviceError({ message: `Metro did not answer: ${error.message}` }))),
    );
    return Effect.sync(() => request.destroy());
  });

/** Metro's production bundle compiled to Hermes bytecode. */
const compile = Effect.fn("releaseBytecode.compile")(function* (input: {
  readonly metroPort: number;
  readonly checkout: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const js = NodePath.join(input.out, "release.bundle.js");
  yield* fs.writeFile(js, yield* metroGet(input.metroPort, BUNDLE_PATH));
  yield* run(hermesc(input.checkout, yield* HostProcess.Platform), [
    "-O",
    "-emit-binary",
    "-w",
    "-out",
    `${js}.hbc`,
    js,
  ]);
  return yield* fs.readFile(`${js}.hbc`);
});

/** Metro's text answers name its own port, which the app must not bypass the proxy for. */
function forward(metroPort: number, port: number) {
  return (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const headers = { ...request.headers };
    delete headers["accept-encoding"];
    const upstream = NodeHttp.request(
      { host: "127.0.0.1", port: metroPort, method: request.method, path: request.url, headers },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
          let body = Buffer.concat(chunks);
          if (/json|text|multipart/.test(String(answer.headers["content-type"] ?? "")))
            body = Buffer.from(body.toString("utf8").replaceAll(`:${metroPort}`, `:${port}`));
          const out = { ...answer.headers, "content-length": String(body.length) };
          delete out["transfer-encoding"];
          response.writeHead(answer.statusCode ?? 502, out);
          response.end(body);
        });
      },
    );
    upstream.on("error", (error) => {
      response.writeHead(502);
      response.end(String(error));
    });
    request.pipe(upstream);
  };
}

/** Metro's inspector accepts DevTools origins on its own port only. */
function forwardUpgrade(metroPort: number, port: number) {
  return (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
    const upstream = NodeNet.connect(metroPort, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        lines.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]?.replaceAll(`:${port}`, `:${metroPort}`)}`,
        );
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  };
}

/** Compiles the release bytecode, then serves it on `port` until the scope closes. */
export const serveReleaseBytecode = Effect.fn("releaseBytecode.serve")(function* (input: {
  readonly port: number;
  readonly metroPort: number;
  readonly checkout: string;
  readonly out: string;
}) {
  const bytecode = yield* compile(input);
  const toMetro = forward(input.metroPort, input.port);
  const server = NodeHttp.createServer((request, response) => {
    if (!/\.bundle(\?|$)/.test(request.url ?? "")) return toMetro(request, response);
    response.writeHead(200, {
      "content-type": "application/javascript",
      "content-length": String(bytecode.length),
    });
    response.end(bytecode);
  });
  server.on("upgrade", forwardUpgrade(input.metroPort, input.port));
  yield* Effect.acquireRelease(
    Effect.callback<void, DeviceError>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new DeviceError({ message: error.message }))),
      );
      server.listen(input.port, "0.0.0.0", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  return bytecode.length;
});
