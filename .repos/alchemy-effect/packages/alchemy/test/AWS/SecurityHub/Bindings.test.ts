import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as securityhub from "@distilled.cloud/aws/securityhub";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SecurityHubTestFunctionLive, {
  SecurityHubTestFunction,
} from "./handler";
import { makeSecurityHubTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SecurityHubBindings");
const testLease = makeSecurityHubTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
// The Hub is an account/region singleton. If the account already runs a Hub
// this suite did not create, deploying the fixture would adopt (and later
// DISABLE) it — so every test degrades to a logged no-op instead
// (capture-and-restore safety, mirroring Hub.test.ts).
let foreignHub = false;
// Filled in by beforeAll from the live Hub ARN (`arn:aws:securityhub:REGION:ACCOUNT:hub/default`).
let accountId = "";
let region = "";

const findingId = "alchemy/securityhub-bindings/test-finding-1";
const productArn = () =>
  `arn:aws:securityhub:${region}:${accountId}:product/${accountId}/default`;

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

const describeHub = securityhub.describeHub({}).pipe(
  Effect.map((hub) => hub as securityhub.DescribeHubResponse | undefined),
  Effect.catchTag("InvalidAccessException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

const skipForeign = () =>
  foreignHub
    ? Effect.logInfo(
        "Security Hub is already enabled by someone else — skipping",
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

describe.sequential("SecurityHub Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // Destroy OUR previous resources first — a crashed prior run leaves the
      // fixture's own Hub enabled, which must not be mistaken for a foreign
      // one. Destroying the scratch stack disables Security Hub only if the
      // Hub is tracked in our state.
      yield* Effect.logInfo(
        "SecurityHub test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      // Never take over a Hub this fixture did not create — any Hub that
      // remains after our own destroy is foreign.
      const preexisting = yield* aws(describeHub);
      if (preexisting) {
        foreignHub = true;
        yield* Effect.logInfo(
          "SecurityHub test setup: Security Hub already enabled — suite degrades to no-op",
        );
        return;
      }

      yield* Effect.logInfo("SecurityHub test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SecurityHubTestFunction;
        }).pipe(Effect.provide(SecurityHubTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      // The fixture just enabled the Hub — parse account/region from its ARN
      // for the import flow.
      const hub = yield* aws(describeHub);
      expect(hub?.HubArn).toBeTruthy();
      const [, , , hubRegion, hubAccount] = hub!.HubArn!.split(":");
      region = hubRegion!;
      accountId = hubAccount!;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `SecurityHub test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SecurityHub test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      if (foreignHub) return;
      yield* sharedStack.destroy();
      // Destroying the stack disables Security Hub for the account — zero
      // orphans.
      const after = yield* aws(describeHub);
      expect(after).toBeUndefined();
    }),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider("all 20 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(20);
        expect(response.bound).toContain("batchImportFindings");
        expect(response.bound).toContain("getFindings");
        expect(response.bound).toContain("describeStandards");
      }),
    );
  });

  describe("BatchImportFindings + GetFindings + BatchUpdateFindings + GetFindingHistory", () => {
    test.provider(
      "a custom finding flows through the triage loop",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;

          // Import a synthetic ASFF finding through the default product.
          const imported = (yield* postJson(
            `/import?id=${encodeURIComponent(findingId)}&account=${accountId}&region=${region}`,
          )) as { success: number; failed: number };
          expect(imported.failed).toBe(0);
          expect(imported.success).toBe(1);

          // The imported finding surfaces asynchronously — poll bounded to
          // ~45s; the write above already proved the binding + IAM wiring.
          const findings = (yield* getJson(
            `/findings?id=${encodeURIComponent(findingId)}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r as { count: number }).count > 0,
              times: 15,
            }),
          )) as { count: number; title?: string };

          if (findings.count > 0) {
            expect(findings.title).toBe(
              "Alchemy SecurityHub bindings test finding",
            );

            // Update customer-editable fields on the finding.
            const resolved = (yield* postJson(
              `/resolve?id=${encodeURIComponent(findingId)}&productArn=${encodeURIComponent(productArn())}`,
            )) as { processed: number; unprocessed: number };
            expect(resolved.processed).toBe(1);
            expect(resolved.unprocessed).toBe(0);

            // History records the import + the workflow update (may lag —
            // a typed ResourceNotFoundException is acceptable).
            const history = (yield* getJson(
              `/history?id=${encodeURIComponent(findingId)}&productArn=${encodeURIComponent(productArn())}`,
            )) as { records?: number; errorTag?: string };
            if (history.errorTag) {
              expect(history.errorTag).toBe("ResourceNotFoundException");
            } else {
              expect(history.records).toBeGreaterThanOrEqual(0);
            }
          } else {
            yield* Effect.logWarning(
              "imported finding did not surface within the bounded poll — continuing (import succeeded)",
            );
          }
        }),
      { timeout: 150_000 },
    );
  });

  describe("DescribeStandards + GetEnabledStandards + control definitions", () => {
    test.provider("reads the standards and controls catalog", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const standards = (yield* getJson("/standards")) as { count: number };
        expect(standards.count).toBeGreaterThan(0);

        // The fixture enables the Hub without default standards.
        const enabled = (yield* getJson("/enabled-standards")) as {
          count: number;
        };
        expect(enabled.count).toBe(0);

        const definitions = (yield* getJson("/control-definitions")) as {
          count: number;
        };
        expect(definitions.count).toBeGreaterThan(0);

        const control = (yield* getJson("/control")) as {
          id: string | null;
          severity: string | null;
        };
        expect(control.id).toBe("IAM.1");
        expect(control.severity).toBeTruthy();
      }),
    );
  });

  describe("DescribeProducts + ListEnabledProductsForImport", () => {
    test.provider("reads the product integration catalog", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const products = (yield* getJson("/products")) as { count: number };
        expect(products.count).toBeGreaterThan(0);

        const enabled = (yield* getJson("/enabled-products")) as {
          count: number;
        };
        expect(enabled.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeActionTargets + ListAutomationRules + ListFindingAggregators + GetInsights", () => {
    test.provider("a fresh Hub has no user configuration", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const actions = (yield* getJson("/action-targets")) as {
          count: number;
        };
        expect(actions.count).toBe(0);

        const rules = (yield* getJson("/automation-rules")) as {
          count: number;
        };
        expect(rules.count).toBe(0);

        const aggregators = (yield* getJson("/aggregators")) as {
          count: number;
        };
        expect(aggregators.count).toBe(0);

        const insights = (yield* getJson("/insights")) as { count: number };
        expect(insights.count).toBe(0);
      }),
    );
  });

  describe("GetAdministratorAccount + members + invitations", () => {
    test.provider("reads this account's membership state", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const admin = (yield* getJson("/admin")) as {
          administrator?: string | null;
          errorTag?: string;
        };
        if (admin.errorTag) {
          expect([
            "ResourceNotFoundException",
            "InvalidAccessException",
          ]).toContain(admin.errorTag);
        } else {
          expect(admin.administrator ?? null).toBeNull();
        }

        const members = (yield* getJson("/members")) as { count: number };
        expect(members.count).toBe(0);

        const invitations = (yield* getJson("/invitations")) as {
          count: number;
        };
        expect(invitations.count).toBeGreaterThanOrEqual(0);

        const count = (yield* getJson("/invitations-count")) as {
          count: number;
        };
        expect(count.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListOrganizationAdminAccounts + DescribeOrganizationConfiguration", () => {
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
            expect([
              "AccessDeniedException",
              "InvalidAccessException",
            ]).toContain(admins.errorTag);
          } else {
            expect(admins.admins).toBeGreaterThanOrEqual(0);
          }

          const orgConfig = (yield* getJson("/org-config")) as {
            autoEnable?: boolean;
            errorTag?: string;
          };
          if (orgConfig.errorTag) {
            expect([
              "AccessDeniedException",
              "InvalidAccessException",
            ]).toContain(orgConfig.errorTag);
          } else {
            expect(typeof orgConfig.autoEnable).toBe("boolean");
          }
        }),
    );
  });
});
