import * as turso from "@distilled.cloud/turso/turso";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { organization } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export class ApiTokenUnexpectedResponse extends Data.TaggedError("ApiTokenUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A permission granted to a group-scoped API token. `read-only` and
 * `full-access` are presets that expand to individual scopes.
 */
export type ApiTokenScope =
  | "read"
  | "db:create"
  | "db:delete"
  | "db:configure"
  | "db:mint-token"
  | "db:rotate-creds"
  | "group:configure"
  | "group:mint-token"
  | "group:rotate-creds"
  | "read-only"
  | "full-access";

export interface ApiTokenProps {
  /**
   * Token name, unique within your account. If omitted, a unique name is
   * generated from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Restrict the token to one group of the organization (e.g.
   * `group.name`). Requires `scopes`. Omit for an organization-scoped token.
   */
  group?: string;
  /**
   * Permissions of a group-scoped token. Required (and non-empty) when
   * `group` is set. `db:mint-token` issues new SQL tokens;
   * `db:rotate-creds` invalidates every SQL token of a database.
   */
  scopes?: ApiTokenScope[];
}

export interface ApiTokenAttributes {
  /** Token ID. */
  id: string;
  /** Token name. */
  name: string;
  /** The organization slug the token is restricted to. */
  organization: string;
  /** The group the token is restricted to, if group-scoped. */
  group: string | undefined;
  /** The expanded scopes of a group-scoped token. */
  scopes: string[];
  /** The Platform API token, sent as `Authorization: Bearer <token>`. */
  token: Redacted.Redacted<string>;
}

export type ApiToken = Resource<
  "Turso.ApiToken",
  ApiTokenProps,
  ApiTokenAttributes,
  never,
  Providers
>;

/**
 * A Turso API token. It lets an app create and delete groups and databases.
 * To run SQL, use a {@link DatabaseToken} instead. Limit it to one group
 * with `group` and `scopes` to give an app only the access it needs.
 *
 * Turso only shows the token once, when it's created, so Alchemy stores it
 * in state as a `Redacted` value. Changing a prop creates a new token, and
 * destroying it cancels the token.
 * @see https://docs.turso.tech/api-reference/tokens/create
 *
 * ### Creating a Token
 * **Example:** Token for the whole organization
 * ```typescript
 * const token = yield* Turso.ApiToken("Ci", {});
 * ```
 *
 * **Example:** Token that can only create databases in one group
 * ```typescript
 * const token = yield* Turso.ApiToken("Tenants", {
 *   group: group.name,
 *   scopes: ["read", "db:create", "db:delete", "db:mint-token"],
 * });
 * ```
 *
 * @resource
 * @product API Token
 */
export const ApiToken = Resource<ApiToken>("Turso.ApiToken");

const tokenName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

export const ApiTokenProvider = () =>
  Provider.effect(
    ApiToken,
    Effect.gen(function* () {
      const observe = (name: string) =>
        turso
          .listAPITokens({})
          .pipe(Effect.map(({ tokens }) => (tokens ?? []).find((t) => t.name === name)));

      const revoke = (name: string) =>
        turso.revokeAPIToken({ tokenName: name }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );

      return {
        stables: ["id", "name", "organization", "group", "scopes", "token"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* tokenName(id, olds?.name));
          // Turso tokens are immutable: any change mints a new one.
          if (
            (news.name !== undefined && news.name !== name) ||
            news.group !== olds?.group ||
            !deepEqual(news.scopes ?? [], olds?.scopes ?? [])
          ) {
            // A pinned name can't be held by two tokens at once.
            return {
              action: "replace",
              deleteFirst: news.name !== undefined && news.name === name,
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const name = output?.name ?? (yield* tokenName(id, olds?.name));
          const observed = yield* observe(name);
          if (!observed) return undefined;
          if (output !== undefined && output.id === observed.id) return output;
          // The generation a delete-first replacement is about to revoke.
          if (previous !== undefined && previous.id === observed.id) return previous;
          // The secret is only revealed at creation, so a token we have no
          // state for can't be adopted with its value — reconcile re-mints.
          return Unowned({
            id: observed.id ?? "",
            name,
            organization: observed.organization ?? "",
            group: observed.group,
            scopes: observed.scopes ?? [],
            token: Redacted.make(""),
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const org = output?.organization ?? (yield* organization);
          const name = output?.name ?? (yield* tokenName(id, news.name));

          // Observe
          const observed = yield* observe(name);
          if (
            observed &&
            output &&
            Redacted.value(output.token) !== "" &&
            output.id === observed.id
          ) {
            return output;
          }

          // Ensure — a token we hold no secret for (a lost create, or an
          // adoption) is revoked and re-minted.
          if (observed) {
            yield* session.note(`Re-minting API token ${name}...`);
            yield* revoke(name);
          }
          const created = yield* turso.createAPIToken({
            tokenName: name,
            organization: org,
            group: news.group,
            scopes: news.scopes,
          });
          if (!created.token || !created.id) {
            return yield* new ApiTokenUnexpectedResponse({
              message: `Turso returned no token for ${name}`,
            });
          }
          const minted = yield* observe(name);
          return {
            id: created.id,
            name,
            organization: minted?.organization ?? org,
            group: minted?.group ?? news.group,
            scopes: minted?.scopes ?? [],
            token: created.token,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* revoke(output.name);
        }),
      };
    }),
  );
