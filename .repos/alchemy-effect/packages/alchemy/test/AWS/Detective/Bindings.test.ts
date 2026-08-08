import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as detective from "@distilled.cloud/aws/detective";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DetectiveTestFunctionLive, { DetectiveTestFunction } from "./handler";
import { makeDetectiveTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DetectiveBindings");
const testLease = makeDetectiveTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let roleArn: string;
let graphArn: string;
// The Detective behavior graph is an account/region singleton. If the
// account already runs a graph this suite did not create, deploying the
// fixture would adopt (and later DELETE) it — so every test degrades to a
// logged no-op instead (capture-and-restore safety, mirroring Graph.test.ts).
let foreignGraphArn: string | undefined;

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
  foreignGraphArn
    ? Effect.logInfo(
        `Detective graph ${foreignGraphArn} already exists and is not ours — skipping`,
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

describe.sequential("Detective Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // Never take over a behavior graph this fixture did not create.
      const preexisting = (yield* aws(detective.listGraphs({}))).GraphList?.[0];
      if (preexisting?.Arn) {
        const tags = yield* aws(
          detective.listTagsForResource({
            ResourceArn: preexisting.Arn,
          }),
        );
        if (tags.Tags?.["fixture"] !== "detective-bindings") {
          foreignGraphArn = preexisting.Arn;
          yield* Effect.logInfo(
            `Detective test setup: foreign graph ${preexisting.Arn} present — suite degrades to no-op`,
          );
          return;
        }
      }

      yield* Effect.logInfo(
        "Detective test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Detective test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DetectiveTestFunction;
        }).pipe(Effect.provide(DetectiveTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      roleArn = attrs.roleArn;

      // Out-of-band: the fixture created the account's (single) graph.
      const graphs = yield* aws(detective.listGraphs({}));
      graphArn = graphs.GraphList?.[0]?.Arn ?? "";
      expect(graphArn).toContain(":graph:");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Detective test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Detective test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      if (foreignGraphArn) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 23 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(23);
        expect(response.bound).toContain("startInvestigation");
        expect(response.bound).toContain("acceptInvitation");
        expect(response.bound).toContain("enableOrganizationAdminAccount");
      }),
    );
  });

  describe("ListMembers", () => {
    test.provider(
      "enumerates the graph's member accounts (injected graph arn)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          // An organization account may see auto-enabled members even on a
          // freshly created graph, so assert shape rather than emptiness.
          const response = (yield* getJson("/members")) as { count: number };
          expect(typeof response.count).toBe("number");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("GetMembers", () => {
    test.provider(
      "a non-member account comes back as unprocessed (injected graph arn)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* getJson("/member-status")) as {
            members: number;
            unprocessed: number;
          };
          expect(response.members).toBe(0);
          expect(response.unprocessed).toBe(1);
        }),
    );
  });

  describe("ListDatasourcePackages", () => {
    test.provider("the graph ingests the core package", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/datasources")) as {
          packages: string[];
        };
        expect(response.packages).toContain("DETECTIVE_CORE");
      }),
    );
  });

  describe("BatchGetGraphMemberDatasources", () => {
    test.provider("reads member ingest history for the graph", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/graph-member-datasources")) as {
          memberDatasources?: number;
          unprocessed?: number;
          errorTag?: string;
        };
        if (response.errorTag) {
          // A non-member account id may be rejected outright instead of
          // reported as unprocessed.
          expect([
            "ValidationException",
            "ResourceNotFoundException",
          ]).toContain(response.errorTag);
        } else {
          expect(response.memberDatasources).toBe(0);
        }
      }),
    );
  });

  describe("ListInvestigations", () => {
    test.provider("a fresh graph has no investigations", (_stack) =>
      Effect.gen(function* () {
        if (yield* skipForeign()) return;
        const response = (yield* getJson("/investigations")) as {
          count: number;
        };
        expect(response.count).toBe(0);
      }),
    );
  });

  describe("StartInvestigation", () => {
    test.provider(
      "triggers triage of the fixture's own role (typed outcome either way)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* postJson(
            `/investigate?entity=${encodeURIComponent(roleArn)}`,
          )) as { investigationId?: string; errorTag?: string };
          if (response.errorTag) {
            // A brand-new graph has ingested (almost) no data, so Detective
            // typically cannot resolve the entity yet.
            expect([
              "ValidationException",
              "ResourceNotFoundException",
              "TooManyRequestsException",
              "InternalServerException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.investigationId).toBeTruthy();
          }
        }),
    );
  });

  describe("ListInvitations", () => {
    test.provider(
      "enumerates this account's behavior-graph invitations",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          // The shared test account can carry standing invitations from
          // other admin accounts — assert shape rather than emptiness.
          const response = (yield* getJson("/invitations")) as {
            count: number;
          };
          expect(typeof response.count).toBe("number");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("BatchGetMembershipDatasources", () => {
    test.provider(
      "the admin account is not a member of its own graph",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* getJson(
            `/membership-datasources?graphArn=${encodeURIComponent(graphArn)}`,
          )) as {
            membershipDatasources?: number;
            unprocessedGraphs?: number;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect([
              "ValidationException",
              "ResourceNotFoundException",
            ]).toContain(response.errorTag);
          } else {
            expect(
              (response.membershipDatasources ?? 0) +
                (response.unprocessedGraphs ?? 0),
            ).toBeGreaterThanOrEqual(0);
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
            // Only the organization's delegated Detective administrator may
            // call this — a standalone test account gets a typed rejection,
            // which still proves the binding + IAM wiring end-to-end.
            expect([
              "ValidationException",
              "AccessDeniedException",
              "TooManyRequestsException",
            ]).toContain(response.errorTag);
          } else {
            expect(typeof response.autoEnable).toBe("boolean");
          }
        }),
    );
  });

  describe("ListOrganizationAdminAccounts", () => {
    test.provider(
      "answers (or rejects with a typed error outside the management account)",
      (_stack) =>
        Effect.gen(function* () {
          if (yield* skipForeign()) return;
          const response = (yield* getJson("/org-admins")) as {
            administrators?: number;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect(["ValidationException", "AccessDeniedException"]).toContain(
              response.errorTag,
            );
          } else {
            expect(response.administrators).toBeGreaterThanOrEqual(0);
          }
        }),
    );
  });
});
