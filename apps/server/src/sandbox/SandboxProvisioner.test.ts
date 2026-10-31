import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { EnvironmentId, SandboxProviderError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import type { SandboxRecord } from "@t3tools/contracts";
import { requestJson } from "./SandboxProvider.ts";
import { boatDriver } from "./providers/boat.ts";
import { daytonaDriver } from "./providers/daytona.ts";
import { vercelDriver } from "./providers/vercel.ts";

const boatSandboxId = "bx_abcdefgh";
const testEnvironmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const descriptor = {
  environmentId: testEnvironmentId,
  label: "Boat live test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.6",
  orchestrationProtocolVersion: 2,
  capabilities: {},
};

const recordRepository = Layer.succeed(
  SandboxRecords.SandboxRecordRepository,
  SandboxRecords.SandboxRecordRepository.of({
    list: Effect.succeed([]),
    get: () => Effect.succeedNone,
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
);

const provisionerLayer = (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  repository: Layer.Layer<SandboxRecords.SandboxRecordRepository> = recordRepository,
) =>
  SandboxProvisioner.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provide(repository),
    Layer.provide(NodeCrypto.layer),
  );

const testLayer = provisionerLayer();

const memoryRepository = (initial: ReadonlyArray<SandboxRecord> = []) => {
  const records = new Map(initial.map((record) => [record.environmentId, record]));
  const layer = Layer.succeed(
    SandboxRecords.SandboxRecordRepository,
    SandboxRecords.SandboxRecordRepository.of({
      list: Effect.sync(() => [...records.values()]),
      get: (environmentId) => Effect.sync(() => Option.fromUndefinedOr(records.get(environmentId))),
      put: (record) =>
        Effect.sync(() => {
          records.set(record.environmentId, record);
        }),
      remove: (environmentId) =>
        Effect.sync(() => {
          records.delete(environmentId);
        }),
    }),
  );
  return { layer, records };
};

// Shaped like a live `GET /limits` response, with invented numbers and no account ids.
const boatLimitsFixture = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  type: "limits.info",
  accessTier: "standard",
  blockedReason: null,
  currentLimits: { activeSandboxes: 300, creationRatePerMinute: 30 },
  wallet: { balanceDollars: 12.5 },
  planIncluded: { vmHours: 2000, vmHoursRemaining: 1500, periodEnd: "2026-11-30T00:00:00.000Z" },
  sandboxPlanKey: "box_100",
  sandboxPlanDollars: 100,
  billingStatus: "active",
  checkoutRequired: false,
  canStart: true,
  startBlockedReason: null,
  starts: {
    unlimited: false,
    minute: { limit: 30, used: 1, remaining: 29 },
    hour: { limit: 210, used: 8, remaining: 202 },
    day: null,
  },
  nextStartDollars: 0,
  startWindowFull: null,
  activeSandboxes: 1,
  maxActiveSandboxes: 300,
  machineTypes: [
    { type: "default", available: true, reason: null },
    { type: "xlarge", available: false, reason: "Needs the $500 plan." },
  ],
  keepGoing: { available: true, enabled: false, capDollars: 400 },
  ...overrides,
});

const trialLimits = boatLimitsFixture({
  accessTier: "trial",
  sandboxPlanKey: "trial",
  sandboxPlanDollars: null,
});

const boatResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(
    request,
    Response.json({
      ok: true,
      type: "sandbox.created",
      sandbox: { id: boatSandboxId, name: "Boat sandbox" },
      hostedPorts: [{ port: 3773, url: "https://boat.example/t3" }],
    }),
  );

const recording = (
  requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body: unknown;
    readonly authorization?: string | undefined;
  }>,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  HttpClient.make((request) => {
    const query = UrlParams.toString(request.urlParams);
    requests.push({
      method: request.method,
      url: query === "" ? request.url : `${request.url}?${query}`,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined,
      authorization: request.headers.authorization,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
  });

const vercelConfig = { apiKey: "vcp_test", settings: {} };
const vercelTeam = (plan: string) => ({ id: "team_1", slug: "acme", billing: { plan } });
// Shaped like live `GET /v2/sandboxes/{name}` responses, with invented ids.
const vercelSandbox = (
  sandbox: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
) => ({
  sandbox: {
    name: "box-attempt1",
    status: "running",
    currentSessionId: "sbx_current",
    currentSnapshotId: "snap_source",
    createdAt: 1793318400000,
    vcpus: 2,
    expiresAt: 20 * 60_000,
    ...sandbox,
  },
  session: { id: "sbx_current", status: "running", timeout: 20 * 60_000, ...session },
  routes: [
    { port: 3773, url: "https://sb-t3.vercel.run", subdomain: "sb-t3" },
    { port: 26661, url: "https://sb-system.vercel.run", subdomain: "sb-system", system: true },
  ],
});
const ndjson = (lines: ReadonlyArray<unknown>) =>
  new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
const vercelCommand = (exitCode: number | null) => ({
  command: { id: "cmd_1", name: "sh", sessionId: "sbx_current", exitCode },
});

describe("boatDriver", () => {
  it.effect("creates a sandbox with a public T3 port and reads its URL", () =>
    Effect.gen(function* () {
      const requests: Array<{
        method: string;
        url: string;
        authorization: string | undefined;
        idempotencyKey: string | undefined;
        body: string;
      }> = [];
      const client = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          idempotencyKey: request.headers["idempotency-key"],
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return Effect.succeed(boatResponse(request));
      });

      const created = yield* boatDriver
        .create({
          config: { apiKey: "boat_test", settings: {} },
          name: "Boat sandbox",
          size: "default",
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({
        id: boatSandboxId,
        name: "Boat sandbox",
        publicUrl: "https://boat.example/t3",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "https://boat.dev/api/v1/sandboxes",
        authorization: "Bearer boat_test",
        // Every Boat start bills, so a retried create must replay instead of starting a second one.
        idempotencyKey: "attempt-1",
      });
      // The environment is reachable only if the T3 port is published, and the provider's own TTL
      // must cover T3's default lifetime instead of stopping a paired environment after an hour.
      expect(JSON.parse(requests[0]!.body)).toMatchObject({
        hostedPorts: [{ port: 3773, public: true }],
        ttlSeconds: 480 * 60,
        // The sweep reads every T3 sandbox's cost in one list call filtered by this label.
        labels: { "t3.code/role": "environment" },
      });
    }),
  );

  it.effect("maps Boat's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        ...["ready", "idle", "running"].map((state) => ({ state, expected: "running" })),
        ...["init", "provisioning", "provisioned", "cloning", "archiving"].map((state) => ({
          state,
          expected: "starting",
        })),
        { state: "archived", expected: "stopped" },
        // Boat drops the disk 14 days after a stop; resume then fails.
        { state: "archived", dataExpiredAt: "2026-10-01T00:00:00.000Z", expected: "expired" },
        { state: "error", error: "echo boat_live_secret", expected: "error" },
        { state: "cancelled", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "hibernating", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ ok: false, code: "not_found" }, { status: testCase.status })
                : Response.json({ sandbox: { id: boatSandboxId, ...testCase } }),
            ),
          ),
        );
        const status = yield* boatDriver.status!({
          config: { apiKey: "boat_test", settings: {} },
          sandboxId: boatSandboxId,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect(
    "turns a failed command into a bounded error that keeps output only in the cause",
    () => {
      const bodies: Array<string> = [];
      const client = HttpClient.make((request) => {
        bodies.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ exitCode: 2, stdout: "", stderr: "t3 CLI did not install" }),
          ),
        );
      });

      return Effect.gen(function* () {
        const error = yield* boatDriver
          .execute({
            config: { apiKey: "boat_test", settings: {} },
            sandboxId: boatSandboxId,
            command: "echo 'ok'; exit 0",
            timeoutSeconds: 60,
          })
          .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        // The script runs in a child shell so its own exit status is what Boat reports.
        expect(JSON.parse(bodies[0]!)).toMatchObject({
          command: `sh -c 'echo '\\''ok'\\''; exit 0'`,
        });

        expect(error).toBeInstanceOf(SandboxProviderError);
        expect(error.stage).toBe("install");
        // Raw output can carry credentials, so it never becomes an attribute or part of the message.
        expect(error.detail).toBe("The command exited with 2.");
        expect(error.message).not.toContain("t3 CLI did not install");
        expect(String(error.cause)).toContain("t3 CLI did not install");
      });
    },
  );
});

