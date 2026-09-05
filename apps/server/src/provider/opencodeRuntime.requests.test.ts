import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { checkOpenCodeProviderStatus } from "./Layers/OpenCodeProvider.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OpenCodeDriver } from "./Drivers/OpenCodeDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./Layers/ProviderEventLoggers.ts";
import { OpenCodeServerOwner } from "./OpenCodeServerOwner.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const directory = "C:\\Users\\example\\project";
const decodeOpenCodeSettings = Schema.decodeEffect(OpenCodeSettings);
const requests: Request[] = [];
function assertRequestDirectories(expectedDirectory: string | null) {
  for (const request of requests) {
    const readRequest = request.method === "GET" || request.method === "HEAD";
    const url = new URL(request.url);
    const queryDirectory = readRequest || url.pathname.endsWith("/fork");
    NodeAssert.equal(
      url.searchParams.get("directory"),
      queryDirectory ? expectedDirectory : null,
      request.url,
    );
    NodeAssert.equal(
      request.headers.get("x-opencode-directory"),
      !readRequest && expectedDirectory !== null ? encodeURIComponent(expectedDirectory) : null,
      request.url,
    );
    NodeAssert.equal(
      request.headers.get("authorization"),
      `Basic ${btoa("opencode:audit-only-password")}`,
    );
  }
}
const noSpawn = ChildProcessSpawner.make(() => Effect.die("This request test must not spawn"));
const testLayer = OpenCodeRuntimeLive.pipe(
  Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(OpenCodeServerOwner, {
      withServer: () => Effect.die("Configured external server must not acquire a local server"),
    }),
  ),
);

const driverLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "opencode-request-test-",
}).pipe(
  Layer.provideMerge(testLayer),
  Layer.provideMerge(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No external metadata requests are allowed")),
    ),
  ),
);

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const request = input instanceof Request ? input : new Request(input.toString());
    requests.push(request);
    const pathname = new URL(request.url).pathname;
    switch (pathname) {
      case "/proxy/global/health":
        return Response.json({ healthy: true, version: "1.14.19" });
      case "/proxy/provider":
        return Response.json({ connected: [], all: [], default: {} });
      case "/proxy/agent":
        return Response.json([]);
      case "/proxy/skill":
        return Response.json([
          {
            name: "audit-skill",
            location: "/server/skills/audit/SKILL.md",
            description: "Synthetic skill",
          },
        ]);
      case "/proxy/session":
        return Response.json({ id: "ses_audit_commit" });
      case "/proxy/session/ses_audit_commit/message":
        return Response.json({
          parts: [
            {
              type: "text",
              text: JSON.stringify({ subject: "Audit request routing", body: "Synthetic result." }),
            },
          ],
        });
      case "/proxy/session/ses_remote":
        return Response.json({ id: "ses_remote", directory: "/var/log" });
      case "/proxy/session/ses_forked":
      case "/proxy/session/ses_remote/fork":
        return Response.json({ id: "ses_forked", directory });
      case "/proxy/permission":
      case "/proxy/question":
      case "/proxy/session/ses_remote/children":
      case "/proxy/session/ses_forked/children":
        return Response.json([]);
      case "/proxy/session/ses_remote/abort":
      case "/proxy/session/ses_forked/abort":
        return Response.json(true);
      case "/proxy/event": {
        let closed = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'),
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  if (!closed) {
                    closed = true;
                    controller.close();
                  }
                },
                { once: true },
              );
            },
            cancel() {
              closed = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      default:
        throw new Error(`Unexpected intercepted request ${request.method} ${pathname}`);
    }
  });
});

