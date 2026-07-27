import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as guardduty from "@distilled.cloud/aws/guardduty";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GuardDutyTestFunctionLive, { GuardDutyTestFunction } from "./handler";
import { makeGuardDutyTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GuardDutyBindings");
const testLease = makeGuardDutyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let accountId: string;
// The GuardDuty detector is an account/region singleton. If the account
// already runs a detector this suite did not create, deploying the fixture
// would adopt (and later DELETE) it — so every test degrades to a logged
// no-op instead (capture-and-restore safety, mirroring Detector.test.ts).
let foreignDetectorId: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

// beforeAll/afterAll hooks run outside `test.provider`'s layer, so raw
// distilled calls need the provider layer (credentials, region) supplied
// explicitly.
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

const skipForeign = () =>
  foreignDetectorId
    ? Effect.logInfo(
        `GuardDuty detector ${foreignDetectorId} already exists and is not ours — skipping`,
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

describe.sequential("GuardDuty Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // Never take over a detector this fixture did not create.
      const preexisting = (yield* aws(guardduty.listDetectors({})))
        .DetectorIds?.[0];
      if (preexisting) {
        const detector = yield* aws(
          guardduty.getDetector({ DetectorId: preexisting }),
        );
        if (detector.Tags?.["fixture"] !== "guardduty-bindings") {
          foreignDetectorId = preexisting;
          yield* Effect.logInfo(
            `GuardDuty test setup: foreign detector ${preexisting} present — suite degrades to no-op`,
          );
          return;
        }
      }

      yield* Effect.logInfo(
        "GuardDuty test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("GuardDuty test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GuardDutyTestFunction;
        }).pipe(Effect.provide(GuardDutyTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      accountId = attrs.roleArn.split(":")[4]!;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `GuardDuty test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `GuardDuty test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      if (foreignDetectorId) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 19 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(19);
        expect(response.bound).toContain("createSampleFindings");
        expect(response.bound).toContain("listFindings");
        expect(response.bound).toContain("getInvitationsCount");
      }),
    );
  });

  describe("CreateSampleFindings + ListFindings + GetFindings + ArchiveFindings", () => {
    test.provider(
      "sample finding round-trips through the triage loop (injected detector id)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;

          // Generate a sample finding on our own detector.
          const sample = (yield* postJson("/sample")) as { ok: boolean };
          expect(sample.ok).toBe(true);

          // Sample findings surface asynchronously — poll bounded.
          const findings = (yield* getJson("/findings").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r as { count: number }).count > 0,
              times: 20,
            }),
          )) as { count: number; ids: string[] };
          expect(findings.count).toBeGreaterThan(0);

          // Hydrate the full finding document.
          const detail = (yield* getJson(
            `/finding-detail?id=${encodeURIComponent(findings.ids[0]!)}`,
          )) as { count: number; type?: string; archived: boolean };
          expect(detail.count).toBe(1);
          expect(detail.type).toBe("Recon:EC2/PortProbeUnprotectedPort");

          // Statistics group the sample finding by severity.
          const stats = (yield* getJson("/stats")) as { severities: string[] };
          expect(stats.severities.length).toBeGreaterThan(0);

          // Archive everything we generated — a real write.
          const archived = (yield* postJson("/archive")) as {
            archived: number;
          };
          expect(archived.archived).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListMembers", () => {
    test.provider("a standalone detector has no members", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/members")) as { count: number };
        expect(response.count).toBe(0);
      }),
    );
  });

  describe("GetAdministratorAccount", () => {
    test.provider(
      "a standalone account has no administrator (typed outcome either way)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* getJson("/admin")) as {
            administrator?: string | null;
            errorTag?: string;
          };
          if (response.errorTag) {
            // GuardDuty rejects the call outright for a standalone
            // (non-member) account.
            expect(["BadRequestException", "AccessDeniedException"]).toContain(
              response.errorTag,
            );
          } else {
            expect(response.administrator ?? null).toBeNull();
          }
        }),
    );
  });

  describe("GetMalwareScanSettings", () => {
    test.provider("reads the detector's malware scan settings", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/malware-settings")) as {
          ebsSnapshotPreservation?: string | null;
          errorTag?: string;
        };
        if (response.errorTag) {
          // Malware Protection may not be enabled on a fresh detector.
          expect(["BadRequestException"]).toContain(response.errorTag);
        } else {
          expect(response).toHaveProperty("ebsSnapshotPreservation");
        }
      }),
    );
  });

  describe("GetUsageStatistics", () => {
    test.provider("reports usage grouped by data source", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/usage")) as {
          dataSources: number;
        };
        expect(response.dataSources).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListCoverage + GetRemainingFreeTrialDays", () => {
    test.provider("reads coverage and free-trial state", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const coverage = (yield* getJson("/coverage")) as {
          resources: number;
        };
        expect(coverage.resources).toBeGreaterThanOrEqual(0);

        const freeTrial = (yield* getJson(
          `/free-trial?account=${accountId}`,
        )) as {
          accounts: number;
        };
        expect(freeTrial.accounts).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListInvestigations", () => {
    test.provider("a fresh detector has no investigations", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/investigations")) as {
          count?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          // Extended Threat Detection may be unavailable for the account.
          expect(["BadRequestException", "AccessDeniedException"]).toContain(
            response.errorTag,
          );
        } else {
          expect(response.count).toBe(0);
        }
      }),
    );
  });

  describe("DescribeOrganizationConfiguration", () => {
    test.provider(
      "answers (or rejects with a typed error for a non-delegated account)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* getJson("/org-config")) as {
            autoEnable?: boolean;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect(["BadRequestException", "AccessDeniedException"]).toContain(
              response.errorTag,
            );
          } else {
            expect(typeof response.autoEnable).toBe("boolean");
          }
        }),
    );
  });

  describe("ListOrganizationAdminAccounts + GetOrganizationStatistics", () => {
    test.provider(
      "answers (or rejects with a typed error outside the management account)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const admins = (yield* getJson("/org-admins")) as {
            admins?: number;
            errorTag?: string;
          };
          if (admins.errorTag) {
            expect(["BadRequestException", "AccessDeniedException"]).toContain(
              admins.errorTag,
            );
          } else {
            expect(admins.admins).toBeGreaterThanOrEqual(0);
          }

          const stats = (yield* getJson("/org-stats")) as {
            activeAccounts?: number;
            errorTag?: string;
          };
          if (stats.errorTag) {
            expect(["BadRequestException", "AccessDeniedException"]).toContain(
              stats.errorTag,
            );
          } else {
            expect(stats.activeAccounts).toBeGreaterThanOrEqual(0);
          }
        }),
    );
  });

  describe("GetInvitationsCount + ListInvitations", () => {
    test.provider("reads this account's invitation state", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const count = (yield* getJson("/invitations-count")) as {
          count: number;
        };
        expect(count.count).toBeGreaterThanOrEqual(0);

        const invitations = (yield* getJson("/invitations")) as {
          count: number;
        };
        expect(invitations.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