describe("daytonaDriver", () => {
  it.effect("starts a sandbox, runs through the toolbox proxy, and reads a preview URL", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string; body: string }> = [];
      const client = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        if (request.url.endsWith("/sandbox")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "creating" }),
            ),
          );
        }
        if (request.url.endsWith("/sandbox/sandbox_1/toolbox-proxy-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://toolbox.example/toolbox" }),
            ),
          );
        }
        if (request.url.endsWith("/process/execute")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ exitCode: 0, result: "Token: pair_xyz" }),
            ),
          );
        }
        if (request.url.endsWith("/ports/3773/preview-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://3773-sandbox_1.proxy.daytona.works" }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "started" }),
          ),
        );
      });

      const created = yield* daytonaDriver
        .create({
          config: { apiKey: "dtn_test", settings: {} },
          name: "Daytona sandbox",
          size: "daytona-medium",
          ttlMinutes: 480,
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const executed = yield* daytonaDriver
        .execute({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: created.id,
          command: "t3 pair",
          timeoutSeconds: 30,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const preview = yield* daytonaDriver
        .exposePort({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: created.id,
          port: 3773,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({ id: "sandbox_1", name: "Daytona sandbox" });
      expect(executed.stdout).toContain("Token: pair_xyz");
      expect(preview).toBe("https://3773-sandbox_1.proxy.daytona.works");
      yield* daytonaDriver.extend!({
        config: { apiKey: "dtn_test", settings: {} },
        sandboxId: created.id,
        ttlMinutes: 180,
        running: false,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      // Daytona deletes at its TTL, so the backstop sits a day past T3's non-destructive stop.
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ ttlMinutes: 480 + 1440 });
      // `/ttl/{minutes}` counts from the call, even on a stopped sandbox, so it gets the same day.
      expect(requests.at(-1)).toMatchObject({
        method: "POST",
        url: "https://app.daytona.io/api/sandbox/sandbox_1/ttl/1620",
      });
      expect(requests.map((request) => request.url)).toContain(
        "https://toolbox.example/toolbox/sandbox_1/process/execute",
      );
    }),
  );

  it.effect("maps Daytona's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { state: "started", expected: "running" },
        ...["creating", "restoring", "starting", "pulling_snapshot", "resuming"].map((state) => ({
          state,
          expected: "starting",
        })),
        ...["stopped", "stopping", "archived", "archiving", "paused", "pausing"].map((state) => ({
          state,
          expected: "stopped",
        })),
        { state: "error", expected: "error" },
        { state: "build_failed", expected: "error" },
        { state: "destroyed", expected: "deleted" },
        { state: "destroying", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "snapshotting", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ message: "Sandbox not found" }, { status: testCase.status })
                : Response.json({ id: "sandbox_1", state: testCase.state }),
            ),
          ),
        );
        const status = yield* daytonaDriver.status!({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: "sandbox_1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );
});

describe("vercelDriver", () => {
  it.effect("creates a sandbox in the T3 project, making the project once", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam("pro")] });
      if (url.pathname === "/v9/projects/t3-sandboxes") {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (url.pathname === "/v11/projects") return Response.json({ id: "prj_1" });
      return Response.json(vercelSandbox());
    });
    return Effect.gen(function* () {
      const created = yield* vercelDriver.create({
        config: vercelConfig,
        name: "My Box!",
        size: "vercel-4",
        ttlMinutes: 480,
        idempotencyKey: "0f1e2d3c-aaaa-bbbb",
      });

      // The sandbox name is the record's id, since sessions change on every resume, and the
      // detected team is reported so the record keeps it.
      expect(created).toEqual({
        id: "box-attempt1",
        name: "My Box!",
        publicUrl: "https://sb-t3.vercel.run",
        settings: { teamId: "team_1", projectId: "t3-sandboxes" },
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET https://api.vercel.com/v2/teams?limit=20",
        "GET https://api.vercel.com/v9/projects/t3-sandboxes?teamId=team_1",
        "POST https://api.vercel.com/v11/projects?teamId=team_1",
        "POST https://api.vercel.com/v4/sandboxes?teamId=team_1",
      ]);
      expect(requests[2]?.body).toEqual({ name: "t3-sandboxes" });
      expect(requests[3]?.body).toEqual({
        // Names are URL-safe and unique per project.
        name: "my-box-0f1e2d3c",
        projectId: "t3-sandboxes",
        ports: [3773],
        timeout: 480 * 60_000,
        resources: { vcpus: 4 },
        persistent: true,
        tags: { "t3.code/role": "environment" },
        snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
        keepLastSnapshots: { count: 1 },
      });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("keeps a Hobby session inside the plan and refuses a size it cannot run", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) =>
      new URL(request.url).pathname === "/v2/teams"
        ? Response.json({ teams: [vercelTeam("hobby")] })
        : Response.json(vercelSandbox()),
    );
    return Effect.gen(function* () {
      yield* vercelDriver.create({
        config: vercelConfig,
        name: "Box",
        size: "vercel-2",
        ttlMinutes: 480,
        idempotencyKey: "attempt1",
      });
      expect(requests.at(-1)?.body).toMatchObject({ timeout: 45 * 60_000 });

      requests.length = 0;
      const refused = yield* vercelDriver
        .create({ config: vercelConfig, name: "Box", size: "vercel-8", idempotencyKey: "attempt2" })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "size_unavailable", stage: "config" });
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("finds the team from the token or the Team setting", () =>
    Effect.gen(function* () {
      const teamsOf = (respond: (pathname: string) => Response) => {
        const requests: Array<{ method: string; url: string; body: unknown }> = [];
        const client = recording(requests, (request) => respond(new URL(request.url).pathname));
        return { requests, client };
      };
      const status = (
        settings: Record<string, string>,
        respond: (pathname: string) => Response,
      ) => {
        const { requests, client } = teamsOf(respond);
        return vercelDriver.status!({
          config: { apiKey: "vcp_test", settings },
          sandboxId: "box-attempt1",
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((result) => ({ result, urls: requests.map((request) => request.url) })),
        );
      };
      const sandbox = Response.json(vercelSandbox());

      // A personal account has no team, so no `teamId` is sent.
      const personal = yield* status({}, (path) =>
        path === "/v2/teams" ? Response.json({ teams: [] }) : sandbox.clone(),
      );
      expect(personal.urls.at(-1)).toBe(
        "https://api.vercel.com/v2/sandboxes/box-attempt1?projectId=t3-sandboxes",
      );

      const several = yield* status({}, () =>
        Response.json({
          teams: ["a", "b", "c", "d", "e", "f"].map((slug) => ({ id: `team_${slug}`, slug })),
        }),
      ).pipe(Effect.flip);
      expect(several).toMatchObject({ stage: "config" });
      expect(several.detail).toBe(
        "This Vercel token can see 6 teams. Enter one under Team: a, b, c, d, e, ….",
      );

      // A slug in the setting resolves to the team's id, and the project setting replaces the default.
      const chosen = yield* status({ teamId: "acme", projectId: "mine" }, (path) =>
        path === "/v2/teams/acme" ? Response.json(vercelTeam("pro")) : sandbox.clone(),
      );
      expect(chosen.urls).toEqual([
        "https://api.vercel.com/v2/teams/acme",
        "https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=mine",
      ]);

      // Vercel answers 403 for a team the token cannot see, which is not a rejected token.
      const hidden = yield* status({ teamId: "other" }, (path) =>
        path === "/v2/teams"
          ? Response.json({ teams: [vercelTeam("pro")] })
          : Response.json({ error: { code: "forbidden" } }, { status: 403 }),
      ).pipe(Effect.flip);
      expect(hidden).toMatchObject({ stage: "config" });
      expect(hidden.code).toBeUndefined();
      expect(hidden.detail).toContain("cannot see a team named other");

      const badToken = yield* status({ teamId: "acme" }, () =>
        Response.json({ error: { code: "forbidden", invalidToken: true } }, { status: 403 }),
      ).pipe(Effect.flip);
      expect(badToken).toMatchObject({ code: "api_key_rejected" });
    }),
  );

  it.effect(
    "runs a command in the current session and keeps a failure's output only in the cause",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      let exitCode = 0;
      const client = recording(requests, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v2/teams") return Response.json({ teams: [] });
        if (url.pathname.endsWith("/cmd")) {
          return ndjson([
            vercelCommand(null),
            { data: "Token: pair_vercel\n", stream: "stdout" },
            { data: "vcp_live_secret\n", stream: "stderr" },
            vercelCommand(exitCode),
          ]);
        }
        return Response.json(vercelSandbox({ currentSessionId: "sbx_resumed" }));
      });
      return Effect.gen(function* () {
        const run = vercelDriver.execute({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          command: "t3 pair",
          timeoutSeconds: 60,
        });
        const ok = yield* run;
        expect(ok).toEqual({
          exitCode: 0,
          stdout: "Token: pair_vercel\n",
          stderr: "vcp_live_secret\n",
        });
        expect(requests.at(-1)).toMatchObject({
          method: "POST",
          url: "https://api.vercel.com/v2/sandboxes/sessions/sbx_resumed/cmd",
          body: { command: "sh", args: ["-c", "t3 pair"], wait: true, logs: true, timeout: 60_000 },
        });

        exitCode = 3;
        const error = yield* run.pipe(Effect.flip);
        expect(error).toMatchObject({ stage: "install", detail: "The command exited with 3." });
        expect(error.message).not.toContain("vcp_live_secret");
        expect(String(error.cause)).toContain("vcp_live_secret");
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    },
  );

  it.effect("maps Vercel's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { status: "running", expected: "running" },
        { status: "stopping", expected: "stopped" },
        { status: "stopped", expected: "stopped" },
        { httpStatus: 404, expected: "deleted" },
        { status: "snapshotting", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = recording([], (request) =>
          new URL(request.url).pathname === "/v2/teams"
            ? Response.json({ teams: [] })
            : "httpStatus" in testCase
              ? Response.json({ error: { code: "not_found" } }, { status: testCase.httpStatus })
              : Response.json(vercelSandbox({ status: testCase.status })),
        );
        const status = yield* vercelDriver.status!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect(
    "stops the current session, resumes into a new one, and extends within the plan",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      let plan = "pro";
      let running = true;
      const client = recording(requests, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam(plan)] });
        if (request.method === "POST" || request.method === "PATCH") return Response.json({});
        return Response.json(
          url.searchParams.get("resume") === "true"
            ? vercelSandbox({ currentSessionId: "sbx_next" }, { id: "sbx_next" })
            : vercelSandbox({ status: running ? "running" : "stopped" }),
        );
      });
      const calls = () => requests.map((request) => `${request.method} ${request.url}`);
      return Effect.gen(function* () {
        yield* vercelDriver.stop!({ config: vercelConfig, sandboxId: "box-attempt1" });
        expect(calls().at(-1)).toBe(
          "POST https://api.vercel.com/v2/sandboxes/sessions/sbx_current/stop?teamId=team_1",
        );
        // Vercel answers 415 to a POST without a JSON body.
        expect(requests.at(-1)?.body).toEqual({});

        requests.length = 0;
        const resumed = yield* vercelDriver.resume!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          ttlMinutes: 120,
        });
        expect(resumed).toEqual({ publicUrl: "https://sb-t3.vercel.run" });
        // The new session takes the sandbox's timeout, so it is set before the resume.
        expect(calls().slice(1)).toEqual([
          "PATCH https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=t3-sandboxes",
          "GET https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=t3-sandboxes&resume=true",
        ]);
        expect(requests[1]?.body).toEqual({ timeout: 120 * 60_000 });

        // The session ends 20 minutes from now (TestClock starts at 0) and should end in 80.
        requests.length = 0;
        yield* vercelDriver.extend!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          ttlMinutes: 80,
          running: true,
        });
        expect(calls().at(-1)).toBe(
          "POST https://api.vercel.com/v2/sandboxes/sessions/sbx_current/extend-timeout?teamId=team_1",
        );
        expect(requests.at(-1)?.body).toEqual({ duration: 60 * 60_000 });

        // Hobby caps the session at 45 minutes; the rest of T3's deadline needs a resume.
        plan = "hobby";
        yield* vercelDriver.extend!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          ttlMinutes: 80,
          running: true,
        });
        expect(requests.at(-1)?.body).toEqual({ duration: 25 * 60_000 });

        // A stopped sandbox gets its time when it resumes, and a stopped one is not stopped again.
        requests.length = 0;
        running = false;
        yield* vercelDriver.extend!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          ttlMinutes: 80,
          running: false,
        });
        yield* vercelDriver.stop!({ config: vercelConfig, sandboxId: "box-attempt1" });
        expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    },
  );
});

