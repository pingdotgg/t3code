import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { EnvironmentId, SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import type { SandboxRecord } from "@t3tools/contracts";
import { requestJson } from "./SandboxProvider.ts";
import { boatDriver } from "./providers/boat.ts";
import { daytonaDriver } from "./providers/daytona.ts";

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
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(repository),
    Layer.provide(NodeCrypto.layer),
  );

const testLayer = provisionerLayer();

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
          config: { apiKey: "boat_test" },
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
      });
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
            config: { apiKey: "boat_test" },
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
          config: { apiKey: "dtn_test" },
          name: "Daytona sandbox",
          size: "daytona-medium",
          ttlMinutes: 480,
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const executed = yield* daytonaDriver
        .execute({
          config: { apiKey: "dtn_test" },
          sandboxId: created.id,
          command: "t3 pair",
          timeoutSeconds: 30,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const preview = yield* daytonaDriver
        .exposePort({ config: { apiKey: "dtn_test" }, sandboxId: created.id, port: 3773 })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({ id: "sandbox_1", name: "Daytona sandbox" });
      expect(executed.stdout).toContain("Token: pair_xyz");
      expect(preview).toBe("https://3773-sandbox_1.proxy.daytona.works");
      // Daytona deletes at its TTL, so the backstop sits a day past T3's non-destructive stop.
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ ttlMinutes: 480 + 1440 });
      expect(requests.map((request) => request.url)).toContain(
        "https://toolbox.example/toolbox/sandbox_1/process/execute",
      );
    }),
  );
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
        config: { apiKey: "boat_test" },
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
        boatDriver.limits!({ config: { apiKey: "boat_test" } }).pipe(
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
      const limits = yield* daytonaDriver.limits!({ config: { apiKey: "dtn_test" } }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
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
        { provider: "boat", status: 401, body: { code: "unauthorized" }, code: "api_key_rejected" },
        { provider: "boat", status: 404, body: {}, code: "not_found" },
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
  const memoryRepository = (initial: ReadonlyArray<SandboxRecord> = []) => {
    const records = new Map(initial.map((record) => [record.environmentId, record]));
    const layer = Layer.succeed(
      SandboxRecords.SandboxRecordRepository,
      SandboxRecords.SandboxRecordRepository.of({
        list: Effect.sync(() => [...records.values()]),
        get: (environmentId) =>
          Effect.sync(() => Option.fromUndefinedOr(records.get(environmentId))),
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
    const repository = memoryRepository([expired]);
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
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(failure.detail).toContain("8-hour limit");
      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");
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
        Effect.flatMap((provisioner) => provisioner.sweepDeadlines),
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
    });
  });
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
      // Limits that cannot be read never block a start; the provider stays the authority.
      expect(requests).toEqual([
        "GET https://boat.dev/api/v1/limits",
        "POST https://boat.dev/api/v1/sandboxes",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        "GET https://boat.example/t3/.well-known/t3/environment",
      ]);
      expect(idempotencyKeys).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
    });
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
