import {
  HermesCronError,
  ProviderInstanceConfigMap,
  type HermesGatewayCompatibility,
  type HermesGatewayCronListResult,
  type HermesGatewayCronMutationResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import {
  makeHermesCron,
  projectHermesCronCapabilities,
  projectHermesCronJob,
} from "./HermesCron.ts";
import {
  HermesGatewayConfigurationError,
  HermesGatewayDuplicateOperationIdError,
} from "./HermesGatewayClient.ts";

const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

describe("HermesCron projection", () => {
  it("keeps pinned legacy gateways limited to evidenced operations", () => {
    expect(
      projectHermesCronCapabilities({
        status: "legacy",
        protocol: null,
        inventory: null,
        capabilities: ["cron.read", "cron.manage"],
        reason: "legacy",
      }),
    ).toEqual({
      inventory: true,
      create: true,
      edit: false,
      pause: false,
      resume: false,
      delete: true,
      runNow: false,
    });
  });

  it("fails closed for unsupported gateways even when capabilities are advertised", () => {
    expect(
      projectHermesCronCapabilities({
        status: "unsupported",
        protocol: null,
        inventory: {
          "cron.read": "supported",
          "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
        },
        capabilities: ["cron.read", "cron.manage"],
        reason: "unsupported",
      }),
    ).toEqual({
      inventory: false,
      create: false,
      edit: false,
      pause: false,
      resume: false,
      delete: false,
      runNow: false,
    });
  });

  it("enables extension mutations only from advertised granular operations", () => {
    expect(
      projectHermesCronCapabilities({
        status: "supported",
        protocol: { major: 1, minor: 2 },
        inventory: {
          "cron.read": "supported",
          "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
        },
        capabilities: ["cron.read", "cron.manage"],
        reason: "supported",
      }),
    ).toEqual({
      inventory: true,
      create: true,
      edit: true,
      pause: true,
      resume: true,
      delete: true,
      runNow: true,
    });
  });

  it("projects provenance and deterministically deduplicates cron executions", () => {
    const job = projectHermesCronJob(
      "hermes_work",
      "work",
      {
        id: "job-1",
        name: "Daily check",
        schedule: "0 9 * * *",
        prompt: "Check status",
        enabled: true,
        executions: [
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { status: "failed", started_at: "2026-01-02" },
        ],
      },
      0,
    );

    expect(job.identity).toBe("job-1");
    expect(job.executions).toHaveLength(2);
    expect(job.executions[0]).toMatchObject({
      dedupeKey: "hermes-run:run-1",
      provenance: {
        scheduler: "hermes",
        providerInstanceId: "hermes_work",
        profileKey: "work",
        jobIdentity: "job-1",
        upstreamRunId: "run-1",
        upstreamCursor: 4,
        identityStrength: "upstream",
      },
    });
    expect(job.executions[1]?.dedupeKey).toMatch(/^hermes-derived:/u);
  });

  it("marks jobs without upstream id or name as unaddressable", () => {
    const first = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    const second = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    expect(first.identityStrength).toBe("missing");
    expect(first.identity).toBe(second.identity);
  });
});

describe("HermesCron mutate", () => {
  const compatibility: HermesGatewayCompatibility = {
    status: "supported",
    protocol: { major: 1, minor: 2 },
    inventory: {
      "cron.read": "supported",
      "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
    },
    capabilities: ["cron.read", "cron.manage"],
    reason: "supported",
  };

  const settingsLayer = ServerSettings.layerTest({
    enableHermes: true,
    providerInstances: decodeProviderInstanceConfigMap({
      hermes_main: {
        driver: "hermes",
        displayName: "Hermes",
        enabled: true,
        environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-1", sensitive: true }],
        config: { enabled: true, endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "work" },
      },
    }),
  });

  const runMutation = (listCronJobs: () => Promise<HermesGatewayCronListResult>) =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          listCronJobs,
          manageCron: () =>
            Promise.resolve({
              success: true,
              job_id: "job-1",
              run_id: "run-1",
            } satisfies HermesGatewayCronMutationResult),
          close: () => {},
        }),
      });
      return yield* cron.mutate({
        providerInstanceId: "hermes_main",
        operation: "create",
        operationId: "op-1",
        name: "Daily check",
        schedule: "0 9 * * *",
        prompt: "Check status",
      });
    }).pipe(Effect.provide(settingsLayer));

  it.effect("returns the confirmed mutation when the follow-up inventory refresh fails", () =>
    Effect.gen(function* () {
      const response = yield* runMutation(() => Promise.reject(new Error("refresh failed")));
      expect(response.upstreamJobId).toBe("job-1");
      expect(response.upstreamRunId).toBe("run-1");
      expect(response.provider.status).toBe("error");
      expect(response.provider.diagnostics).toContain(
        "Cron mutation succeeded, but the follow-up cron inventory refresh failed.",
      );
    }),
  );

  it.effect("projects the refreshed inventory when the follow-up read succeeds", () =>
    Effect.gen(function* () {
      const response = yield* runMutation(() =>
        Promise.resolve({ success: true, jobs: [{ id: "job-1", name: "Daily check" }] }),
      );
      expect(response.upstreamJobId).toBe("job-1");
      expect(response.provider.status).toBe("ready");
      expect(response.provider.jobs.map((job) => job.id)).toEqual(["job-1"]);
    }),
  );

  it.effect("projects a throwing client factory as a per-provider error in list", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          throw new Error("factory blocked");
        },
      });
      const result = yield* cron.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({
        status: "error",
        capabilities: { inventory: false, create: false },
        jobs: [],
      });
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("projects an unsuccessful cron inventory response as a provider error", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          listCronJobs: () =>
            Promise.resolve({ success: false, jobs: [] } satisfies HermesGatewayCronListResult),
          manageCron: () => Promise.reject(new Error("unused")),
          close: () => {},
        }),
      });
      const result = yield* cron.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({ status: "error", jobs: [] });
      expect(main?.diagnostics).toContain(
        "Hermes gateway reported an unsuccessful cron inventory response.",
      );
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("reuses one gateway client so a repeated operation id cannot replay", () =>
    Effect.gen(function* () {
      let factoryCalls = 0;
      let executedMutations = 0;
      const usedOperationIds = new Set<string>();
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          factoryCalls += 1;
          return {
            compatibility,
            connect: () => Promise.resolve(compatibility),
            hasCapability: () => true,
            listCronJobs: () =>
              Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
            manageCron: (_params, options) => {
              if (usedOperationIds.has(options.operationId)) {
                return Promise.reject(
                  new HermesGatewayDuplicateOperationIdError(
                    `Hermes mutation operationId has already been used: ${options.operationId}`,
                  ),
                );
              }
              usedOperationIds.add(options.operationId);
              executedMutations += 1;
              return Promise.resolve({
                success: true,
                job_id: "job-1",
              } satisfies HermesGatewayCronMutationResult);
            },
            close: () => {},
          };
        },
      });
      const input = {
        providerInstanceId: "hermes_main",
        operation: "run_now",
        operationId: "op-repeated",
        jobIdentity: "job-1",
      } as const;
      const first = yield* cron.mutate(input);
      expect(first.upstreamJobId).toBe("job-1");
      const failure = yield* cron.mutate(input).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_input");
      expect(factoryCalls).toBe(1);
      expect(executedMutations).toBe(1);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("closes and evicts the stale client when the connection identity changes", () =>
    Effect.gen(function* () {
      let factoryCalls = 0;
      const closedTokens: Array<string> = [];
      const cron = yield* makeHermesCron({
        clientFactory: ({ authToken }) => {
          factoryCalls += 1;
          return {
            compatibility,
            connect: () => Promise.resolve(compatibility),
            hasCapability: () => true,
            listCronJobs: () =>
              Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
            manageCron: () =>
              Promise.resolve({
                success: true,
                job_id: "job-1",
              } satisfies HermesGatewayCronMutationResult),
            close: () => {
              closedTokens.push(authToken);
            },
          };
        },
      });
      const input = (operationId: string) =>
        ({
          providerInstanceId: "hermes_main",
          operation: "run_now",
          operationId,
          jobIdentity: "job-1",
        }) as const;
      yield* cron.mutate(input("op-a"));
      expect(factoryCalls).toBe(1);
      expect(closedTokens).toEqual([]);

      const settingsService = yield* ServerSettings.ServerSettingsService;
      yield* settingsService.updateSettings({
        providerInstances: decodeProviderInstanceConfigMap({
          hermes_main: {
            driver: "hermes",
            displayName: "Hermes",
            enabled: true,
            environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-2", sensitive: true }],
            config: { enabled: true, endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "work" },
          },
        }),
      });
      yield* cron.mutate(input("op-b"));
      expect(factoryCalls).toBe(2);
      expect(closedTokens).toEqual(["token-1"]);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps non-duplicate configuration errors to a gateway diagnostic", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          listCronJobs: () =>
            Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
          manageCron: () =>
            Promise.reject(
              new HermesGatewayConfigurationError("Hermes remote access is not paired."),
            ),
          close: () => {},
        }),
      });
      const failure = yield* cron
        .mutate({
          providerInstanceId: "hermes_main",
          operation: "run_now",
          operationId: "op-config",
          jobIdentity: "job-1",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("gateway_error");
      expect(failure.message).toContain("Hermes remote access is not paired.");
      expect(failure.message).not.toContain("already used");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps a throwing client factory to a typed error in mutate", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          throw new Error("factory blocked");
        },
      });
      const failure = yield* cron
        .mutate({
          providerInstanceId: "hermes_main",
          operation: "create",
          operationId: "op-1",
          name: "Daily check",
          schedule: "0 9 * * *",
          prompt: "Check status",
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(HermesCronError);
      expect(failure.code).toBe("gateway_error");
    }).pipe(Effect.provide(settingsLayer)),
  );
});
