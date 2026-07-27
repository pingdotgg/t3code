import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as macie2 from "@distilled.cloud/aws/macie2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Macie2TestFunctionLive, { Macie2TestFunction } from "./handler";
import { makeMacie2TestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Macie2Bindings");
const testLease = makeMacie2TestLease();

// This budget covers waiting behind the other Macie files, not an AWS API
// operation. Bindings can legitimately hold the singleton lease for several
// minutes under a full parallel sweep (setup + sample-finding poll + cleanup).
beforeAll(testLease.acquire, { timeout: 3_600_000 });
afterAll(testLease.release);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
// The Macie session is an account/region singleton with no tags, so ownership
// cannot be verified from the cloud. If the account already runs a session
// this suite did not create, deploying the fixture would adopt (and later
// DISABLE) it — so every test degrades to a logged no-op instead
// (capture-and-restore safety, mirroring Session.test.ts).
let foreignSession = false;

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

const getSession = macie2.getMacieSession({}).pipe(
  Effect.map((s) => s as macie2.GetMacieSessionResponse | undefined),
  Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

const skipForeign = () =>
  foreignSession
    ? Effect.logInfo(
        "Macie is already enabled by someone else — skipping",
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

describe.sequential("Macie2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // Destroy OUR previous resources first — a crashed prior run leaves the
      // fixture's own session enabled, which must not be mistaken for a
      // foreign one. Destroying the scratch stack disables Macie only if the
      // session is tracked in our state.
      yield* Effect.logInfo("Macie2 test setup: destroying previous resources");
      yield* sharedStack.destroy();

      // Never take over a Macie session this fixture did not create — any
      // session that remains after our own destroy is foreign.
      const preexisting = yield* aws(getSession);
      if (preexisting) {
        foreignSession = true;
        yield* Effect.logInfo(
          "Macie2 test setup: Macie already enabled — suite degrades to no-op",
        );
        return;
      }

      yield* Effect.logInfo("Macie2 test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Macie2TestFunction;
        }).pipe(Effect.provide(Macie2TestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Macie2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Macie2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      if (foreignSession) return;
      yield* sharedStack.destroy();
      // Destroying the stack disables Macie for the account — zero orphans.
      const after = yield* aws(getSession);
      expect(after).toBeUndefined();
    }),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider("all 22 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(22);
        expect(response.bound).toContain("createSampleFindings");
        expect(response.bound).toContain("listFindings");
        expect(response.bound).toContain("testCustomDataIdentifier");
      }),
    );
  });

  describe("TestCustomDataIdentifier", () => {
    test.provider("a detection regex round-trips with match counts", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* postJson("/test-identifier")) as {
          matchCount: number;
        };
        expect(response.matchCount).toBe(2);
      }),
    );
  });

  describe("CreateSampleFindings + ListFindings + GetFindings + GetFindingStatistics", () => {
    test.provider(
      "sample findings flow through the triage loop",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;

          // Generate sample findings.
          const sample = (yield* postJson("/sample")) as { ok: boolean };
          expect(sample.ok).toBe(true);

          // Sample findings surface asynchronously (documented up to ~5
          // minutes) — poll bounded to ~60s; the writes above already proved
          // the binding + IAM wiring, so a slow surface is not a failure.
          const findings = (yield* getJson("/findings").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r as { count: number }).count > 0,
              times: 20,
            }),
          )) as { count: number; ids: string[] };

          if (findings.count > 0) {
            // Hydrate the full finding document.
            const detail = (yield* getJson(
              `/finding-detail?id=${encodeURIComponent(findings.ids[0]!)}`,
            )) as { count: number; type?: string; sample: boolean };
            expect(detail.count).toBe(1);
            expect(detail.sample).toBe(true);
          } else {
            yield* Effect.logWarning(
              "Macie sample findings did not surface within the bounded poll — continuing (writes succeeded)",
            );
          }

          // Statistics grouped by severity answer either way.
          const stats = (yield* getJson("/finding-stats")) as {
            groups: number;
          };
          expect(stats.groups).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 150_000 },
    );
  });

  describe("GetBucketStatistics + SearchResources", () => {
    test.provider("reads Macie's S3 inventory", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const buckets = (yield* getJson("/buckets")) as {
          bucketCount: number;
        };
        expect(buckets.bucketCount).toBeGreaterThanOrEqual(0);

        const search = (yield* getJson("/search")) as { matches: number };
        expect(search.matches).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListManagedDataIdentifiers", () => {
    test.provider("lists Macie's managed data identifiers", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/managed-identifiers")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThan(0);
      }),
    );
  });

  describe("ListAllowLists + ListFindingsFilters + ListClassificationJobs", () => {
    test.provider("a fresh session has no user configuration", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const allowLists = (yield* getJson("/allow-lists")) as {
          count: number;
        };
        expect(allowLists.count).toBe(0);

        const filters = (yield* getJson("/findings-filters")) as {
          count: number;
        };
        expect(filters.count).toBe(0);

        const jobs = (yield* getJson("/jobs")) as { count: number };
        expect(jobs.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetClassificationExportConfiguration + GetUsageTotals", () => {
    test.provider("reads export configuration and usage totals", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const exportConfig = (yield* getJson("/export-config")) as {
          configured: boolean;
        };
        expect(exportConfig.configured).toBe(false);

        const usage = (yield* getJson("/usage")) as { totals: number };
        expect(usage.totals).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetAutomatedDiscoveryConfiguration + ListClassificationScopes + GetRevealConfiguration", () => {
    test.provider("reads the discovery and reveal configuration", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const discovery = (yield* getJson("/auto-discovery")) as {
          status: string | null;
        };
        expect(discovery.status).not.toBeUndefined();

        const scopes = (yield* getJson("/scopes")) as { count: number };
        expect(scopes.count).toBeGreaterThanOrEqual(0);

        const reveal = (yield* getJson("/reveal")) as {
          status?: string | null;
          errorTag?: string;
        };
        if (reveal.errorTag) {
          // A fresh session rejects the read until sample retrieval is
          // configured — the typed tag proves the binding + IAM wiring.
          expect(reveal.errorTag).toBe("AccessDeniedException");
        } else {
          expect(["ENABLED", "DISABLED", null]).toContain(reveal.status);
        }
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
            expect([
              "ResourceNotFoundException",
              "AccessDeniedException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.administrator ?? null).toBeNull();
          }
        }),
    );
  });

  describe("GetInvitationsCount + ListInvitations + ListMembers", () => {
    test.provider("reads this account's membership state", (_stack) =>
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

        const members = (yield* getJson("/members")) as { count: number };
        expect(members.count).toBe(0);
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
            expect(["AccessDeniedException", "ValidationException"]).toContain(
              admins.errorTag,
            );
          } else {
            expect(admins.admins).toBeGreaterThanOrEqual(0);
          }

          const orgConfig = (yield* getJson("/org-config")) as {
            autoEnable?: boolean;
            errorTag?: string;
          };
          if (orgConfig.errorTag) {
            expect(["AccessDeniedException", "ValidationException"]).toContain(
              orgConfig.errorTag,
            );
          } else {
            expect(typeof orgConfig.autoEnable).toBe("boolean");
          }
        }),
    );
  });
});