describe("sandbox templates", () => {
  it.effect("lists Boat's ready saved snapshots with the allowance and deletes one", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) =>
      request.method === "DELETE"
        ? Response.json({ ok: true })
        : Response.json({
            snapshots: [
              {
                name: "web-stack",
                status: "ready",
                type: "large",
                sizeBytes: 2048,
                createdAt: "2026-10-30T00:00:00.000Z",
              },
              { name: "half-saved", status: "saving", type: "small" },
              { name: "broken", status: "failed", error: "echo boat_live_secret" },
            ],
            allowance: {
              included: 50,
              used: 3,
              extra: 0,
              pricePerExtraDailyDollars: 0.056,
              extraMonthlyDollars: 0,
            },
          }),
    );
    return Effect.gen(function* () {
      const listed = yield* boatDriver.listTemplates!({
        config: { apiKey: "boat_test", settings: {} },
      });
      yield* boatDriver.deleteTemplate!({
        config: { apiKey: "boat_test", settings: {} },
        name: "web-stack",
      });

      // Only a ready snapshot can start a sandbox.
      expect(listed).toEqual({
        templates: [
          {
            name: "web-stack",
            size: "large",
            sizeBytes: 2048,
            createdAt: "2026-10-30T00:00:00.000Z",
          },
        ],
        templateAllowance: { included: 50, used: 3, extra: 0, pricePerExtraDailyDollars: 0.056 },
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET https://boat.dev/api/v1/saved-snapshots",
        "DELETE https://boat.dev/api/v1/saved-snapshots/web-stack",
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("saves, lists, deletes, and starts from Daytona snapshots T3 made", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let snapshotPolls = 0;
    let sandboxPolls = 0;
    const snapshot = {
      id: "snap_1",
      name: "t3-web-stack",
      state: "active",
      cpu: 2,
      mem: 4,
      sourceSandboxId: "sandbox_1",
      createdAt: "2026-10-30T00:00:00.000Z",
    };
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/sandbox/sandbox_1" && request.method === "GET") {
        sandboxPolls += 1;
        return Response.json({ id: "sandbox_1", state: sandboxPolls < 2 ? "stopping" : "stopped" });
      }
      if (url.pathname === "/api/snapshots/t3-web-stack") {
        snapshotPolls += 1;
        return snapshotPolls < 2
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json(snapshotPolls < 3 ? { ...snapshot, state: "snapshotting" } : snapshot);
      }
      if (url.pathname === "/api/snapshots") {
        return Response.json({
          items: [
            snapshot,
            // A base image and a snapshot someone else made: neither is a T3 template.
            { id: "base", name: "daytonaio/sandbox:0.4", state: "active", general: true },
            { id: "other", name: "t3-imported", state: "active", sourceSandboxId: null },
          ],
          total: 3,
          page: 1,
          totalPages: 1,
        });
      }
      if (url.pathname === "/api/sandbox" && request.method === "POST") {
        return Response.json({ id: "sandbox_2", state: "started" });
      }
      return Response.json({ id: "sandbox_1", state: "started" });
    });
    return Effect.gen(function* () {
      const config = { apiKey: "dtn_test", settings: {} };
      const fiber = yield* daytonaDriver.saveTemplate!({
        config,
        sandboxId: "sandbox_1",
        name: "web-stack",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);
      const listed = yield* daytonaDriver.listTemplates!({ config });
      yield* daytonaDriver.deleteTemplate!({ config, name: "web-stack" });
      const createFiber = yield* daytonaDriver
        .create({
          config,
          name: "From template",
          size: "daytona-small",
          idempotencyKey: "attempt-1",
          template: "web-stack",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(createFiber);

      expect(saved).toEqual({
        name: "web-stack",
        createdAt: "2026-10-30T00:00:00.000Z",
        size: "daytona-medium",
      });
      expect(listed.templates.map((template) => template.name)).toEqual(["web-stack"]);
      const calls = requests.map((request) => `${request.method} ${request.url}`);
      // A cold snapshot needs a stopped sandbox, and `/stop` returns while it is still stopping.
      expect(calls.slice(0, 3)).toEqual([
        "GET https://app.daytona.io/api/sandbox/sandbox_1",
        "GET https://app.daytona.io/api/sandbox/sandbox_1",
        "POST https://app.daytona.io/api/sandbox/sandbox_1/snapshot",
      ]);
      expect(requests[2]?.body).toEqual({ name: "t3-web-stack" });
      expect(calls).toContain("GET https://app.daytona.io/api/snapshots?name=t3-&limit=200");
      expect(calls).toContain("DELETE https://app.daytona.io/api/snapshots/snap_1");
      expect(
        requests.find((request) => request.method === "POST" && request.url.endsWith("/sandbox"))
          ?.body,
      ).toMatchObject({ snapshot: "t3-web-stack" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("saves, lists, deletes, and starts from Vercel template sandboxes", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const polls = new Map<string, number>();
    let templateExists = true;
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      const poll = (name: string) => {
        polls.set(name, (polls.get(name) ?? 0) + 1);
        return polls.get(name)!;
      };
      if (url.pathname === "/v2/teams") return Response.json({ teams: [] });
      if (url.pathname === "/v2/sandboxes" && request.method === "GET") {
        return Response.json({
          sandboxes: [
            vercelSandbox({ name: "t3-template-web", status: "stopped", vcpus: 4 }).sandbox,
            // A template mid-save is still running and has no disk yet.
            vercelSandbox({ name: "t3-template-saving", status: "running" }).sandbox,
            vercelSandbox({ name: "someone-elses", status: "stopped" }).sandbox,
          ],
        });
      }
      if (url.pathname === "/v2/sandboxes/box-attempt1" && request.method === "GET") {
        return Response.json(
          vercelSandbox({ status: poll("source") < 2 ? "stopping" : "stopped" }),
        );
      }
      if (url.pathname === "/v2/sandboxes/t3-template-web" && request.method === "GET") {
        if (templateExists) {
          templateExists = false;
          return Response.json(vercelSandbox({ name: "t3-template-web", status: "stopped" }));
        }
        return Response.json(
          vercelSandbox({
            name: "t3-template-web",
            status: poll("template") < 2 ? "stopping" : "stopped",
            currentSnapshotId: "snap_template",
            vcpus: 4,
          }),
        );
      }
      if (url.pathname.endsWith("/fork")) {
        return Response.json(
          vercelSandbox(
            {
              name: url.pathname.includes("t3-template-web/") ? "copy-attempt1" : "t3-template-web",
              currentSessionId: "sbx_fork",
            },
            { id: "sbx_fork" },
          ),
        );
      }
      return Response.json({});
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    return Effect.gen(function* () {
      const fiber = yield* vercelDriver.saveTemplate!({
        config: vercelConfig,
        sandboxId: "box-attempt1",
        name: "web",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);
      expect(saved).toEqual({
        name: "web",
        createdAt: "2026-10-30T00:00:00.000Z",
        size: "vercel-4",
      });
      const base = "https://api.vercel.com/v2/sandboxes";
      expect(calls()).toEqual([
        "GET https://api.vercel.com/v2/teams?limit=20",
        // The provisioner's stop returns while Vercel still snapshots the disk.
        `GET ${base}/box-attempt1?projectId=t3-sandboxes`,
        `GET ${base}/box-attempt1?projectId=t3-sandboxes`,
        // Saving under an existing name replaces that template.
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        `DELETE ${base}/t3-template-web?projectId=t3-sandboxes&deleteOrphanSnapshots=true`,
        `POST ${base}/box-attempt1/fork?projectId=t3-sandboxes`,
        `POST ${base}/sessions/sbx_fork/stop`,
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        // The template has its own snapshot now, so the source's stop snapshot is not kept.
        `DELETE ${base}/snapshots/snap_source`,
      ]);
      expect(requests[5]?.body).toEqual({
        name: "t3-template-web",
        timeout: 5 * 60_000,
        tags: { "t3.code/role": "template" },
        persistent: true,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 1 },
      });

      requests.length = 0;
      const listed = yield* vercelDriver.listTemplates!({ config: vercelConfig });
      expect(listed).toEqual({
        templates: [{ name: "web", createdAt: "2026-10-30T00:00:00.000Z", size: "vercel-4" }],
      });
      expect(calls()[1]).toBe(
        `GET ${base}?project=t3-sandboxes&tags=t3.code%2Frole%3Atemplate&limit=50`,
      );

      requests.length = 0;
      const created = yield* vercelDriver.create({
        config: vercelConfig,
        name: "Copy",
        size: "vercel-2",
        ttlMinutes: 480,
        idempotencyKey: "attempt1",
        template: "web",
      });
      expect(created).toMatchObject({ id: "copy-attempt1", publicUrl: "https://sb-t3.vercel.run" });
      expect(calls().at(-1)).toBe(`POST ${base}/t3-template-web/fork?projectId=t3-sandboxes`);
      // A fork copies the template's tags, ports, timeout, and never-expiring disk unless overridden.
      expect(requests.at(-1)?.body).toEqual({
        name: "copy-attempt1",
        ports: [3773],
        timeout: 45 * 60_000,
        tags: { "t3.code/role": "environment" },
        persistent: true,
        snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
        keepLastSnapshots: { count: 1 },
      });

      requests.length = 0;
      yield* vercelDriver.deleteTemplate!({ config: vercelConfig, name: "web" });
      expect(calls().at(-1)).toBe(
        `DELETE ${base}/t3-template-web?projectId=t3-sandboxes&deleteOrphanSnapshots=true`,
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("tells a Daytona key without snapshot permission apart from a bad key", () => {
    const client = recording([], () => Response.json({ message: "Forbidden" }, { status: 403 }));
    return Effect.gen(function* () {
      const error = yield* daytonaDriver.listTemplates!({
        config: { apiKey: "dtn_test", settings: {} },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "api_key_rejected", status: 403, stage: "template" });
      expect(error.detail).toContain("cannot manage snapshots");
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });
});

describe("boat credential environments", () => {
  it.effect("lists only credential flags and never returns environment secrets", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environments: [
              {
                name: "base",
                isDefault: true,
                safeForThirdParties: false,
                passGithub: true,
                passSecrets: true,
                passSandboxCredentials: true,
                passAgentsCredentials: true,
                proxyAiCredentials: false,
                envContents: "OPENAI_API_KEY=sk-live-secret",
                secretFiles: [{ path: ".env", contents: "TOKEN=secret" }],
              },
            ],
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const environments = yield* boatDriver.listEnvironments!({
        config: { apiKey: "boat_test", settings: {} },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(environments).toEqual([
        {
          name: "base",
          isDefault: true,
          safeForThirdParties: false,
          passGithub: true,
          passSecrets: true,
          passSandboxCredentials: true,
          passAgentsCredentials: true,
          proxyAiCredentials: false,
        },
      ]);
      expect(JSON.stringify(environments)).not.toContain("sk-live-secret");
      expect(JSON.stringify(environments)).not.toContain("TOKEN=secret");
    });
  });

  it.effect("refuses a credential environment until the caller confirms it", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({
            provider: "boat",
            apiKey: "boat_test",
            environment: "base",
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("config");
      expect(requests).toEqual([]);
    });
  });
});

describe("provider limits", () => {
  const respondWith = (body: unknown, status = 200) =>
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
    );

  it.effect("normalizes Boat's limits and ignores the fields T3 does not use", () =>
    Effect.gen(function* () {
      const readLimits = (body: unknown) =>
        boatDriver.limits!({ config: { apiKey: "boat_test", settings: {} } }).pipe(
          Effect.provideService(HttpClient.HttpClient, respondWith(body)),
        );

      expect(yield* readLimits(boatLimitsFixture())).toEqual({
        canStart: true,
        // A null window is one the plan does not limit.
        starts: [
          { window: "minute", limit: 30, used: 1, remaining: 29 },
          { window: "hour", limit: 210, used: 8, remaining: 202 },
        ],
        concurrency: { active: 1, max: 300 },
        startCost: "included",
        maxTtlMinutes: 43200,
        canSaveTemplates: true,
        sizes: [
          { id: "default", available: true },
          { id: "xlarge", available: false, reason: "Needs the $500 plan." },
        ],
        plan: "$100 plan",
      });
      expect(
        yield* readLimits(
          boatLimitsFixture({
            accessTier: "trial",
            sandboxPlanKey: "trial",
            sandboxPlanDollars: null,
            nextStartDollars: 0.03,
            starts: { hour: { limit: 25, used: 25, remaining: 0 } },
            startWindowFull: { window: "hour", limit: 25, freesAt: "2026-10-31T15:00:00.000Z" },
          }),
        ),
      ).toMatchObject({
        starts: [
          {
            window: "hour",
            limit: 25,
            used: 25,
            remaining: 0,
            resetsAt: "2026-10-31T15:00:00.000Z",
          },
        ],
        startCost: "paid",
        startDollars: 0.03,
        maxTtlMinutes: 120,
        // Boat refuses saved snapshots on a trial, but only after T3 would have been reset.
        canSaveTemplates: false,
        plan: "Trial",
      });
      expect(yield* readLimits(boatLimitsFixture({ nextStartDollars: null }))).toMatchObject({
        startCost: "refused",
      });
    }),
  );

  it.effect("reports Daytona limits as unknown when the key cannot read the organization", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/api-keys/current")
            ? Response.json({ organizationId: "org_1", permissions: ["write:sandboxes"] })
            : Response.json({ message: "Forbidden" }, { status: 403 }),
        ),
      );
    });
    return Effect.gen(function* () {
      const limits = yield* daytonaDriver.limits!({
        config: { apiKey: "dtn_test", settings: {} },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits).toBeNull();
      expect(requests).toEqual([
        "GET https://app.daytona.io/api/api-keys/current",
        "GET https://app.daytona.io/api/organizations/org_1/usage",
      ]);
    });
  });

  it.effect("maps provider refusals to stable codes without echoing the body", () =>
    Effect.gen(function* () {
      const cases = [
        {
          provider: "boat",
          status: 429,
          body: {
            ok: false,
            code: "rate_limited",
            message: "echo boat_live_secret",
            error: { code: "rate_limited", details: { window: "hour", retryAfterSeconds: 720 } },
          },
          code: "rate_limited",
          retryAfterSeconds: 720,
          detail: "Boat's start limit for this hour is used up. Try again in 12 min.",
        },
        {
          provider: "boat",
          status: 429,
          body: { error: { code: "IP_RATE_LIMIT_EXCEEDED" } },
          headers: { "Retry-After": "30" },
          code: "rate_limited",
          retryAfterSeconds: 30,
          detail: "Boat is limiting requests right now. Try again in 30 s.",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "limit_reached" },
          code: "concurrency_full",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "member_limit_reached" },
          code: "concurrency_full",
        },
        {
          provider: "boat",
          status: 402,
          body: { error: { code: "billing_required" } },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 402,
          body: { code: "credit_required" },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "trial_compute_limit_reached" },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 402,
          body: { code: "team_member_cap_reached" },
          code: "billing_required",
        },
        // A plan refusal is a 403 but not a bad key.
        {
          provider: "boat",
          status: 403,
          body: { code: "machine_class_plan_required" },
          code: "size_unavailable",
        },
        {
          provider: "boat",
          status: 403,
          body: { code: "trial_machine_class_not_allowed" },
          code: "size_unavailable",
        },
        { provider: "boat", status: 400, body: { code: "invalid_type" }, code: "size_unavailable" },
        {
          provider: "boat",
          status: 409,
          body: { code: "snapshot_data_expired" },
          code: "snapshot_expired",
        },
        {
          provider: "boat",
          status: 503,
          body: { code: "no_ready_machine" },
          code: "capacity_unavailable",
        },
        {
          provider: "boat",
          status: 503,
          body: { code: "out_of_capacity", retryAfterSeconds: 120 },
          code: "capacity_unavailable",
          retryAfterSeconds: 120,
        },
        {
          provider: "boat",
          status: 403,
          body: { code: "trial_saved_snapshots_not_allowed" },
          code: "templates_unavailable",
          detail: "Your Boat plan cannot save templates.",
        },
        {
          provider: "boat",
          status: 409,
          body: { code: "save_in_progress" },
          code: "template_saving",
        },
        { provider: "boat", status: 404, body: { code: "snapshot_not_found" }, code: "not_found" },
        { provider: "boat", status: 401, body: { code: "unauthorized" }, code: "api_key_rejected" },
        { provider: "boat", status: 404, body: {}, code: "not_found" },
        {
          provider: "vercel",
          status: 403,
          body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } },
          code: "api_key_rejected",
        },
        {
          provider: "vercel",
          status: 429,
          body: { error: { code: "rate_limited", message: "echo boat_live_secret" } },
          headers: { "Retry-After": "30" },
          code: "rate_limited",
          retryAfterSeconds: 30,
          detail: "Vercel is limiting requests right now. Try again in 30 s.",
        },
        // HTTP 402 is a payment refusal whatever the provider calls it.
        {
          provider: "vercel",
          status: 402,
          body: { error: { code: "payment_required" } },
          code: "billing_required",
        },
        {
          provider: "vercel",
          status: 404,
          body: {
            error: { code: "not_found", message: "Sandbox 'x' not found for this project." },
          },
          code: "not_found",
        },
        {
          provider: "daytona",
          status: 429,
          body: { message: "Too many requests" },
          headers: { "Retry-After-Sandbox-Create": "45" },
          code: "rate_limited",
          retryAfterSeconds: 45,
        },
        {
          provider: "daytona",
          status: 500,
          body: "not json",
          code: "unknown",
          detail: "The provider responded with HTTP 500.",
        },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                typeof testCase.body === "string" ? testCase.body : JSON.stringify(testCase.body),
                { status: testCase.status, headers: "headers" in testCase ? testCase.headers : {} },
              ),
            ),
          ),
        );
        const error = yield* requestJson({
          provider: testCase.provider,
          stage: "create",
          schema: Schema.Struct({}),
          request: HttpClientRequest.post("https://provider.example/sandboxes"),
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        expect(error, testCase.code).toMatchObject({
          status: testCase.status,
          code: testCase.code,
          ...("detail" in testCase ? { detail: testCase.detail } : {}),
        });
        expect(error.retryAfterSeconds).toBe(
          "retryAfterSeconds" in testCase ? testCase.retryAfterSeconds : undefined,
        );
        expect(error.message).not.toContain("boat_live_secret");
      }
    }),
  );
});

