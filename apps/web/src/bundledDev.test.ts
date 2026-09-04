// @effect-diagnostics nodeBuiltinImport:off - builds and executes real dev bundles on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import react from "@vitejs/plugin-react";
import { createLogger, createServer } from "vite-plus";
import { expect, it } from "vite-plus/test";

import { tailwindPlugins } from "../vite/tailwind";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it("initializes React refresh before a shared UI chunk runs in bundled dev", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bootstrap-"));
  const output = NodePath.join(root, "output");
  let resolveBundle!: (files: Map<string, string>) => void;
  let rejectBundle!: (error: unknown) => void;
  const bundled = new Promise<Map<string, string>>((resolve, reject) => {
    resolveBundle = resolve;
    rejectBundle = reject;
  });
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  try {
    await NodeFSP.mkdir(NodePath.join(root, "src/lib"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    for (const file of ["index.html", "src/bootstrap.ts", "src/lib/bootError.ts"]) {
      await NodeFSP.copyFile(new URL(`../${file}`, import.meta.url), NodePath.join(root, file));
    }
    await NodeFSP.writeFile(
      NodePath.join(root, "src/shared.tsx"),
      "export function Shared() { return <div>ready</div>; }",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "src/main.tsx"),
      `import { Shared } from "./shared";
export const startup = Promise.resolve().then(() => globalThis.onStarted(Shared()));`,
    );

    server = await createServer({
      configFile: false,
      root,
      publicDir: NodeURL.fileURLToPath(new URL("../public", import.meta.url)),
      logLevel: "silent",
      resolve: {
        alias: { react: NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("react"))) },
      },
      experimental: { bundledDev: true },
      plugins: [
        react(),
        {
          name: "capture-bootstrap-bundle",
          buildEnd(error) {
            if (error) rejectBundle(error);
          },
          generateBundle(_options, bundle) {
            resolveBundle(
              new Map(
                Object.values(bundle)
                  .filter((file) => file.type === "chunk")
                  .map((file) => [file.fileName, file.code]),
              ),
            );
          },
        },
      ],
      build: {
        rolldownOptions: {
          experimental: { devMode: { lazy: false } },
          output: {
            // Reproduce the shared chunks Vite creates after lazy routes load,
            // without needing a browser to trigger the lazy compiler first.
            codeSplitting: {
              groups: [
                { name: "vendor", test: /node_modules|@react-refresh/, priority: 10 },
                { name: "shared-ui", test: /shared\.tsx$/, includeDependenciesRecursively: false },
              ],
            },
          },
        },
      },
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    for (const [file, code] of await bundled) {
      const target = NodePath.join(output, file);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, code);
    }

    // Run the actual generated ES modules so their import order and refresh
    // checks execute. These stubs replace only the browser and HMR transport.
    const runner = NodePath.join(output, "check.mjs");
    await NodeFSP.writeFile(
      runner,
      `import assert from "node:assert/strict";
const started = Promise.withResolvers();
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ relList: { supports: () => true } }),
  getElementById: () => null,
};
globalThis.__rolldown_runtime__ = {
  registerGraph() {},
  registerModule() {},
  createModuleHotContext: () => ({ accept() {} }),
};
globalThis.onStarted = started.resolve;
console.error = (_message, error) => started.reject(error);
await import("./assets/index.js");
const element = await started.promise;
assert.equal(element.props.children, "ready");
assert.equal(typeof window.$RefreshReg$, "function");
console.log("App started with React refresh ready.");`,
    );
    const result = await execFile("node", [runner]);
    expect(result.stdout).toContain("App started with React refresh ready.");
  } finally {
    await server?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("hot updates Tailwind classes when a source file changes in bundled dev", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tailwind-"));
  const events = new NodeEvents.EventEmitter();
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let socket: WebSocket | undefined;
  let css = "";

  try {
    await NodeFSP.writeFile(
      NodePath.join(root, "index.html"),
      '<html><body><script type="module" src="/main.ts"></script></body></html>',
    );
    const source =
      'import "./style.css"; export const margin = "m-[13px]"; import.meta.hot?.accept();';
    await NodeFSP.writeFile(NodePath.join(root, "main.ts"), source);
    await NodeFSP.writeFile(
      NodePath.join(root, "style.css"),
      '@import "tailwindcss" source(none); @source "./main.ts";',
    );
    const logger = createLogger("silent");
    logger.error = (message) => events.emit("error", new Error(message));
    const built = NodeEvents.EventEmitter.once(events, "built");
    server = await createServer({
      configFile: false,
      root,
      customLogger: logger,
      resolve: {
        alias: {
          tailwindcss: NodeURL.fileURLToPath(
            new URL("../node_modules/tailwindcss/index.css", import.meta.url),
          ),
        },
      },
      experimental: { bundledDev: true },
      plugins: [
        ...tailwindPlugins(true),
        {
          name: "observe-tailwind-output",
          enforce: "pre",
          transform(code, id) {
            if (id.endsWith("/style.css")) css = code;
          },
          generateBundle() {
            events.emit("built");
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    await built;
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not bind a port");

    const connected = NodeEvents.EventEmitter.once(events, "connected");
    server.ws.on("vite:client-connected", () => events.emit("connected"));
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
      "vite-hmr",
    );
    socket.addEventListener("open", () => {
      socket?.send(
        JSON.stringify({
          type: "custom",
          event: "vite:client-connected",
          data: { clientId: "tailwind-test" },
        }),
      );
    });
    socket.addEventListener("message", ({ data }) => {
      const message: unknown = JSON.parse(String(data));
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "bundled-dev-update"
      ) {
        events.emit("updated");
      }
    });
    await connected;
    const entry = await fetch(`http://127.0.0.1:${address.port}/assets/index.js`);
    expect(entry.headers.get("content-type")).toContain("javascript");
    await entry.text();

    const updated = NodeEvents.EventEmitter.once(events, "updated");
    await NodeFSP.writeFile(NodePath.join(root, "main.ts"), source.replace("13px", "137px"));
    await updated;
    expect(css).toContain("margin: 137px");
  } finally {
    socket?.close();
    await server?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
