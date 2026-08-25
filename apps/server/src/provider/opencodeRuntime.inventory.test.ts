import * as NodeAssert from "node:assert/strict";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import {
  isOpenCodeV2VersionOutput,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
} from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
const encodeServiceRegistration = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      url: Schema.String,
      pid: Schema.Number,
      password: Schema.String,
    }),
  ),
);

const withOpenCodeHttpServer = <A, E, R>(
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      return address && typeof address !== "string"
        ? run(`http://127.0.0.1:${address.port}`)
        : Effect.die(new Error("Expected a TCP address"));
    },
    (server) => Effect.sync(() => server.close()),
  );

const createOpenCodeBinary = (name: string, source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostEnvironment = yield* HostProcessEnvironment;
    const executablePath = yield* HostProcessExecutablePath;
    const hostPlatform = yield* HostProcessPlatform;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-v2-" });
    const isWindows = hostPlatform === "win32";
    const binaryPath = path.join(tempDir, isWindows ? `${name}.cmd` : name);
    const scriptPath = path.join(tempDir, `${name}.mjs`);

    yield* fs.writeFileString(scriptPath, source);
    yield* fs.writeFileString(
      binaryPath,
      [
        ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
        isWindows
          ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
          : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
        "",
      ].join("\n"),
    );
    if (!isWindows) yield* fs.chmod(binaryPath, 0o755);

    return {
      binaryPath,
      tempDir,
      environment: {
        ...hostEnvironment,
        T3_TEST_NODE_BINARY: executablePath,
        T3_TEST_OPENCODE_SCRIPT: scriptPath,
      },
    };
  });

const openCodeV2FixtureScript = `
import http from "node:http";

if (process.argv[2] === "--version") {
  console.log("opencode2 v0.0.0-beta-18155");
} else if (process.argv[2] === "serve") {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password || process.env.OPENCODE_PASSWORD !== password) {
    throw new Error("Expected a generated OpenCode server password");
  }
  if (
    process.env.T3_TEST_EXPECTED_CONFIG !== undefined &&
    process.env.OPENCODE_CONFIG_CONTENT !== process.env.T3_TEST_EXPECTED_CONFIG
  ) {
    throw new Error("Expected the inherited OpenCode config to be preserved");
  }
  const hostname = process.argv.find((arg) => arg.startsWith("--hostname="))?.split("=")[1];
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1]);
  const directory = process.env.T3_TEST_DIRECTORY ?? process.cwd();
  const location = {
    directory,
    project: { id: "project-test", directory, canonical: directory },
  };
  const model = {
    id: "gpt-test",
    modelID: "gpt-test",
    providerID: "openai",
    name: "GPT Test",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 32000 },
  };
  const server = http.createServer((request, response) => {
    const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const data = pathname === "/api/provider"
      ? [{ id: "openai", name: "OpenAI", activation: "enabled", package: "openai" }]
      : pathname === "/api/model"
        ? [model]
        : pathname === "/api/model/default"
          ? model
          : pathname === "/api/agent"
            ? [{
                id: "build",
                name: "build",
                request: { settings: {}, headers: {}, body: {} },
                mode: "primary",
                hidden: false,
                permissions: [],
              }]
            : pathname === "/api/skill"
              ? [{
                  id: "review",
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "x".repeat(220 * 1024),
                }]
              : undefined;
    if (pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        healthy: true,
        version: "0.0.0-beta-18155",
        pid: process.pid,
        config: process.env.OPENCODE_CONFIG_CONTENT,
      }));
      return;
    }
    if (data === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ location, data }));
  });
  server.listen(port, hostname, () => console.log("server listening on http://" + hostname + ":" + port));
} else {
  throw new Error("Unsupported OpenCode 2 command: " + process.argv.slice(2).join(" "));
}
`;

