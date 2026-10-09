import { Auth } from "@/Neon/Auth.ts";
import { AuthTrustedDomain } from "@/Neon/AuthTrustedDomain.ts";
import { Branch } from "@/Neon/Branch.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: providers() });

const application = (allowLocalhost: boolean, domain: string) =>
  Effect.gen(function* () {
    const project = yield* Project("ManagedAuthProject", {
      region: "aws-us-east-2",
    });
    const branch = yield* Branch("ManagedAuthBranch", { project });
    const auth = yield* Auth("ManagedAuth", {
      branch,
      name: "Alchemy managed auth",
      allowLocalhost,
      emailAndPassword: {
        enabled: true,
        require_email_verification: false,
        send_verification_email_on_sign_up: false,
      },
    });
    const origin = yield* AuthTrustedDomain("TrustedOrigin", { auth, domain });
    return { project, branch, auth, origin };
  });

test.provider(
  "managed Auth observes settings, replaces only the trusted origin, and destroys idempotently",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(
        application(false, "https://auth.example.com"),
      );
      const request = {
        project_id: first.auth.projectId,
        branch_id: first.auth.branchId,
      };
      const current = yield* SDK.getNeonAuth(request);
      expect(current.auth_provider).toBe("better_auth");
      expect(current.base_url).toBe(first.auth.baseUrl);
      expect(first.auth.jwksUrl).toMatch(/^https:\/\//);
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(request)).allow_localhost,
      ).toBe(false);

      const unchanged = yield* stack.deploy(
        application(false, "https://auth.example.com"),
      );
      expect(unchanged.auth.baseUrl).toBe(first.auth.baseUrl);
      yield* SDK.updateNeonAuthAllowLocalhost({
        ...request,
        allow_localhost: true,
      });
      const updated = yield* stack.deploy(
        application(false, "https://next.example.com"),
      );
      expect(updated.auth.baseUrl).toBe(first.auth.baseUrl);
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(request)).allow_localhost,
      ).toBe(false);
      const domains = yield* SDK.listBranchNeonAuthTrustedDomains(request);
      expect(
        domains.domains.some(
          (entry) => entry.domain === "https://next.example.com",
        ),
      ).toBe(true);
      expect(
        domains.domains.some(
          (entry) => entry.domain === "https://auth.example.com",
        ),
      ).toBe(false);

      yield* stack.destroy();
      const gone = yield* SDK.getNeonAuth(request).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
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

test.provider(
  "Auth preserves equivalent database identity, supports shared email, and rejects removals before mutation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (database?: string, remove = false) =>
        Effect.gen(function* () {
          const project = yield* Project("AuthEquivalentProject", {
            region: "aws-us-east-2",
          });
          const auth = yield* Auth("AuthEquivalent", {
            project,
            database,
            name: remove ? "must-not-be-applied" : "Equivalent Auth",
            allowLocalhost: remove ? undefined : false,
            emailProvider: { type: "shared" },
            magicLink: { enabled: false },
          });
          return { auth };
        });
      const first = yield* stack.deploy(program());
      const request = {
        project_id: first.auth.projectId,
        branch_id: first.auth.branchId,
      };
      const explicit = yield* stack.deploy(program(first.auth.database));
      expect(explicit.auth.baseUrl).toBe(first.auth.baseUrl);
      const implicit = yield* stack.deploy(program());
      expect(implicit.auth.baseUrl).toBe(first.auth.baseUrl);
      expect(implicit.auth.database).toBe(first.auth.database);
      expect((yield* SDK.getNeonAuthEmailProvider(request)).type).toBe(
        "shared",
      );
      const refused = yield* stack.deploy(program(undefined, true)).pipe(
        Effect.as(false),
        Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
      );
      expect(refused).toBe(true);
      expect((yield* SDK.getNeonAuth(request)).name).toBe("Equivalent Auth");
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(request)).allow_localhost,
      ).toBe(false);
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
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "managed Auth signup, signin, signout and trusted-origin rejection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { auth, project } = yield* stack.deploy(
        application(false, "https://auth.example.com"),
      );
      const http = yield* HttpClient.HttpClient;
      const baseUrl = auth.baseUrl.replace(/\/$/, "");
      const authPath = baseUrl.endsWith("/auth") ? baseUrl : `${baseUrl}/auth`;
      const email = `alchemy-${project.projectId}@example.com`;
      const credentials = {
        email,
        password: "Alchemy-Managed-Auth-Test-Only-73!",
        name: "Alchemy Test",
      };
      const post = (
        path: string,
        body: object,
        origin = "https://auth.example.com",
        cookie?: string,
      ) =>
        http.execute(
          HttpClientRequest.post(`${authPath}/${path}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            HttpClientRequest.setHeaders({
              origin,
              ...(cookie ? { cookie } : {}),
            }),
          ),
        );
      const denied = yield* post(
        "sign-up/email",
        credentials,
        "https://untrusted.example.com",
      );
      expect(denied.status).toBe(403);
      const signup = yield* post("sign-up/email", credentials);
      expect(signup.status).toBe(200);
      const signin = yield* post("sign-in/email", credentials);
      expect(signin.status).toBe(200);
      const cookies = signin.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookie = cookies?.split(";")[0];
      const token = yield* http.get(`${authPath}/token`, {
        headers: { cookie: cookie ?? "" },
      });
      expect(token.status).toBe(200);
      const jwt = yield* token.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String })),
        ),
      );
      const payloadJson = yield* Effect.sync(() =>
        Buffer.from(jwt.token.split(".")[1], "base64url").toString("utf8"),
      );
      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            iss: Schema.String,
            sub: Schema.String,
            exp: Schema.Number,
          }),
        ),
      )(payloadJson);
      expect(payload.iss).toBe(new URL(auth.baseUrl).origin);
      expect(payload.sub.length).toBeGreaterThan(0);
      expect(payload.exp).toBeGreaterThan(
        yield* Effect.sync(() => Date.now() / 1000),
      );
      expect((yield* http.get(auth.jwksUrl)).status).toBe(200);
      const signout = yield* post(
        "sign-out",
        {},
        "https://auth.example.com",
        cookie,
      );
      expect(signout.status).toBe(200);
      const revoked = yield* http.get(`${authPath}/token`, {
        headers: { cookie: cookie ?? "" },
      });
      expect(revoked.status).toBe(401);
      const wrong = yield* post("sign-in/email", {
        email,
        password: "wrong-password",
      });
      expect(wrong.status).toBe(401);
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
