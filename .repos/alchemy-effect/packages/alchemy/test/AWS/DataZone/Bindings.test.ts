import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as datazone from "@distilled.cloud/aws/datazone";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DataZoneTestFunctionLive, {
  BINDINGS_DOMAIN_NAME,
  BINDINGS_PROJECT_NAME,
  DataZoneTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataZoneBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) plus DataZone
// user-profile propagation can take well over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;
let functionRoleArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry only 5xx (cold re-init, IAM/user-profile propagation the handler's
// `Effect.orDie` surfaces as a 500); a genuine 4xx surfaces immediately.
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
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(8)]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

/** Resolve the fixture domain's id by its deterministic name. */
const findDomainId = Effect.gen(function* () {
  const pages = yield* datazone.listDomains.pages({}).pipe(Stream.runCollect);
  const summary = Array.from(pages)
    .flatMap((page) => page.items ?? [])
    .find(
      (s) =>
        (Redacted.isRedacted(s.name) ? Redacted.value(s.name) : s.name) ===
          BINDINGS_DOMAIN_NAME &&
        s.status !== "DELETING" &&
        s.status !== "DELETED",
    );
  return summary?.id;
});

describe.sequential("DataZone Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DataZone test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DataZone test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DataZoneTestFunction;
        }).pipe(Effect.provide(DataZoneTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;
      functionRoleArn = attrs.roleArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `DataZone test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DataZone test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 600_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  describe("user profile setup", () => {
    // DataZone authorizes data-plane calls against a *user profile*, not
    // just IAM — create one for the function's execution role before any
    // route test calls the API through the bindings. Runs as the first
    // sequential test (distilled calls need the provider credentials that
    // `test.provider` supplies).
    test.provider("creates a user profile for the function role", () =>
      Effect.gen(function* () {
        const domainId = yield* findDomainId;
        expect(domainId).toBeTruthy();
        const profile = yield* datazone
          .createUserProfile({
            domainIdentifier: domainId!,
            userIdentifier: functionRoleArn,
            userType: "IAM_ROLE",
          })
          .pipe(
            // already exists from a previous run — resolve it instead.
            Effect.catchTag("ValidationException", () =>
              datazone.getUserProfile({
                domainIdentifier: domainId!,
                userIdentifier: functionRoleArn,
                type: "IAM",
              }),
            ),
          );
        expect(profile.id).toBeTruthy();

        // Inventory search is project-scoped: the function's user profile
        // must be a member of the fixture project.
        const projects = yield* datazone.listProjects({
          domainIdentifier: domainId!,
        });
        const project = (projects.items ?? []).find(
          (p) =>
            (Redacted.isRedacted(p.name) ? Redacted.value(p.name) : p.name) ===
            BINDINGS_PROJECT_NAME,
        );
        expect(project).toBeTruthy();
        yield* datazone
          .createProjectMembership({
            domainIdentifier: domainId!,
            projectIdentifier: project!.id,
            member: { userIdentifier: profile.id! },
            designation: "PROJECT_CONTRIBUTOR",
          })
          .pipe(
            // already a member from a previous run
            Effect.catchTag("ValidationException", () => Effect.void),
          );
      }),
    );
  });

  describe("binding registration", () => {
    test.provider("all 30 domain capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(30);
        expect(response.bound).toContain("search");
        expect(response.bound).toContain("acceptSubscriptionRequest");
        expect(response.bound).toContain("postLineageEvent");
      }),
    );
  });

  describe("Search", () => {
    test.provider(
      "searches the domain inventory (injected domain id)",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/search")) as {
            ok: boolean;
            totalMatchCount: number;
            items: number;
            error?: string;
          };
          // fresh domain — no assets, but the call must succeed end-to-end.
          expect(response).toMatchObject({ ok: true, items: 0 });
        }),
      { timeout: 240_000 },
    );
  });

  describe("SearchListings", () => {
    test.provider("searches the published catalog", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/listings")) as {
          ok: boolean;
          items: number;
        };
        expect(response).toMatchObject({ ok: true, items: 0 });
      }),
    );
  });

  describe("ListSubscriptions", () => {
    test.provider(
      "lists approved subscriptions (empty in a fresh domain)",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/subscriptions")) as {
            ok: boolean;
            items: number;
          };
          expect(response).toMatchObject({ ok: true, items: 0 });
        }),
    );
  });

  describe("ListSubscriptionRequests", () => {
    test.provider("lists pending requests (empty in a fresh domain)", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/requests")) as {
          ok: boolean;
          items: number;
        };
        expect(response).toMatchObject({ ok: true, items: 0 });
      }),
    );
  });

  describe("GetIamPortalLoginUrl", () => {
    test.provider("mints a data portal sign-in URL", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/portal")) as {
          ok: boolean;
          authCodeUrl?: string;
          userProfileId?: string;
        };
        expect(response.ok).toBe(true);
        expect(response.authCodeUrl).toBeTruthy();
      }),
    );
  });

  describe("consumeDataZoneEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeDataZoneEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