it.layer(testLayer, { excludeTestServices: true })("OpenCodeRuntime inventory", (it) => {
  it.effect("recognizes OpenCode 2 version output even through an opencode symlink", () =>
    Effect.sync(() => {
      NodeAssert.equal(isOpenCodeV2VersionOutput("opencode2 v0.0.0-dev-18192\n", "opencode"), true);
      NodeAssert.equal(isOpenCodeV2VersionOutput("0.0.0-beta-18155\n", "opencode"), true);
      NodeAssert.equal(isOpenCodeV2VersionOutput("2.1.0\n", "/usr/local/bin/opencode2"), true);
      NodeAssert.equal(isOpenCodeV2VersionOutput("opencode 1.14.19\n", "opencode"), false);
    }),
  );

  it.effect("falls back to opencode2 only for the default opencode binary", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fixture = yield* createOpenCodeBinary(
        "opencode2",
        'console.log("opencode2 v0.0.0-beta-18155");\n',
      );
      const environment = { ...fixture.environment, PATH: fixture.tempDir };
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: "opencode",
        args: ["--version"],
        environment,
      });

      NodeAssert.match(result.stdout, /opencode2 v0\.0\.0-beta-18155/);

      const missingCustomBinary = yield* runtime
        .runOpenCodeCommand({
          binaryPath: "custom-opencode",
          args: ["--version"],
          environment,
        })
        .pipe(Effect.flip);
      NodeAssert.match(missingCustomBinary.detail, /custom-opencode/);
    }),
  );

  it.effect("starts v2 symlink-style binaries with generated Basic auth and inherited config", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fixture = yield* createOpenCodeBinary("opencode", openCodeV2FixtureScript);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* runtime.startOpenCodeServerProcess({
            binaryPath: fixture.binaryPath,
            environment: {
              ...fixture.environment,
              OPENCODE_PASSWORD: "inherited-password",
              OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
              T3_TEST_EXPECTED_CONFIG: '{"provider":{"openai":{}}}',
            },
          });
          NodeAssert.equal(server.apiVersion, "v2");
          NodeAssert.ok(server.serverPassword);
          NodeAssert.ok(server.serverPassword.length >= 40);
          NodeAssert.notEqual(server.serverPassword, "inherited-password");

          const environment = {
            ...fixture.environment,
            OPENCODE_PASSWORD: undefined,
            OPENCODE_SERVER_PASSWORD: undefined,
          };
          const unauthorized = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: fixture.binaryPath,
              serverUrl: server.url,
              environment,
            })
            .pipe(Effect.flip);
          NodeAssert.match(unauthorized.detail, /requires authentication.*401/);

          const authorized = yield* runtime.connectToOpenCodeServer({
            binaryPath: fixture.binaryPath,
            serverUrl: server.url,
            serverPassword: server.serverPassword,
            environment,
          });
          NodeAssert.equal(authorized.apiVersion, "v2");
        }),
      );
    }),
  );

  it.effect("continues to recognize the original OpenCode 1 startup banner", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fixture = yield* createOpenCodeBinary(
        "legacy-opencode",
        [
          'if (process.argv[2] === "--version") {',
          '  console.log("opencode 1.14.19");',
          "} else {",
          '  const hostname = process.argv.find((arg) => arg.startsWith("--hostname=")).split("=")[1];',
          '  const port = process.argv.find((arg) => arg.startsWith("--port=")).split("=")[1];',
          '  console.log("opencode server listening on http://" + hostname + ":" + port);',
          "  setInterval(() => {}, 1000);",
          "}",
          "",
        ].join("\n"),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* runtime.startOpenCodeServerProcess({
            binaryPath: fixture.binaryPath,
            environment: fixture.environment,
          });
          NodeAssert.equal(server.apiVersion, "v1");
          NodeAssert.equal(server.serverPassword, undefined);
          NodeAssert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        }),
      );
    }),
  );

  it.effect("detects external v2 servers with an authenticated health request", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const password = "external-password";
      let authorization: string | undefined;

      return yield* withOpenCodeHttpServer(
        (request, response) => {
          authorization = request.headers.authorization;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ healthy: true, version: "0.0.0-beta-18155", pid: 42 }));
        },
        (origin) =>
          Effect.gen(function* () {
            const connection = yield* runtime.connectToOpenCodeServer({
              binaryPath: "opencode",
              serverUrl: origin,
              serverPassword: password,
            });

            NodeAssert.equal(connection.external, true);
            NodeAssert.equal(connection.apiVersion, "v2");
            NodeAssert.equal(connection.serverPassword, password);
            NodeAssert.equal(
              authorization,
              `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
            );
          }),
      );
    }),
  );

  it.effect("retains friendly authentication failures from external v2 probes", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;

      return yield* withOpenCodeHttpServer(
        (_request, response) => {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Unauthorized" }));
        },
        (origin) =>
          Effect.gen(function* () {
            const error = yield* runtime
              .connectToOpenCodeServer({
                binaryPath: "opencode",
                serverUrl: origin,
                serverPassword: "incorrect-password",
              })
              .pipe(Effect.flip);

            NodeAssert.match(error.detail, /rejected authentication.*401/);
          }),
      );
    }),
  );

  it.effect("falls back to v1 when an external health endpoint is not JSON", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;

      return yield* withOpenCodeHttpServer(
        (_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<!doctype html><title>OpenCode</title>");
        },
        (origin) =>
          Effect.gen(function* () {
            const connection = yield* runtime.connectToOpenCodeServer({
              binaryPath: "opencode",
              serverUrl: origin,
            });

            NodeAssert.equal(connection.apiVersion, "v1");
            NodeAssert.equal(connection.external, true);
          }),
      );
    }),
  );

  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error("skills endpoint unavailable")),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "unused skill content",
                },
              ],
            }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          location: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("loads untruncated v2 inventory from an existing authenticated shared service", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const stateHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-v2-service-" });
      const password = "shared-service-password";
      const requestedPaths: string[] = [];
      const directory = stateHome;
      const location = {
        directory,
        project: { id: "project-test", directory, canonical: directory },
      };

      return yield* withOpenCodeHttpServer(
        (request, response) => {
          const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
          if (request.headers.authorization !== expected) {
            response.writeHead(401);
            response.end();
            return;
          }

          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          requestedPaths.push(pathname);
          response.writeHead(200, { "content-type": "application/json" });
          if (pathname === "/api/health") {
            response.end(
              JSON.stringify({
                healthy: true,
                version: "0.0.0-beta-18155",
                pid: process.pid,
              }),
            );
            return;
          }

          const model = {
            id: "gpt-test",
            modelID: "gpt-test",
            providerID: "openai",
            name: "GPT Test",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 32_000 },
          };
          const data =
            pathname === "/api/provider"
              ? [{ id: "openai", name: "OpenAI", activation: "enabled", package: "openai" }]
              : pathname === "/api/model"
                ? [model]
                : pathname === "/api/model/default"
                  ? model
                  : pathname === "/api/agent"
                    ? [
                        {
                          id: "build",
                          name: "build",
                          request: { settings: {}, headers: {}, body: {} },
                          mode: "primary",
                          hidden: false,
                          permissions: [],
                        },
                      ]
                    : pathname === "/api/skill"
                      ? [
                          {
                            id: "review",
                            name: "review",
                            description: "Review code changes",
                            location: "/skills/review/SKILL.md",
                            content: "x".repeat(220 * 1024),
                          },
                        ]
                      : [];
          response.end(JSON.stringify({ location, data }));
        },
        (origin) =>
          Effect.gen(function* () {
            const serviceDirectory = path.join(stateHome, "opencode");
            yield* fs.makeDirectory(serviceDirectory, { recursive: true });
            yield* fs.writeFileString(
              path.join(serviceDirectory, "service.json"),
              encodeServiceRegistration({
                id: "test-service",
                version: "0.0.0-beta-18155",
                url: origin,
                pid: process.pid,
                password,
              }),
            );

            const inventory = yield* runtime.loadInventoryFromCli({
              binaryPath: "/missing/opencode2",
              cwd: directory,
              environment: { ...hostEnvironment, XDG_STATE_HOME: stateHome },
              apiVersion: "v2",
            });

            NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
            NodeAssert.equal(inventory.agents[0]?.name, "build");
            NodeAssert.deepEqual(inventory.skills, [
              {
                name: "review",
                description: "Review code changes",
                location: "/skills/review/SKILL.md",
              },
            ]);
            NodeAssert.ok(requestedPaths.includes("/api/provider"));
            NodeAssert.ok(requestedPaths.includes("/api/model"));
            NodeAssert.ok(requestedPaths.includes("/api/skill"));
          }),
      );
    }),
  );

  it.effect("uses a scoped authenticated v2 server when no shared service is registered", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fixture = yield* createOpenCodeBinary("opencode2", openCodeV2FixtureScript);
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath: fixture.binaryPath,
        cwd: fixture.tempDir,
        environment: {
          ...fixture.environment,
          XDG_STATE_HOME: fixture.tempDir,
          T3_TEST_DIRECTORY: fixture.tempDir,
        },
        apiVersion: "v2",
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.agents[0]?.name, "build");
      NodeAssert.equal(inventory.skills[0]?.name, "review");
    }),
  );

  it.effect("drops oversized CLI skill output without losing the model inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-inventory-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const oversizedContentBytes = 8 * 1024 * 1024 + 1;

      yield* fs.writeFileString(
        scriptPath,
        [
          'if (process.argv[2] === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (process.argv[2] === "debug") {',
          `  const content = "x".repeat(${oversizedContentBytes});`,
          '  process.stdout.write(`[{"name":"oversized","content":"${content}"}]`);',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.skills.length, 0);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});
