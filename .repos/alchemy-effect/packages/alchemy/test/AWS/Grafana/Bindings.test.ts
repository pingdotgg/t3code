import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GrafanaTestFunctionLive, { GrafanaTestFunction } from "./handler";
import GrafanaWorkspaceTestFunctionLive, {
  GrafanaWorkspaceTestFunction,
} from "./workspace-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GrafanaBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The fixture occasionally answers a transient 5xx under load (cold re-init,
// IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx surfaces
// immediately.
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

const getJson = (baseUrl: string, path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (baseUrl: string, path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const awaitReady = (baseUrl: string) =>
  HttpClient.get(`${baseUrl}/bindings`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`Function not ready: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessPolicy }),
  );

let baseUrl: string;

describe.sequential("Grafana Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Grafana test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Grafana test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GrafanaTestFunction;
        }).pipe(Effect.provide(GrafanaTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      yield* awaitReady(baseUrl);
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
    test.provider("the account-level capability initializes", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(baseUrl, "/bindings")) as {
          bound: string[];
        };
        expect(response.bound).toEqual(["listVersions"]);
      }),
    );
  });

  describe("ListVersions", () => {
    test.provider(
      "lists the Grafana versions available for new workspaces",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(baseUrl, "/versions")) as {
            versions: string[];
          };
          expect(response.versions.length).toBeGreaterThan(0);
          for (const version of response.versions) {
            expect(version).toMatch(/^\d+(\.\d+)*$/);
          }
        }),
    );
  });

  // GATED: creating the workspace the workspace-scoped bindings attach to is
  // asynchronous (several minutes to reach ACTIVE). Run with
  // AWS_TEST_GRAFANA=1 — same gate as the Workspace lifecycle test.
  describe("workspace-scoped bindings (gated)", () => {
    test.provider.skipIf(!process.env.AWS_TEST_GRAFANA)(
      "auth/config reads, permissions, and the service-account + token round-trip",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const attrs = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* GrafanaWorkspaceTestFunction;
            }).pipe(Effect.provide(GrafanaWorkspaceTestFunctionLive)),
          );
          const url = attrs.functionUrl!.replace(/\/+$/, "");
          yield* awaitReady(url);

          const bindings = (yield* getJson(url, "/bindings")) as {
            bound: string[];
          };
          expect(bindings.bound).toHaveLength(15);
          expect(bindings.bound).toContain("createToken");
          expect(bindings.bound).toContain("associateLicense");

          const auth = (yield* getJson(url, "/auth")) as {
            providers: string[];
            samlStatus?: string;
          };
          expect(auth.providers).toContain("SAML");

          const config = (yield* getJson(url, "/config")) as {
            hasConfiguration: boolean;
            grafanaVersion?: string;
          };
          expect(config.hasConfiguration).toBe(true);

          const permissions = (yield* getJson(url, "/permissions")) as {
            count?: number;
            errorTag?: string;
          };
          if (permissions.errorTag) {
            // SSO-permission listing on a SAML-only workspace may be
            // rejected with a typed error — still proves binding + IAM.
            expect(["ValidationException", "AccessDeniedException"]).toContain(
              permissions.errorTag,
            );
          } else {
            expect(permissions.count).toBeGreaterThanOrEqual(0);
          }

          const accounts = (yield* getJson(url, "/service-accounts")) as {
            count: number;
          };
          expect(accounts.count).toBe(0);

          const roundtrip = (yield* postJson(
            url,
            "/service-account-roundtrip",
          )) as {
            serviceAccountId: string;
            grafanaRole: string;
            keyPrefix: string;
            keyLength: number;
            tokenCount: number;
          };
          expect(roundtrip.grafanaRole).toBe("EDITOR");
          // Grafana service-account tokens are `glsa_...` secrets; the
          // binding returns the key Redacted and the fixture unwraps it.
          expect(roundtrip.keyPrefix).toBe("glsa_");
          expect(roundtrip.keyLength).toBeGreaterThan(10);
          expect(roundtrip.tokenCount).toBe(1);

          yield* stack.destroy();
        }),
      { timeout: 900_000 },
    );
  });
});
