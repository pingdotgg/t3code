import { adopt, Unowned } from "@/AdoptPolicy.ts";
import { Auth, AuthProvider, removedAuthSettings } from "@/Neon/Auth.ts";
import {
  AuthOAuthProvider,
  AuthOAuthProviderProvider,
} from "@/Neon/AuthOAuthProvider.ts";
import {
  AuthTrustedDomain,
  AuthTrustedDomainProvider,
} from "@/Neon/AuthTrustedDomain.ts";
import { DataApi, DataApiProvider } from "@/Neon/DataApi.ts";
import * as Layer from "effect/Layer";
import * as Output from "@/Output.ts";
import { Branch } from "@/Neon/Branch.ts";
import { Project } from "@/Neon/Project.ts";
import { runSql, withPgClient } from "@/Neon/Migrations.ts";
import { makePgMigrationExecutor } from "@/SQL/Migrations/index.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource.ts";
import { State } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: providers() });

const context = {
  id: "IdentityGuard",
  fqn: "IdentityGuard",
  instanceId: "identity-guard",
  oldBindings: [],
  newBindings: [],
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};

test.provider(
  "Auth recovery treats incomplete uncreated identities as absent and preserves existing ownership",
  () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Provider;
      const domain = yield* AuthTrustedDomain.Provider;
      const scope = {
        projectId: "recovery-project",
        branchId: "recovery-branch",
      };
      const origin = "https://recovery.example.com";
      const incompleteAuth = { branch: { ...scope } };
      const partialAuth = { branch: { ...scope } };
      const incompleteDomain = { auth: { ...scope }, domain: origin };
      const partialDomain = { auth: { ...scope }, domain: origin };
      const missingOrigin = { auth: { ...scope }, domain: origin };
      // Interrupted state can omit unresolved reference fields.
      yield* Effect.sync(() => {
        Reflect.deleteProperty(incompleteAuth, "branch");
        Reflect.deleteProperty(partialAuth.branch, "branchId");
        Reflect.deleteProperty(incompleteDomain, "auth");
        Reflect.deleteProperty(partialDomain.auth, "projectId");
        Reflect.deleteProperty(missingOrigin, "domain");
      });
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.method);
          expect(request.method).toBe("GET");
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/domains")
                ? {
                    domains: [{ domain: origin, auth_provider: "better_auth" }],
                  }
                : {
                    auth_provider: "better_auth",
                    auth_provider_project_id: "recovery-auth",
                    branch_id: scope.branchId,
                    db_name: "neondb",
                    created_at: "2026-01-01T00:00:00Z",
                    owned_by: "neon",
                    jwks_url: "https://auth.example.com/jwks",
                    base_url: "https://auth.example.com",
                  },
            ),
          );
        }),
      );
      yield* Effect.gen(function* () {
        for (const olds of [
          incompleteAuth,
          partialAuth,
          { branch: { projectId: scope.projectId, branchId: "" } },
          { project: { projectId: "" } },
        ]) {
          expect(
            yield* auth.read!({ ...context, olds, output: undefined }),
          ).toBeUndefined();
        }
        for (const olds of [
          incompleteDomain,
          partialDomain,
          missingOrigin,
          { auth: { projectId: "", branchId: scope.branchId }, domain: origin },
        ]) {
          expect(
            yield* domain.read!({ ...context, olds, output: undefined }),
          ).toBeUndefined();
        }
        expect(requests).toEqual([]);
        const authOutput = yield* auth.read!({
          ...context,
          olds: { branch: scope },
          output: undefined,
        });
        const domainOutput = yield* domain.read!({
          ...context,
          olds: { auth: scope, domain: origin },
          output: undefined,
        });
        expect(Unowned.is(authOutput)).toBe(true);
        expect(Unowned.is(domainOutput)).toBe(true);
        if (!authOutput || !domainOutput)
          return yield* Effect.fail(
            new Error("Expected observed Auth identities"),
          );
        expect(
          Unowned.is(
            yield* auth.read!({
              ...context,
              olds: incompleteAuth,
              output: authOutput,
            }),
          ),
        ).toBe(false);
        expect(
          Unowned.is(
            yield* domain.read!({
              ...context,
              olds: incompleteDomain,
              output: domainOutput,
            }),
          ),
        ).toBe(false);
        expect(
          yield* auth
            .reconcile({
              ...context,
              olds: undefined,
              news: { branch: scope },
              output: undefined,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
            ),
        ).toBe(true);
        expect(
          yield* domain
            .reconcile({
              ...context,
              olds: undefined,
              news: { auth: scope, domain: origin },
              output: undefined,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
            ),
        ).toBe(true);
        expect(requests).toHaveLength(6);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          SDK.Credentials,
          Effect.succeed({
            apiKey: Redacted.make("recovery-test"),
            apiBaseUrl: "https://neon.example.com",
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AuthProvider(), AuthTrustedDomainProvider()),
      ),
    ),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:authtrusteddomain",
      "live",
    ],
  },
);

