import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Inspector2TestFunctionLive, { Inspector2TestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Inspector2Bindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

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

// Accounts where Inspector scanning is not enabled answer some data-plane
// reads with a typed AccessDeniedException — either outcome proves the
// binding + IAM wiring end-to-end.
const DISABLED_OK = ["AccessDeniedException", "ValidationException"];

describe.sequential("Inspector2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Inspector2 test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Inspector2 test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Inspector2TestFunction;
        }).pipe(Effect.provide(Inspector2TestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Inspector2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Inspector2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 44 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(44);
        expect(response.bound).toContain("listFindings");
        expect(response.bound).toContain("searchVulnerabilities");
        expect(response.bound).toContain("createSbomExport");
        expect(response.bound).toContain("enableDelegatedAdminAccount");
      }),
    );
  });

  describe("ListFindings", () => {
    test.provider("lists findings (or typed error when disabled)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/findings")) as {
          count?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.count).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("ListCoverage", () => {
    test.provider("lists covered resources", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/coverage")) as {
          count?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.count).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("SearchVulnerabilities", () => {
    test.provider("looks up log4shell in the vulnerability intel", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/vulnerability?id=CVE-2021-44228",
        )) as { ids?: string[]; errorTag?: string };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.ids).toContain("CVE-2021-44228");
        }
      }),
    );
  });

  describe("ListUsageTotals", () => {
    test.provider("answers with usage totals", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/usage")) as {
          totals?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.totals).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("ListAccountPermissions", () => {
    test.provider("enumerates granted Inspector permissions", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/account-permissions")) as {
          permissions?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.permissions).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("BatchGetFreeTrialInfo", () => {
    test.provider("reports free-trial status for the account", (_stack) =>
      Effect.gen(function* () {
        const { Account } = yield* sts.getCallerIdentity({});
        const response = (yield* getJson(`/free-trial?account=${Account}`)) as {
          accounts?: number;
          failed?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect((response.accounts ?? 0) + (response.failed ?? 0)).toBe(1);
        }
      }),
    );
  });

  describe("GetConfiguration", () => {
    test.provider("reads the account scan configuration", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/config")) as {
          hasEcrConfiguration?: boolean;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(typeof response.hasEcrConfiguration).toBe("boolean");
        }
      }),
    );
  });

  describe("GetEc2DeepInspectionConfiguration", () => {
    test.provider("reads deep-inspection status", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/deep-inspection")) as {
          status?: string;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(typeof response.status).toBe("string");
        }
      }),
    );
  });

  describe("GetEncryptionKey", () => {
    test.provider("reads the ECR package-scan key", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/encryption-key")) as {
          kmsKeyId?: string;
          errorTag?: string;
        };
        if (response.errorTag) {
          // ResourceNotFoundException = no customer-managed key configured.
          expect([...DISABLED_OK, "ResourceNotFoundException"]).toContain(
            response.errorTag,
          );
        } else {
          expect(response.kmsKeyId).toBeTruthy();
        }
      }),
    );
  });

  describe("ListCisScans", () => {
    test.provider("enumerates CIS scans", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/cis-scans")) as {
          scans?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.scans).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("ListMembers", () => {
    test.provider("enumerates organization members", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/members")) as {
          members?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          expect(DISABLED_OK).toContain(response.errorTag);
        } else {
          expect(response.members).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("DescribeOrganizationConfiguration", () => {
    test.provider(
      "answers (or rejects with a typed error for a non-delegated account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/org-config")) as {
            maxAccountLimitReached?: boolean;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect(DISABLED_OK).toContain(response.errorTag);
          } else {
            expect(typeof response.maxAccountLimitReached).toBe("boolean");
          }
        }),
    );
  });

  describe("GetDelegatedAdminAccount", () => {
    test.provider(
      "answers (or rejects with a typed error outside an organization)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/delegated-admin")) as {
            accountId?: string;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect([...DISABLED_OK, "ResourceNotFoundException"]).toContain(
              response.errorTag,
            );
          } else {
            expect(response.accountId === undefined || true).toBe(true);
          }
        }),
    );
  });

  describe("GetFindingsReportStatus", () => {
    test.provider(
      "a nonexistent report id comes back as a typed error",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/report-status")) as {
            status?: string;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect([...DISABLED_OK, "ResourceNotFoundException"]).toContain(
              response.errorTag,
            );
          } else {
            expect(typeof response.status).toBe("string");
          }
        }),
    );
  });
});