it.layer(driverLayer)("OpenCode driver SDK requests", (it) => {
  for (const [label, serverUrl, expectedDirectory] of [
    ["remote", "http://opencode.example.test/proxy", null],
    ["external loopback", "http://localhost:4096/proxy", directory],
    ["managed", "", directory],
  ] as const) {
    for (const operation of ["skills", "text generation"] as const) {
      it.effect(`routes ${operation} requests for ${label}`, () =>
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const instance = yield* OpenCodeDriver.create({
            instanceId: ProviderInstanceId.make("opencode-directory-test"),
            displayName: "OpenCode fixture",
            enabled: true,
            environment: [],
            config: yield* decodeOpenCodeSettings({
              enabled: true,
              binaryPath: "/nonexistent/opencode-request-fixture",
              serverUrl,
              serverPassword: "audit-only-password",
            }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
            Effect.provideService(OpenCodeRuntime, {
              ...runtime,
              runOpenCodeCommand: () =>
                Effect.succeed({ stdout: "opencode 1.14.19\n", stderr: "", code: 0 }),
              startOpenCodeServerProcess: () =>
                Effect.succeed({
                  url: "http://127.0.0.1:4096/proxy",
                  serverPassword: "audit-only-password",
                  version: "1.14.19",
                  isRunning: Effect.succeed(true),
                  exitCode: Effect.never,
                }),
            }),
          );
          // Wait for the snapshot's refresh semaphore before observing workspace requests.
          yield* instance.snapshot.refresh;
          requests.length = 0;
          if (operation === "skills") {
            NodeAssert.ok(instance.snapshotForCwd);
            const snapshot = yield* instance.snapshotForCwd(directory);
            NodeAssert.deepEqual(
              snapshot.skills.map((skill) => skill.name),
              ["audit-skill"],
            );
            NodeAssert.ok(
              requests.some((request) => new URL(request.url).pathname === "/proxy/skill"),
            );
          } else {
            const result = yield* instance.textGeneration.generateCommitMessage({
              cwd: directory,
              branch: "audit/request-routing",
              stagedSummary: "M README.md",
              stagedPatch: "synthetic fixture patch",
              modelSelection: { instanceId: instance.instanceId, model: "openai/audit-model" },
            });
            NodeAssert.equal(result.subject, "Audit request routing");
            NodeAssert.ok(
              requests.some(
                (request) =>
                  new URL(request.url).pathname === "/proxy/session/ses_audit_commit/message",
              ),
            );
          }
          assertRequestDirectories(expectedDirectory);
        }).pipe(Effect.scoped),
      );
    }
  }
});

it.layer(driverLayer)("OpenCode resume request routing", (it) => {
  for (const [serverUrl, expectedSession, expectedDirectory] of [
    ["http://10.0.0.5:4096/proxy", "ses_remote", null],
    ["http://localhost:4096/proxy", "ses_forked", directory],
  ] as const) {
    it.effect(`preserves remote adoption or local cwd fork at ${serverUrl}`, () =>
      Effect.gen(function* () {
        const settings = yield* decodeOpenCodeSettings({
          enabled: true,
          serverUrl,
          serverPassword: "audit-only-password",
        });
        const adapter = yield* makeOpenCodeAdapter(settings);
        const threadId = ThreadId.make("remote-directory-resume-test");
        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          cwd: directory,
          resumeCursor: { schemaVersion: 1, sessionId: "ses_remote" },
        });
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: expectedSession,
        });
        const forkRequests = requests.filter((request) =>
          new URL(request.url).pathname.endsWith("/fork"),
        );
        NodeAssert.equal(forkRequests.length, expectedSession === "ses_forked" ? 1 : 0);
        NodeAssert.equal(
          requests.some(
            (request) =>
              request.method === "POST" && new URL(request.url).pathname === "/proxy/session",
          ),
          false,
        );
        const update = requests.find(
          (request) =>
            request.method === "PATCH" &&
            new URL(request.url).pathname === `/proxy/session/${expectedSession}`,
        );
        NodeAssert.ok(update);
        const updateBody = yield* Effect.promise(() => update.clone().json());
        NodeAssert.deepEqual(updateBody, {
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
          ],
        });
        assertRequestDirectories(expectedDirectory);
        const eventRequest = requests.find(
          (request) => new URL(request.url).pathname === "/proxy/event",
        );
        NodeAssert.ok(eventRequest);
        yield* adapter.stopSession(threadId);
        NodeAssert.equal(eventRequest.signal.aborted, true);
        assertRequestDirectories(expectedDirectory);
      }).pipe(Effect.scoped),
    );
  }
});

afterEach(() => vi.unstubAllGlobals());

it.layer(testLayer)("OpenCode remote directory requests", (it) => {
  for (const serverUrl of [
    "http://opencode.example.test/proxy",
    "http://10.0.0.5:4096/proxy",
    "http://localhost:4096/proxy",
    "http://127.0.0.1:4096/proxy",
  ]) {
    const isLoopback = serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
    it.effect(`routes actual initial health and inventory requests at ${serverUrl}`, () =>
      Effect.gen(function* () {
        const settings = yield* decodeOpenCodeSettings({
          enabled: true,
          serverUrl,
          serverPassword: "audit-only-password",
        });
        const snapshot = yield* checkOpenCodeProviderStatus(settings, directory);
        NodeAssert.equal(snapshot.version, "1.14.19", snapshot.message ?? undefined);
        NodeAssert.deepEqual(requests.map((request) => new URL(request.url).pathname).toSorted(), [
          "/proxy/agent",
          "/proxy/global/health",
          "/proxy/provider",
          "/proxy/skill",
        ]);
        assertRequestDirectories(isLoopback ? directory : null);
      }),
    );
  }
});