test.provider(
  "Auth children plan unresolved identities as replacements and reject mismatched cached scope",
  () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Provider;
      const oauth = yield* AuthOAuthProvider.Provider;
      const domain = yield* AuthTrustedDomain.Provider;
      const data = yield* DataApi.Provider;
      const scope = { projectId: "owned-project", branchId: "owned-branch" };
      const changed = { ...scope, branchId: "other-branch" };
      const unresolved = { ...scope, branchId: Output.literal("other-branch") };
      const authOutput = {
        ...scope,
        database: "neondb",
        baseUrl: "https://auth.example.com",
        jwksUrl: "https://auth.example.com/jwks",
        name: undefined,
      };
      const oauthOutput = {
        ...scope,
        provider: "github" as const,
        type: "standard" as const,
        clientId: "client",
      };
      const domainOutput = { ...scope, domain: "https://app.example.com" };
      const dataOutput = {
        ...scope,
        database: "neondb",
        url: "https://data.example.com",
        status: "active",
        settings: undefined,
      };
      expect(
        yield* auth.diff!({
          ...context,
          olds: { branch: scope },
          news: { branch: unresolved },
          output: authOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* oauth.diff!({
          ...context,
          olds: { auth: scope, provider: "github" },
          news: { auth: unresolved, provider: "github" },
          output: oauthOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* domain.diff!({
          ...context,
          olds: { auth: scope, domain: domainOutput.domain },
          news: { auth: unresolved, domain: domainOutput.domain },
          output: domainOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* data.diff!({
          ...context,
          olds: { branch: scope, database: "neondb" },
          news: { branch: unresolved, database: "neondb" },
          output: dataOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* auth.diff!({
          ...context,
          olds: { branch: scope },
          news: { branch: scope, database: Output.literal("neondb") },
          output: authOutput,
        }),
      ).toBeUndefined();
      expect(
        yield* auth
          .reconcile({
            ...context,
            olds: { branch: scope },
            news: { branch: changed },
            output: authOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* oauth
          .reconcile({
            ...context,
            olds: { auth: scope, provider: "github" },
            news: { auth: changed, provider: "github" },
            output: oauthOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* domain
          .reconcile({
            ...context,
            olds: { auth: scope, domain: domainOutput.domain },
            news: { auth: changed, domain: domainOutput.domain },
            output: domainOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* data
          .reconcile({
            ...context,
            olds: { branch: scope, database: "neondb" },
            news: { branch: changed, database: "neondb" },
            output: dataOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidDataApiConfiguration", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
      expect(
        yield* auth
          .reconcile({
            ...context,
            olds: { branch: scope, allowLocalhost: false },
            news: { branch: scope, name: "must-not-apply" },
            output: authOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* oauth
          .reconcile({
            ...context,
            olds: { auth: scope, provider: "github", clientId: "client" },
            news: { auth: scope, provider: "github" },
            output: oauthOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* data
          .reconcile({
            ...context,
            olds: {
              branch: scope,
              database: "neondb",
              settings: { db_max_rows: 10 },
            },
            news: { branch: scope, database: "neondb", settings: {} },
            output: dataOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidDataApiConfiguration", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AuthProvider(),
          AuthOAuthProviderProvider(),
          AuthTrustedDomainProvider(),
          DataApiProvider(),
        ),
      ),
    ),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:authoauthprovider",
      "provider:neon:authtrusteddomain",
      "provider:neon:dataapi",
      "live",
    ],
  },
);

test(
  "managed field removal checks nested settings and permits an explicit email provider switch",
  Effect.sync(() => {
    expect(
      removedAuthSettings(
        { magicLink: { enabled: true, expires_in: 10 } },
        { magicLink: { enabled: false } },
        ["magicLink"],
      ),
    ).toEqual(["magicLink.expires_in"]);
    expect(
      removedAuthSettings(
        { emailProvider: { type: "standard", host: "smtp.example.com" } },
        { emailProvider: { type: "shared" } },
        ["emailProvider"],
      ),
    ).toEqual([]);
  }),
  { tags: ["unit", "provider:neon", "provider:neon:auth", "local"] },
);

test.provider(
  "managed Auth requires adoption and preserves user data after external disable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = Effect.gen(function* () {
        const project = yield* Project("AuthOwnershipProject", {
          region: "aws-us-east-2",
        });
        const branch = yield* Branch("AuthOwnershipBranch", { project });
        return { project, branch };
      });
      const existing = yield* stack.deploy(base);
      const request = {
        project_id: existing.branch.projectId,
        branch_id: existing.branch.branchId,
      };
      yield* SDK.createNeonAuth({ ...request, auth_provider: "better_auth" });
      const application = (takeOwnership: boolean) =>
        Effect.gen(function* () {
          const { branch } = yield* base;
          const auth = yield* Auth("OwnedAuth", {
            branch,
            name: "Owned managed auth",
            allowLocalhost: false,
          }).pipe(adopt(takeOwnership));
          return { auth };
        });
      const refusal = yield* stack
        .deploy(application(false))
        .pipe(Effect.result);
      expect(Result.isFailure(refusal)).toBe(true);
      yield* stack.deploy(application(true));
      expect((yield* SDK.getNeonAuth(request)).name).toBe("Owned managed auth");
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(request)).allow_localhost,
      ).toBe(false);
      yield* SDK.disableNeonAuth(request);
      const refused = yield* stack.deploy(application(false)).pipe(
        Effect.as(undefined),
        Effect.catchTag("Conflict", (error) => Effect.succeed(error.message)),
      );
      expect(refused).toBe(
        "The `neon_auth` schema already exists and cannot be automatically provisioned. Please drop the existing `neon_auth` schema before provisioning Neon Auth.",
      );
      yield* stack.destroy();
      expect(
        yield* SDK.getNeonAuth(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

interface PreviewScope extends Resource<
  "Test.AuthPreviewScope",
  {},
  { projectId: string; branchId: string }
> {}
const PreviewScope = Resource<PreviewScope>("Test.AuthPreviewScope");
const { test: retryTest } = Test.make({
  providers: Layer.mergeAll(
    AuthProvider(),
    Provider.succeed(PreviewScope, {
      reconcile: () =>
        Effect.succeed({ projectId: "retry-project", branchId: "retry-child" }),
      delete: () => Effect.void,
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(
        SDK.Credentials,
        Effect.succeed({
          apiKey: Redacted.make("ownership-retry-test"),
          apiBaseUrl: "https://neon.example.com",
        }),
      ),
    ),
  ),
});

retryTest.provider(
  "actual Auth refusal retries scoped adoption with complete branch identity",
  (stack) => {
    const requests: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.method);
        expect(request.url).toContain(
          "/projects/retry-project/branches/retry-child/auth",
        );
        expect(["GET", "DELETE"]).toContain(request.method);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.method === "DELETE"
              ? {}
              : {
                  auth_provider: "better_auth",
                  auth_provider_project_id: "inherited-auth",
                  branch_id: "retry-child",
                  db_name: "neondb",
                  created_at: "2026-01-01T00:00:00Z",
                  owned_by: "neon",
                  jwks_url: "https://child.example.com/jwks",
                  base_url: "https://child.example.com",
                },
          ),
        );
      }),
    );
    const app = (enabled: boolean) =>
      Effect.gen(function* () {
        const branch = yield* PreviewScope("Branch", {});
        return yield* Auth("Auth", { branch }).pipe(adopt(enabled));
      });
    return Effect.gen(function* () {
      yield* stack.destroy();
      const refusal = yield* stack.deploy(app(false)).pipe(
        Effect.as(false),
        Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
      );
      expect(refusal).toBe(true);
      expect(requests.every((method) => method === "GET")).toBe(true);
      const state = yield* yield* State;
      const refused = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: "Auth",
      });
      if (!refused || refused.kind === "action")
        return yield* Effect.fail(
          new Error("Expected an Auth resource checkpoint"),
        );
      expect(refused.attr).toBeUndefined();
      expect(
        yield* stack.deploy(app(false)).pipe(
          Effect.as(false),
          Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      const adopted = yield* stack.deploy(app(true));
      expect(adopted.branchId).toBe("retry-child");
      expect(adopted.baseUrl).toBe("https://child.example.com");
      expect(refused?.props).toEqual({
        branch: { projectId: "retry-project", branchId: "retry-child" },
      });
      expect(requests.every((method) => method === "GET")).toBe(true);
      yield* stack.destroy();
      expect(requests.filter((method) => method === "DELETE")).toHaveLength(1);
    }).pipe(
      Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  },
  {
    tags: ["unit", "provider:neon", "provider:neon:auth", "local"],
    timeout: 10_000,
  },
);

const { test: previewTest } = Test.make({
  providers: providers(),
  stage: "test-neon-auth-deferred-adoption",
});

previewTest.provider(
  "new child Auth explicitly adopts inherited integration and preserves parent identities and data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const parent = Effect.gen(function* () {
        const project = yield* Project("DeferredAuthProject", {
          region: "aws-us-east-2",
        });
        const auth = yield* Auth("ParentAuth", {
          project,
          name: "Deferred adoption parent",
          allowLocalhost: true,
          emailAndPassword: {
            enabled: true,
            require_email_verification: false,
            send_verification_email_on_sign_up: false,
          },
        });
        return { project, auth };
      });
      const first = yield* stack.deploy(parent);
      const parentRequest = {
        project_id: first.auth.projectId,
        branch_id: first.auth.branchId,
      };
      const parentUri = Redacted.make(first.project.connectionUri);
      const query = (uri: Redacted.Redacted<string>, sql: string) =>
        withPgClient(uri, (client) =>
          makePgMigrationExecutor(client).query(sql),
        );
      yield* runSql(
        parentUri,
        "CREATE TABLE auth_preview_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO auth_preview_probe VALUES (1, 'parent');",
      );
      const http = yield* HttpClient.HttpClient;
      const baseUrl = first.auth.baseUrl.replace(/\/$/, "");
      const authPath = baseUrl.endsWith("/auth") ? baseUrl : `${baseUrl}/auth`;
      const signup = yield* http.execute(
        HttpClientRequest.post(`${authPath}/sign-up/email`).pipe(
          HttpClientRequest.setHeader("origin", "http://localhost:4318"),
          HttpClientRequest.bodyJsonUnsafe({
            email: "parent-auth-preview@example.com",
            password: "Alchemy-Auth-Preview-Test-Only-73!",
            name: "Parent preview user",
          }),
        ),
      );
      expect(signup.status).toBe(200);
      const usersSql = 'SELECT id, email FROM neon_auth."user" ORDER BY id';
      const parentUsers = yield* query(parentUri, usersSql);
      expect(parentUsers.length).toBe(1);
      const parentAuth = yield* SDK.getNeonAuth(parentRequest);
      const parentSettings =
        yield* SDK.getNeonAuthEmailAndPasswordConfig(parentRequest);
      const parentLocalhost =
        yield* SDK.getNeonAuthAllowLocalhost(parentRequest);
      const verifyParent = Effect.gen(function* () {
        const survivingAuth = yield* SDK.getNeonAuth(parentRequest);
        expect(survivingAuth.base_url).toBe(parentAuth.base_url);
        expect(survivingAuth.name).toBe(parentAuth.name);
        expect(
          yield* SDK.getNeonAuthEmailAndPasswordConfig(parentRequest),
        ).toEqual(parentSettings);
        expect(yield* SDK.getNeonAuthAllowLocalhost(parentRequest)).toEqual(
          parentLocalhost,
        );
        expect(yield* query(parentUri, usersSql)).toEqual(parentUsers);
        expect(
          yield* query(parentUri, "SELECT * FROM auth_preview_probe"),
        ).toEqual([{ id: 1, value: "parent" }]);
      });
      const preview = Effect.gen(function* () {
        const resources = yield* parent;
        const branch = yield* Branch("AuthPreview", {
          project: resources.project,
          parentBranch: { branchId: resources.auth.branchId },
          initSource: "parent-data",
        });
        const auth = yield* Auth("PreviewAuth", {
          branch,
          name: "Deferred adoption child",
          allowLocalhost: false,
        }).pipe(adopt());
        return { branch, auth };
      });
      const child = yield* stack.deploy(preview);
      expect(child.branch.parentBranchId).toBe(first.auth.branchId);
      expect(child.auth.branchId).toBe(child.branch.branchId);
      expect(child.auth.branchId).not.toBe(first.auth.branchId);
      expect(child.auth.baseUrl).not.toBe(first.auth.baseUrl);
      const childRequest = {
        project_id: child.auth.projectId,
        branch_id: child.auth.branchId,
      };
      expect((yield* SDK.getNeonAuth(childRequest)).name).toBe(
        "Deferred adoption child",
      );
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(childRequest)).allow_localhost,
      ).toBe(false);
      const childUri = Redacted.make(child.branch.connectionUri);
      expect(yield* query(childUri, usersSql)).toEqual(parentUsers);
      expect(
        yield* query(childUri, "SELECT * FROM auth_preview_probe"),
      ).toEqual([{ id: 1, value: "parent" }]);
      yield* runSql(
        childUri,
        "UPDATE auth_preview_probe SET value = 'child' WHERE id = 1",
      );
      expect(
        yield* query(childUri, "SELECT * FROM auth_preview_probe"),
      ).toEqual([{ id: 1, value: "child" }]);
      yield* verifyParent;
      const unchanged = yield* stack.deploy(preview);
      expect(unchanged.auth.baseUrl).toBe(child.auth.baseUrl);
      yield* stack.deploy(parent);
      expect(
        yield* SDK.getNeonAuth(childRequest).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        yield* SDK.getProjectBranch(childRequest).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* verifyParent;
      yield* stack.destroy();
      expect(
        yield* SDK.getNeonAuth(parentRequest).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        yield* SDK.getProject({ project_id: first.project.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Auth scope replacement retains both branches and leaves the old branch disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (second: boolean) =>
        Effect.gen(function* () {
          const project = yield* Project("AuthReplacementProject", {
            region: "aws-us-east-2",
          });
          const a = yield* Branch("AuthBranchA", { project });
          const b = second
            ? yield* Branch("AuthBranchB", { project })
            : undefined;
          const auth = yield* Auth("ReplacingAuth", { branch: b ?? a });
          const domain = yield* AuthTrustedDomain("ScopeOrigin", {
            auth,
            domain: "https://scope.example.com",
          });
          return { a, b, auth, domain };
        });
      const first = yield* stack.deploy(application(false));
      const replaced = yield* stack.deploy(application(true));
      expect(replaced.auth.branchId).toBe(replaced.b!.branchId);
      expect(replaced.domain.branchId).toBe(replaced.b!.branchId);
      expect(replaced.a.branchId).toBe(first.a.branchId);
      expect(
        yield* SDK.getNeonAuth({
          project_id: first.auth.projectId,
          branch_id: first.auth.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:authtrusteddomain",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
