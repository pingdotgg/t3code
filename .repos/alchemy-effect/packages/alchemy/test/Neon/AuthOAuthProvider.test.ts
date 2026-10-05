import { Auth } from "@/Neon/Auth.ts";
import { AuthOAuthProvider } from "@/Neon/AuthOAuthProvider.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: providers() });

test.provider(
  "OAuth configuration owns one provider and never publishes its secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (clientId: string | undefined) =>
        Effect.gen(function* () {
          const project = yield* Project("OAuthProject", {
            region: "aws-us-east-2",
          });
          const auth = yield* Auth("OAuthAuth", { project });
          const provider = yield* AuthOAuthProvider("GitHub", {
            auth,
            provider: "github",
            clientId,
            clientSecret: Redacted.make(
              "alchemy-configuration-only-not-a-real-oauth-secret",
            ),
          });
          return { auth, provider };
        });
      const first = yield* stack.deploy(
        application("alchemy-configuration-only"),
      );
      const request = {
        project_id: first.auth.projectId,
        branch_id: first.auth.branchId,
      };
      expect(
        (yield* SDK.listBranchNeonAuthOauthProviders(request)).providers.find(
          (item) => item.id === "github",
        )?.client_id,
      ).toBe("alchemy-configuration-only");
      expect(Object.keys(first.provider)).not.toContain("clientSecret");
      const updated = yield* stack.deploy(
        application("alchemy-configuration-updated"),
      );
      expect(updated.provider.provider).toBe("github");
      expect(
        (yield* SDK.listBranchNeonAuthOauthProviders(request)).providers.find(
          (item) => item.id === "github",
        )?.client_id,
      ).toBe("alchemy-configuration-updated");
      const refused = yield* stack.deploy(application(undefined)).pipe(
        Effect.as(false),
        Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
      );
      expect(refused).toBe(true);
      expect(
        (yield* SDK.listBranchNeonAuthOauthProviders(request)).providers.find(
          (item) => item.id === "github",
        )?.client_id,
      ).toBe("alchemy-configuration-updated");
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
      "provider:neon:authoauthprovider",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
