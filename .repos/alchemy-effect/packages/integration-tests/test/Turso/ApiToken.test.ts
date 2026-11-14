import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Turso.providers() });

const listed = (name: string) =>
  turso
    .listAPITokens({})
    .pipe(Effect.map(({ tokens }) => (tokens ?? []).find((t) => t.name === name)));

test.provider(
  "group-scoped API token is minted, usable, and revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;

      const { group, token } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const token = yield* Turso.ApiToken("Token", {
            group: group.name,
            scopes: ["read", "db:create", "db:delete"],
          });
          return { group, token };
        }),
      );
      expect(token.organization).toBe(org);
      expect(token.group).toBe(group.name);
      expect(token.scopes).toEqual(expect.arrayContaining(["read", "db:create", "db:delete"]));
      expect((yield* listed(token.name))?.id).toBe(token.id);

      // The token can list the group's databases with its own credentials.
      const { databases } = yield* turso
        .listDatabases({ organizationSlug: org, group: group.name })
        .pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({ apiKey: token.token, apiBaseUrl: DEFAULT_API_BASE_URL }),
          ),
        );
      expect(databases).toEqual([]);

      // Changing the scopes replaces (re-mints) the token.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.ApiToken("Token", { group: group.name, scopes: ["read"] });
        }),
      );
      expect(replaced.id).not.toBe(token.id);
      expect(replaced.scopes).toEqual(["read"]);

      yield* stack.destroy();
      expect(yield* listed(token.name)).toBeUndefined();
      expect(yield* listed(replaced.name)).toBeUndefined();
    }),
  { tags: ["provider:turso", "provider:turso:apitoken", "live"], timeout: 120_000 },
);

test.provider(
  "changing the scopes of a token with a pinned name revokes the old one first",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stage = yield* Stage;
      const name = `alchemy-${stage}-pinned-token`;

      const app = (scopes: Turso.ApiTokenScope[]) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.ApiToken("Token", { name, group: group.name, scopes });
        });

      const first = yield* stack.deploy(app(["read"]));
      const second = yield* stack.deploy(app(["read", "db:create"]));
      expect(second.name).toBe(name);
      expect(second.id).not.toBe(first.id);
      expect((yield* listed(name))?.id).toBe(second.id);

      yield* stack.destroy();
      expect(yield* listed(name)).toBeUndefined();
    }),
  { tags: ["provider:turso", "provider:turso:apitoken", "live"], timeout: 120_000 },
);