describe("SandboxProvisioner lifecycle", () => {
  const lifecycleClient = (
    requests: Array<string>,
    options: {
      readonly commands?: Array<string>;
      readonly commandExitCode?: number;
      /** `GET /limits` answers with this body; without it the provider fails to report limits. */
      readonly limits?: unknown;
      readonly bodies?: Array<{ readonly url: string; readonly body: unknown }>;
    } = {},
  ) =>
    HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.body._tag === "Uint8Array") {
        options.bodies?.push({
          url: request.url,
          body: JSON.parse(new TextDecoder().decode(request.body.body)),
        });
      }
      if (request.url.endsWith("/limits")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            options.limits === undefined
              ? Response.json({ ok: false, code: "internal_error" }, { status: 500 })
              : Response.json(options.limits),
          ),
        );
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        options.commands?.push(
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body)).command
            : "",
        );
        if (options.commandExitCode !== undefined && options.commandExitCode !== 0) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ exitCode: options.commandExitCode, stdout: "", stderr: "boom" }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              requests.filter((entry) => entry.endsWith("/commands")).length === 1
                ? { exitCode: 0, stdout: "", stderr: "" }
                : { exitCode: 0, stdout: "Token: pair_lifecycle\n", stderr: "" },
            ),
          ),
        );
      }
      if (request.url.endsWith("/stop") || request.url.endsWith("/resume")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
      }
      if (request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ sandbox: { id: boatSandboxId, state: "ready", error: null } }),
          ),
        );
      }
      return Effect.succeed(boatResponse(request));
    });

  it.effect("stores a record, stops it, and resumes it", () => {
    const requests: Array<string> = [];
    const commands: Array<string> = [];
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const result = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_test",
              label: "Lifecycle sandbox",
            });
            const listed = yield* provisioner.list;
            const stopped = yield* provisioner.stop({
              environmentId: created.environmentId,
            });
            const resumed = yield* provisioner.resume({
              environmentId: created.environmentId,
            });
            return { created, listed, stopped, resumed };
          }),
        ),
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests, { commands })),
      );

      expect(result.created.environmentId).toBe(testEnvironmentId);
      expect(result.listed.sandboxes).toHaveLength(1);
      expect(result.listed.sandboxes[0]?.state).toBe("running");
      expect(result.listed.sandboxes[0]?.ttlMinutes).toBe(480);
      expect(result.listed.sandboxes[0]?.hardDeadlineAt).not.toBeNull();
      const deadline = result.listed.sandboxes[0]?.hardDeadlineAt;
      expect(result.stopped.sandbox.state).toBe("stopped");
      // The deadline is the sandbox's lifetime, so neither stop nor resume extends it.
      expect(result.stopped.sandbox.hardDeadlineAt).toBe(deadline);
      expect(result.resumed.sandbox.state).toBe("running");
      expect(result.resumed.sandbox.hardDeadlineAt).toBe(deadline);
      expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
      expect(requests.some((request) => request.endsWith("/resume"))).toBe(true);
      // Providers without systemd come back without `t3 serve`, so resume restarts it and only
      // then reports the sandbox as running.
      expect(requests.findLastIndex((request) => request.endsWith("/commands"))).toBeGreaterThan(
        requests.findIndex((request) => request.endsWith("/resume")),
      );
      expect(commands.at(-1)).toContain("nohup t3 serve --host 0.0.0.0 --port 3773");
    });
  });

  it.effect("marks a resumed sandbox as errored when T3 does not start on it", () => {
    const stopped: SandboxRecord = {
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Stopped sandbox",
      size: "small",
      state: "stopped",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "2100-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    };
    const repository = memoryRepository([stopped]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.resume({ environmentId: testEnvironmentId }).pipe(Effect.flip),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { commandExitCode: 1 }),
        ),
      );

      expect(failure.stage).toBe("start");
      expect(failure.detail).toBe("The sandbox resumed, but T3 Code did not start on it.");
      expect(failure.message).not.toContain("boom");
      // The machine is running and billing, so the record must not claim it is still stopped.
      expect(repository.records.get(testEnvironmentId)?.state).toBe("error");
      expect(requests.some((request) => request.endsWith("/resume"))).toBe(true);
    });
  });

  it.effect("refuses to resume a sandbox past its hard deadline", () => {
    const expired: SandboxRecord = {
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Expired sandbox",
      size: "small",
      state: "stopped",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "1960-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    };
    // Within its lifetime, but the provider no longer keeps the stopped sandbox's disk.
    const diskExpired: SandboxRecord = {
      ...expired,
      environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
      state: "expired",
      hardDeadlineAt: "2100-01-01T00:00:00.000Z",
    };
    const repository = memoryRepository([expired, diskExpired]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const [failure, expiredFailure] = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.all([
            provisioner.resume({ environmentId: testEnvironmentId }).pipe(Effect.flip),
            provisioner.resume({ environmentId: diskExpired.environmentId }).pipe(Effect.flip),
          ]),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(failure.detail).toContain("8-hour limit");
      expect(expiredFailure).toMatchObject({
        stage: "start",
        code: "snapshot_expired",
        detail: "Boat no longer keeps this stopped sandbox's disk. Delete it and create a new one.",
      });
      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");
      expect(repository.records.get(diskExpired.environmentId)?.state).toBe("expired");
      // Neither spends a start nor reads the provider's limits.
      expect(requests).toEqual([]);
    });
  });

  it.effect("refuses a start the provider would refuse before creating a machine", () =>
    Effect.gen(function* () {
      const cases = [
        {
          limits: boatLimitsFixture({
            canStart: false,
            startBlockedReason: "Add a card to keep starting sandboxes.",
          }),
          code: "billing_required",
          detail: "Add a card to keep starting sandboxes.",
        },
        {
          limits: boatLimitsFixture({
            nextStartDollars: null,
            starts: { hour: { limit: 60, used: 60, remaining: 0 } },
            startWindowFull: { window: "hour", limit: 60, freesAt: "1970-01-01T00:12:00.000Z" },
          }),
          code: "rate_limited",
          detail: "Boat's start limit for this hour is used up. Try again in 12 min.",
        },
        {
          limits: boatLimitsFixture({ activeSandboxes: 300 }),
          code: "concurrency_full",
          detail: "All 300 of your Boat sandbox slots are in use. Stop or delete one first.",
        },
        {
          limits: boatLimitsFixture(),
          size: "xlarge",
          code: "size_unavailable",
          detail: "Needs the $500 plan.",
        },
      ] as const;
      for (const testCase of cases) {
        const requests: Array<string> = [];
        const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
          Effect.flatMap((provisioner) =>
            provisioner.create({
              provider: "boat",
              apiKey: "boat_test",
              ...("size" in testCase ? { size: testCase.size } : {}),
            }),
          ),
          Effect.provide(testLayer),
          Effect.provideService(
            HttpClient.HttpClient,
            lifecycleClient(requests, { limits: testCase.limits }),
          ),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          stage: "config",
          code: testCase.code,
          detail: testCase.detail,
        });
        expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      }
    }),
  );

  it.effect("caps a trial sandbox at the plan's two-hour auto-stop and records it", () => {
    const requests: Array<string> = [];
    const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
    const repository = memoryRepository();
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test", label: "Trial sandbox" }),
        ),
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { limits: trialLimits, bodies }),
        ),
      );

      // Boat rejects a trial create above two hours with `400 trial_auto_stop_required`.
      expect(
        bodies.find((entry) => entry.url === "https://boat.dev/api/v1/sandboxes")?.body,
      ).toMatchObject({ ttlSeconds: 7200 });
      const record = repository.records.get(testEnvironmentId);
      expect(record?.ttlMinutes).toBe(120);
      expect(record?.hardDeadlineAt).toBe("1970-01-01T02:00:00.000Z");
    });
  });

  it.effect("checks the provider's limits before resuming, since a resume is a start", () => {
    const stopped: SandboxRecord = {
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Stopped sandbox",
      size: "default",
      state: "stopped",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "2100-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    };
    const repository = memoryRepository([stopped]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.resume({ environmentId: testEnvironmentId }).pipe(Effect.flip),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { limits: boatLimitsFixture({ nextStartDollars: null }) }),
        ),
      );

      expect(failure).toMatchObject({ stage: "config", code: "billing_required" });
      expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");
    });
  });

  it.effect("stops a running sandbox when its hard deadline passes", () => {
    const expired: SandboxRecord = {
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Expired sandbox",
      size: "small",
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "1960-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    };
    // A resume that could not start T3 leaves the machine running under an `error` record.
    const errored: SandboxRecord = {
      ...expired,
      environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
      state: "error",
    };
    const repository = memoryRepository([expired, errored]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) => provisioner.sweep),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");
      expect(repository.records.get(errored.environmentId)?.state).toBe("stopped");
      expect(requests.filter((request) => request.endsWith("/stop"))).toHaveLength(2);
      // One provider call per record per sweep: the deadline stop replaces the status check.
      expect(requests).not.toContain(`GET https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
    });
  });

  it.effect("extends a deadline up to the lifetime cap and moves the provider's backstop", () =>
    Effect.gen(function* () {
      const base: SandboxRecord = {
        environmentId: testEnvironmentId,
        provider: "boat",
        sandboxId: boatSandboxId,
        label: "Extended sandbox",
        size: "small",
        state: "running",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "https://boat.example/t3",
        hardDeadlineAt: "1970-01-01T08:00:00.000Z",
        ttlMinutes: 480,
      };
      const atLifetime = (ttlMinutes: number) => ({
        ttlMinutes,
        hardDeadlineAt: DateTime.formatIso(DateTime.makeUnsafe(ttlMinutes * 60_000)),
      });
      const cases = [
        {
          name: "adds to a running sandbox and re-arms Boat's auto-stop from now",
          record: base,
          minutes: 120,
          expected: { ttlMinutes: 600, hardDeadlineAt: "1970-01-01T10:00:00.000Z" },
          patchTtlSeconds: 600 * 60,
        },
        {
          name: "keeps a trial's auto-stop within the plan maximum",
          record: base,
          minutes: 120,
          limits: trialLimits,
          expected: { ttlMinutes: 600, hardDeadlineAt: "1970-01-01T10:00:00.000Z" },
          patchTtlSeconds: 120 * 60,
        },
        {
          // A stopped Boat sandbox gets the remaining time when it resumes.
          name: "grants only what is left under the cap, without a Boat call when stopped",
          record: { ...base, state: "stopped", ...atLifetime(1380) },
          minutes: 240,
          expected: { ttlMinutes: 1440, hardDeadlineAt: "1970-01-02T00:00:00.000Z" },
          patchTtlSeconds: null,
        },
        {
          name: "refuses a sandbox at the cap",
          record: { ...base, ...atLifetime(1440) },
          minutes: 120,
          error: "This sandbox is at the 24-hour lifetime limit set in Settings.",
        },
        {
          name: "follows a lower cap from settings",
          record: base,
          minutes: 120,
          cap: 480,
          error: "This sandbox is at the 8-hour lifetime limit set in Settings.",
        },
        {
          name: "refuses a sandbox past its deadline",
          record: { ...base, state: "stopped", hardDeadlineAt: "1960-01-01T00:00:00.000Z" },
          minutes: 120,
          error: "This sandbox reached its 8-hour limit. Delete it and create a new one.",
        },
        {
          name: "refuses an expired sandbox",
          record: { ...base, state: "expired" },
          minutes: 120,
          error: "Only a running or stopped sandbox can be extended.",
        },
        {
          name: "refuses a deleted sandbox",
          record: { ...base, state: "deleted" },
          minutes: 120,
          error: "Only a running or stopped sandbox can be extended.",
        },
      ] satisfies ReadonlyArray<{
        readonly name: string;
        readonly record: SandboxRecord;
        readonly minutes: number;
        readonly limits?: unknown;
        readonly cap?: number;
        readonly expected?: Pick<SandboxRecord, "ttlMinutes" | "hardDeadlineAt">;
        readonly patchTtlSeconds?: number | null;
        readonly error?: string;
      }>;
      for (const testCase of cases) {
        const repository = memoryRepository([testCase.record]);
        const requests: Array<string> = [];
        const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
        const result = yield* SandboxProvisioner.SandboxProvisioner.pipe(
          Effect.flatMap((provisioner) =>
            provisioner.extend({ environmentId: testEnvironmentId, minutes: testCase.minutes }),
          ),
          Effect.provide(
            provisionerLayer(
              {
                sandboxProviders: { boat: { apiKey: "boat_test" } },
                ...("cap" in testCase ? { sandboxLifetimeCapMinutes: testCase.cap } : {}),
              },
              repository.layer,
            ),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            lifecycleClient(requests, {
              bodies,
              ...("limits" in testCase ? { limits: testCase.limits } : {}),
            }),
          ),
          Effect.result,
        );
        const stored = repository.records.get(testEnvironmentId);
        const patches = requests.filter((request) => request.startsWith("PATCH"));
        if ("error" in testCase) {
          expect(result._tag, testCase.name).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({ detail: testCase.error });
          }
          expect(stored, testCase.name).toEqual(testCase.record);
          expect(patches, testCase.name).toEqual([]);
          continue;
        }
        expect(result._tag, testCase.name).toBe("Success");
        expect(stored, testCase.name).toMatchObject(testCase.expected);
        expect(stored?.createdAt).toBe(testCase.record.createdAt);
        if (testCase.patchTtlSeconds === null) {
          expect(patches, testCase.name).toEqual([]);
        } else {
          expect(patches, testCase.name).toEqual([
            `PATCH https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
          ]);
          // Boat's PATCH sets the deadline to now + ttlSeconds; it does not add to it.
          expect(bodies.find((entry) => entry.url.endsWith(boatSandboxId))?.body).toEqual({
            ttlSeconds: testCase.patchTtlSeconds,
          });
        }
      }
    }),
  );

  it.effect("syncs records with what the provider reports and fills their cost", () => {
    const environmentId = (digit: string) =>
      EnvironmentId.make(
        `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      );
    const base = {
      provider: "boat",
      label: "Synced sandbox",
      size: "small",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "2100-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    } as const;
    const records = {
      stoppedOutside: {
        ...base,
        environmentId: environmentId("1"),
        sandboxId: "bx_stopped",
        state: "running",
      },
      diskExpired: {
        ...base,
        environmentId: environmentId("2"),
        sandboxId: "bx_expired",
        state: "stopped",
      },
      unreachable: {
        ...base,
        environmentId: environmentId("3"),
        sandboxId: "bx_unreach",
        state: "running",
      },
      gone: { ...base, environmentId: environmentId("4"), sandboxId: "bx_gone", state: "stopped" },
      // The machine runs but T3 did not start on it; "running" would hide that.
      notServing: {
        ...base,
        environmentId: environmentId("5"),
        sandboxId: "bx_errored",
        state: "error",
      },
      resumedMeanwhile: {
        ...base,
        environmentId: environmentId("6"),
        sandboxId: "bx_raced",
        state: "running",
      },
    } satisfies Record<string, SandboxRecord>;
    const repository = memoryRepository(Object.values(records));
    const requests: Array<string> = [];
    const respond = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    const client = HttpClient.make((request) => {
      const query = UrlParams.toString(request.urlParams);
      requests.push(`${request.method} ${request.url}${query === "" ? "" : `?${query}`}`);
      const id = request.url.split("/").at(-1);
      if (request.url.endsWith("/sandboxes")) {
        return respond(request, {
          sandboxes: [
            {
              id: "bx_stopped",
              cost: { since: "1970-01-01T00:00:00.000Z", seconds: 60, dollars: 0.42 },
            },
            {
              id: "bx_unreach",
              cost: { since: "1970-01-01T00:00:00.000Z", seconds: 90, dollars: 1.5 },
            },
          ],
        });
      }
      switch (id) {
        case "bx_stopped":
          return respond(request, { sandbox: { id, state: "archived", dataExpiredAt: null } });
        case "bx_expired":
          return respond(request, {
            sandbox: { id, state: "archived", dataExpiredAt: "1970-01-01T00:00:00.000Z" },
          });
        case "bx_unreach":
          return respond(request, { ok: false, code: "internal_error" }, 503);
        case "bx_gone":
          return respond(request, { ok: false, code: "not_found" }, 404);
        case "bx_errored":
          return respond(request, { sandbox: { id, state: "ready" } });
        case "bx_raced":
          // The provider auto-stopped it, and the user resumes it while this read is in flight.
          repository.records.set(records.resumedMeanwhile.environmentId, {
            ...records.resumedMeanwhile,
            state: "running",
            updatedAt: "1970-01-01T00:00:30.000Z",
          });
          return respond(request, { sandbox: { id, state: "archived" } });
      }
      return respond(request, { ok: true });
    });
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.sweep.pipe(
            Effect.andThen(
              provisioner.delete({
                provider: "boat",
                sandboxId: records.gone.sandboxId,
                environmentId: records.gone.environmentId,
              }),
            ),
          ),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const stateOf = (record: SandboxRecord) =>
        repository.records.get(record.environmentId)?.state;
      expect(stateOf(records.stoppedOutside)).toBe("stopped");
      expect(stateOf(records.diskExpired)).toBe("expired");
      // An unreachable provider says nothing about the machine.
      expect(stateOf(records.unreachable)).toBe("running");
      expect(stateOf(records.notServing)).toBe("error");
      expect(repository.records.get(records.resumedMeanwhile.environmentId)).toMatchObject({
        state: "running",
        updatedAt: "1970-01-01T00:00:30.000Z",
      });
      expect(repository.records.get(records.stoppedOutside.environmentId)).toMatchObject({
        costDollars: 0.42,
        costSince: "1970-01-01T00:00:00.000Z",
      });
      // Cost alone is not a lifecycle change.
      expect(repository.records.get(records.unreachable.environmentId)).toMatchObject({
        costDollars: 1.5,
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      // The 404 record was marked deleted, so deleting it only drops the record.
      expect(repository.records.has(records.gone.environmentId)).toBe(false);
      expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
      expect(requests.filter((request) => request.includes("include=cost"))).toEqual([
        "GET https://boat.dev/api/v1/sandboxes?include=cost&label=t3.code%2Frole%3Denvironment&limit=200",
      ]);
      expect(requests.filter((request) => /\/sandboxes\/bx_/.test(request))).toHaveLength(6);
    });
  });
  const runningRecord: SandboxRecord = {
    environmentId: testEnvironmentId,
    provider: "boat",
    sandboxId: boatSandboxId,
    label: "Prepared sandbox",
    size: "large",
    state: "running",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    httpBaseUrl: "https://boat.example/t3",
    hardDeadlineAt: "2100-01-01T00:00:00.000Z",
    ttlMinutes: 480,
  };

  // Boat as the save sees it: archived only after `/stop`, the saved snapshot `saving` until its
  // second poll, and a fresh environment id once T3's state is gone.
  const templateClient = (
    requests: Array<string>,
    options: {
      readonly saveStatus?: "ready" | "failed";
      readonly commands?: Array<string>;
      /** `GET /limits` answers with this; without it the provider fails to report limits. */
      readonly limits?: () => unknown;
    } = {},
  ) => {
    let stopped = false;
    let scrubbed = false;
    let polls = 0;
    const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    return HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/limits")) {
        const limits = options.limits?.();
        return limits === undefined ? json(request, { ok: false }, 500) : json(request, limits);
      }
      if (request.url.endsWith("/commands")) {
        const command =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body)).command
            : "";
        options.commands?.push(command);
        if (command.includes("rm -rf")) scrubbed = true;
        return json(request, { exitCode: 0, stdout: "", stderr: "" });
      }
      if (request.url.endsWith("/stop")) {
        stopped = true;
        return json(request, { ok: true });
      }
      if (request.url.endsWith("/resume")) {
        stopped = false;
        return json(request, { ok: true });
      }
      if (request.url.endsWith(`/sandboxes/${boatSandboxId}`) && request.method === "GET") {
        return json(request, {
          sandbox: { id: boatSandboxId, state: stopped ? "archived" : "ready" },
        });
      }
      if (request.url.endsWith("/saved-snapshots") && request.method === "POST") {
        return json(request, { ok: true, status: "saving" }, 202);
      }
      if (request.url.endsWith("/saved-snapshots/web-stack")) {
        polls += 1;
        return json(request, {
          snapshot: {
            name: "web-stack",
            status: polls < 2 ? "saving" : (options.saveStatus ?? "ready"),
            type: "large",
            sizeBytes: 1024,
            createdAt: "2026-10-31T00:00:00.000Z",
            ...(options.saveStatus === "failed" ? { error: "disk read failed" } : {}),
          },
        });
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return json(request, {
          ...descriptor,
          ...(scrubbed ? { environmentId: "33333333-3333-4333-8333-333333333333" } : {}),
        });
      }
      return json(request, { ok: true });
    });
  };

  it.effect("resets T3, stops, and saves a sandbox as a template, then deletes the source", () => {
    const requests: Array<string> = [];
    const commands: Array<string> = [];
    const repository = memoryRepository([runningRecord]);
    let limits: unknown = trialLimits;
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // A plan that cannot save is refused before anything on the machine changes.
      const refused = yield* provisioner
        .saveTemplate({ environmentId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.flip);
      expect(refused.code).toBe("templates_unavailable");
      expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      limits = undefined;
      requests.length = 0;

      const fiber = yield* provisioner
        .saveTemplate({ environmentId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);

      expect(saved.template).toEqual({
        name: "web-stack",
        createdAt: "2026-10-31T00:00:00.000Z",
        sizeBytes: 1024,
        size: "large",
      });
      // The snapshot copies the disk, so T3's identity and sessions are gone before the stop that
      // the save captures, and the save waits for the stop to finish.
      expect(requests).toEqual([
        "GET https://boat.dev/api/v1/limits",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/stop`,
        `GET https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        "POST https://boat.dev/api/v1/saved-snapshots",
        "GET https://boat.dev/api/v1/saved-snapshots/web-stack",
        "GET https://boat.dev/api/v1/saved-snapshots/web-stack",
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
      ]);
      expect(commands[0]).toContain("t3 service uninstall");
      expect(commands[0]).toContain(`rm -rf "$HOME/.t3/userdata" "$HOME/.t3/environment-label"`);
      expect(commands[0]).not.toContain("pkill");
      // Without its T3 identity the source could only come back as a different environment.
      expect(repository.records.has(testEnvironmentId)).toBe(false);
    }).pipe(
      Effect.provide(
        provisionerLayer({ sandboxProviders: { boat: { apiKey: "boat_test" } } }, repository.layer),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        templateClient(requests, { commands, limits: () => limits }),
      ),
    );
  });

  it.effect("keeps the source when the save fails and refuses to resume it as itself", () => {
    const requests: Array<string> = [];
    const repository = memoryRepository([runningRecord]);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const fiber = yield* provisioner
        .saveTemplate({ environmentId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const failure = yield* Fiber.join(fiber);

      expect(failure.stage).toBe("template");
      expect(failure.detail).toBe(
        "Boat could not save the template. T3 Code on this sandbox was already reset, so it cannot reconnect. Delete it.",
      );
      expect(failure.message).not.toContain("disk read failed");
      expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");

      // A resumed source answers with a new id that no client holds a session for.
      const resumeFiber = yield* provisioner
        .resume({ environmentId: testEnvironmentId })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const resumeFailure = yield* Fiber.join(resumeFiber);
      expect(resumeFailure.detail).toContain("cannot reconnect as this environment");
      expect(repository.records.get(testEnvironmentId)?.state).toBe("error");
    }).pipe(
      Effect.provide(
        provisionerLayer({ sandboxProviders: { boat: { apiKey: "boat_test" } } }, repository.layer),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        templateClient(requests, { saveStatus: "failed" }),
      ),
    );
  });

  it.effect(
    "starts from a template, and destroys a copy that answers as a known environment",
    () => {
      const requests: Array<string> = [];
      const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
      let environmentId: string = testEnvironmentId;
      const repository = memoryRepository([runningRecord]);
      const client = HttpClient.make((request) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.body._tag === "Uint8Array") {
          bodies.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)),
          });
        }
        const json = (body: unknown) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
        if (request.url.endsWith("/saved-snapshots")) {
          return json({
            snapshots: [
              { name: "web-stack", status: "ready", type: "large", sourceSandboxId: "bx_x" },
            ],
          });
        }
        if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
          return Effect.succeed(boatResponse(request));
        }
        if (request.url.endsWith("/.well-known/t3/environment")) {
          return json({ ...descriptor, environmentId });
        }
        if (request.method === "GET" && request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
          return json({ sandbox: { id: boatSandboxId, state: "ready" } });
        }
        if (request.url.endsWith("/host")) {
          return json({ url: "https://boat.example/t3" });
        }
        if (request.url.endsWith("/commands")) {
          return json({ exitCode: 0, stdout: "Token: pair_tpl\n", stderr: "" });
        }
        return json({ ok: true });
      });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const collision = yield* provisioner
          .create({ provider: "boat", template: "web-stack", size: "small" })
          .pipe(Effect.flip);
        expect(collision.stage).toBe("pair");
        expect(collision.detail).toContain("already exists");
        // Never paired: the destroy follows the identity check directly.
        expect(requests.slice(-2)).toEqual([
          "GET https://boat.example/t3/.well-known/t3/environment",
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        ]);

        environmentId = "44444444-4444-4444-8444-444444444444";
        const created = yield* provisioner.create({ provider: "boat", template: "web-stack" });
        const createBody = bodies.findLast((entry) => entry.url.endsWith("/sandboxes"))?.body;
        // The template carries its size; sending `type` could ask for a smaller disk than it holds.
        expect(createBody).toMatchObject({ from: "web-stack", noEnv: true });
        expect(createBody).not.toHaveProperty("type");
        // Boat relays a copy's port to loopback only once it is hosted again on the running machine.
        expect(bodies.findLast((entry) => entry.url.endsWith("/host"))?.body).toMatchObject({
          port: 3773,
          public: true,
          localhost: true,
        });
        expect(repository.records.get(created.environmentId)).toMatchObject({
          template: "web-stack",
          size: "large",
        });

        const missing = yield* provisioner
          .create({ provider: "boat", template: "gone" })
          .pipe(Effect.flip);
        expect(missing.code).toBe("not_found");
        expect(requests.at(-1)).toBe("GET https://boat.dev/api/v1/saved-snapshots");
      }).pipe(
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );
});

describe("SandboxProvisioner", () => {
  it.effect("pairs a freshly created Boat sandbox and saves the API key", () => {
    let commandCall = 0;
    const requests: Array<string> = [];
    const idempotencyKeys: Array<string | undefined> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/limits")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ ok: false }, { status: 503 })),
        );
      }
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        idempotencyKeys.push(request.headers["idempotency-key"]);
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        commandCall += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              commandCall === 1
                ? { exitCode: 0, stdout: "t3 is running", stderr: "" }
                : {
                    exitCode: 0,
                    stdout: "Pairing URL: http://127.0.0.1:3773/pair#token=abc\nToken: pair_abc\n",
                    stderr: "",
                  },
            ),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const { result, providers } = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_saved",
              label: "My sandbox",
            });
            return { result: created, providers: yield* provisioner.providers };
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(result).toEqual({
        provider: "boat",
        sandboxId: boatSandboxId,
        environmentId: testEnvironmentId,
        label: "My sandbox",
        httpBaseUrl: "https://boat.example/t3",
        pairingCode: "pair_abc",
      });
      expect(providers.providers.find((provider) => provider.kind === "boat")?.configured).toBe(
        true,
      );
      // Limits that cannot be read never block a start; the provider stays the authority. The
      // environment's identity is checked before a pairing code is minted on it.
      expect(requests).toEqual([
        "GET https://boat.dev/api/v1/limits",
        "POST https://boat.dev/api/v1/sandboxes",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        "GET https://boat.example/t3/.well-known/t3/environment",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
      ]);
      expect(idempotencyKeys).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
    });
  });

  it.effect("saves a provider's settings fields with its key and passes them to the driver", () => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      authorization?: string | undefined;
    }> = [];
    let commands = 0;
    const repository = memoryRepository();
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/teams/acme" || url.pathname === "/v2/teams/team_1") {
        return Response.json(vercelTeam("pro"));
      }
      if (url.pathname === "/v2/teams/beta") {
        return Response.json({ ...vercelTeam("pro"), id: "team_2", slug: "beta" });
      }
      if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam("pro")] });
      if (url.pathname === "/.well-known/t3/environment") return Response.json(descriptor);
      if (url.pathname.endsWith("/cmd")) {
        commands += 1;
        return ndjson([
          ...(commands === 1 ? [] : [{ data: "Token: pair_vercel\n", stream: "stdout" }]),
          vercelCommand(0),
        ]);
      }
      if (url.pathname === "/v2/sandboxes" && request.method === "GET") {
        return Response.json({ sandboxes: [] });
      }
      return Response.json(vercelSandbox());
    });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      yield* provisioner.templates({ provider: "vercel" });
      // The saved Team reaches the driver without the client sending it again.
      expect(requests[0]).toMatchObject({
        url: "https://api.vercel.com/v2/teams/acme",
        authorization: "Bearer vcp_saved",
      });

      requests.length = 0;
      const created = yield* provisioner.create({
        provider: "vercel",
        settings: { teamId: "", projectId: " mine ", unknown: "ignored" },
      });
      expect(created.pairingCode).toBe("pair_vercel");
      // A cleared Team falls back to the token's only team, and the saved key is kept.
      expect(requests[0]).toMatchObject({
        url: "https://api.vercel.com/v2/teams?limit=20",
        authorization: "Bearer vcp_saved",
      });
      expect(requests.find((request) => request.url.includes("/v4/sandboxes"))?.body).toMatchObject(
        { projectId: "mine" },
      );
      const vercel = (yield* provisioner.providers).providers.find(
        (provider) => provider.kind === "vercel",
      );
      expect(vercel).toMatchObject({
        configured: true,
        settings: { teamId: "", projectId: "mine" },
      });
      expect(vercel?.settingsFields?.map((field) => field.id)).toEqual(["teamId", "projectId"]);

      // The record keeps the team the driver detected, so a later Team change cannot strand it.
      // A record from before records kept settings follows the current ones.
      const record = repository.records.get(testEnvironmentId)!;
      expect(record.providerSettings).toEqual({ teamId: "team_1", projectId: "mine" });
      const { providerSettings: _, ...legacy } = record;
      const legacyId = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
      repository.records.set(legacyId, { ...legacy, environmentId: legacyId, sandboxId: "legacy" });
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        sandboxProviders: {
          vercel: { apiKey: "vcp_saved", settings: { teamId: "beta", projectId: "other" } },
        },
      });
      requests.length = 0;
      yield* provisioner.sweep;
      expect(requests.map((request) => request.url)).toEqual(
        expect.arrayContaining([
          "https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=mine",
          "https://api.vercel.com/v2/sandboxes/legacy?teamId=team_2&projectId=other",
        ]),
      );
      expect(repository.records.get(testEnvironmentId)?.state).toBe("running");
    }).pipe(
      Effect.provide(
        provisionerLayer(
          { sandboxProviders: { vercel: { apiKey: "vcp_saved", settings: { teamId: "acme" } } } },
          repository.layer,
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect("deletes the sandbox when the public port cannot be exposed", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ok: true, sandbox: { id: boatSandboxId, name: "Boat sandbox" } }),
          ),
        );
      }
      if (request.method === "GET" && request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ sandbox: { id: boatSandboxId, state: "ready" } }),
          ),
        );
      }
      if (request.url.endsWith("/host")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "no ports left" }, { status: 503 }),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test" }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("expose");
      // A machine that could not be reached must not keep billing.
      expect(requests.at(-1)).toBe(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
    });
  });

  it.effect("deletes the sandbox when pairing fails", () => {
    const requests: Array<string> = [];
    const deleteHeaders: Array<string | undefined> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "DELETE") {
        deleteHeaders.push(request.headers["x-ascii-confirm-delete"]);
      }
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/commands")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ exitCode: 0, stdout: "", stderr: "" }),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test" }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("pair");
      expect(requests.at(-1)).toBe(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
      // Boat refuses to delete without this confirmation header.
      expect(deleteHeaders).toEqual([boatSandboxId]);
    });
  });
});
