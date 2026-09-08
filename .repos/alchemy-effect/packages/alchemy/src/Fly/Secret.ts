import type { AppSecret } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { App, listOwnedApps } from "./App.ts";
import { createFlyVolumeName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface SecretProps {
  /**
   * Parent Fly App. Changing it replaces the secret.
   */
  app: Ref<App>;
  /**
   * Secret name. Used as the Machine env-var name when set by the user
   * (case-sensitive, stored as-is). If omitted, a unique name is generated
   * from the stack, stage and logical ID (the ownership stamp). Changing
   * it replaces the secret.
   */
  name?: string;
  /**
   * Secret value. Wrap with `Redacted.make(...)` so it is never logged.
   * Updated in place via `updateSecrets`. Never persisted in attributes.
   */
  value: Redacted.Redacted<string> | string;
}

export type Secret = Resource<
  "Fly.Secret",
  SecretProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Secret name (unique per App). */
    name: string;
    /** Fly digest of the current value. Not the plaintext. */
    digest: string | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
    /** RFC3339 last-update timestamp. */
    updatedAt: string | undefined;
  },
  never,
  Providers
>;

const resolveSecretProps = (
  props: SecretProps | Effect.Effect<SecretProps, never, Providers>,
): Effect.Effect<SecretProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const app = Effect.isEffect(resolved.app)
      ? yield* resolved.app as Effect.Effect<App, never, Providers>
      : resolved.app;
    return { ...resolved, app };
  });

const SecretResource = Resource<Secret>("Fly.Secret");

/**
 * A Fly.Secret is an App vault entry. Fly injects it as an environment
 * variable on every Machine. Use it when the value is shared and
 * managed in one place by Fly.
 *
 * For a secret only this {@link Service} reads from `.env` at deploy
 * time, yield `Config.redacted` instead. Do not pass `env: { ... }` on
 * a Service.
 *
 * @see https://fly.io/docs/apps/secrets/
 *
 * ### Config.redacted on a Service
 * Most secrets in a Service come from your `.env`. Yield
 * `Config.redacted` in init. Alchemy binds the value onto the Machine.
 *
 * **Example:** Bind from .env
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const token = Redacted.value(apiKey);
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Create a Secret
 * Wrap the value with `Redacted.make` so it is never logged. The
 * plaintext is never stored in attributes. Omit `name` and Alchemy
 * generates an ownership-stamped name.
 *
 * **Example:** Generated name
 * ```typescript
 * const dbUrl = yield* Fly.Secret("DatabaseUrl", {
 *   app: Site,
 *   value: Redacted.make("postgres://…"),
 * });
 * ```
 *
 * :::caution[Changing `app` replaces the Secret]
 * The value is created on the new App. The old name is deleted.
 * :::
 *
 * ### Env-var name
 * `name` is the env-var Machines see. It is stored as-is
 * (case-sensitive).
 *
 * **Example:** Explicit name
 * ```typescript
 * export const ApiToken = Fly.Secret("ApiToken", {
 *   app: Site,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the Secret]
 * Fly cannot rename a secret. Alchemy creates the new name, then
 * deletes the old one.
 * :::
 *
 * ### Rotate the value
 * Updating `value` is in place via `updateSecrets`.
 *
 * **Example:** New value
 * ```typescript
 * export const ApiToken = Fly.Secret("ApiToken", {
 *   app: Site,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_rotated"),
 * });
 * ```
 *
 * ### Get a secret at runtime
 * {@link GetSecret} is bound to one Secret. Provide
 * {@link GetSecretHttp}. Fly only returns plaintext from a Machine in
 * the same App. From a deploy-time Action you get metadata (name,
 * digest, timestamps).
 *
 * **Example:** GetSecret
 * ```typescript
 * const get = yield* Fly.GetSecret(ApiToken);
 * const got = yield* get();
 * ```
 *
 * ### List secrets
 * {@link ListSecrets} is bound to an {@link App}. From an Action, the
 * org token can list any App in the org. From a Machine, deploy tokens
 * are per-App. Mixing Apps on one Machine shares one `FLY_API_TOKEN`
 * and is not supported.
 *
 * **Example:** ListSecrets
 * ```typescript
 * const list = yield* Fly.ListSecrets(Site);
 * const { secrets } = yield* list();
 * ```
 *
 * ### Write secrets
 * {@link WriteSecret} creates, updates, and deletes by name. Provide
 * {@link WriteSecretHttp} on the Action or Service Effect.
 *
 * **Example:** Rotate from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const secrets = yield* Fly.WriteSecret(ApiToken);
 *
 *     return Effect.fn(function* () {
 *       yield* secrets.update("API_TOKEN", Redacted.make("sk_live_rotated"));
 *     });
 *   }).pipe(Effect.provide(Fly.WriteSecretHttp)),
 * );
 * ```
 *
 * @resource
 */
export const Secret: typeof SecretResource = Object.assign(
  (
    id: string,
    props: SecretProps | Effect.Effect<SecretProps, never, Providers>,
  ) => SecretResource(id, resolveSecretProps(props)),
  SecretResource,
);

export class SecretNotCreated extends Data.TaggedError("Fly.SecretNotCreated")<{
  appName: string;
  name: string;
}> {}

export class SecretAppRequired extends Data.TaggedError(
  "Fly.SecretAppRequired",
)<{
  message: string;
}> {}

const appNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { appName?: unknown };
  return typeof rec.appName === "string" && rec.appName.length > 0
    ? rec.appName
    : undefined;
};

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    // User env-var names are stored as-is (case-sensitive). Generated
    // names use the Volume underscore shape — Fly rejects hyphens.
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createFlyVolumeName(id);
  });

const toAttrs = (
  appName: string,
  secret: AppSecret,
  fallbackName: string,
): Secret["Attributes"] => ({
  appName,
  name: secret.name ?? fallbackName,
  digest: secret.digest,
  createdAt: secret.created_at,
  updatedAt: secret.updated_at,
});

const getByName = (appName: string, secretName: string) =>
  machines
    .getSecret({
      app_name: appName,
      secret_name: secretName,
      show_secrets: false,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listSecrets = (appName: string) =>
  machines
    .listSecrets({
      app_name: appName,
      show_secrets: false,
    })
    .pipe(
      Effect.map((res) => res.secrets ?? []),
      Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
    );

const flyDigestCandidates = (plain: string) =>
  Effect.sync(() => {
    const utf8 = Buffer.from(plain, "utf8");
    return [
      createHash("md5").update(utf8).digest("hex"),
      createHash("sha256").update(utf8).digest("hex"),
    ];
  });

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["appName", "name", "createdAt"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName = news.name !== undefined ? news.name : output.name;
      const nameChanged = desiredName !== output.name;
      const nextApp = appNameOf(news.app);
      const appChanged = nextApp !== undefined && nextApp !== output.appName;
      if (nameChanged || appChanged) {
        return {
          action: "replace" as const,
          // Same (app, name) cannot exist twice — delete the old secret first.
          deleteFirst: nameChanged && !appChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const appName =
        output?.appName ??
        (olds !== undefined ? appNameOf(olds.app) : undefined);
      if (appName === undefined) return undefined;
      const name = yield* resolveName(id, olds?.name, output?.name);
      const found = yield* getByName(appName, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(appName, found, name);
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          listSecrets(app.appName).pipe(
            Effect.map((secrets) =>
              secrets.flatMap((secret) => {
                const name = secret.name;
                if (!matchesAlchemyPhysicalName(name)) return [];
                return [toAttrs(app.appName, secret, name ?? "")];
              }),
            ),
          ),
        { concurrency: 8 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const props = news ?? ({} as SecretProps);
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new SecretAppRequired({
          message: "Secret requires a resolved Fly.App",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const desiredPlain = unwrapSecret(props.value);

      // Observe by cached identity, then the desired (app, name).
      let current =
        output !== undefined
          ? yield* getByName(output.appName, output.name)
          : undefined;
      if (
        current === undefined &&
        (output === undefined ||
          output.appName !== appName ||
          output.name !== name)
      ) {
        current = yield* getByName(appName, name);
      }

      let createdThisRun = false;
      if (current === undefined) {
        yield* machines
          .createSecret({
            app_name: appName,
            secret_name: name,
            value: desiredPlain,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* getByName(appName, name);
        createdThisRun = true;
      }

      if (current === undefined) {
        return yield* new SecretNotCreated({ appName, name });
      }

      // Sync — skip if we just created. Prefer observed digest vs hash of
      // desired; otherwise re-put when olds is absent (adoption) or the
      // previous value differs. Never log the plaintext.
      if (!createdThisRun) {
        const candidates = yield* flyDigestCandidates(desiredPlain);
        const digestMatches =
          current.digest !== undefined && candidates.includes(current.digest);
        const previousPlain =
          olds?.value !== undefined ? unwrapSecret(olds.value) : undefined;
        const valueChanged =
          previousPlain === undefined || previousPlain !== desiredPlain;
        if (!digestMatches && valueChanged) {
          yield* machines
            .updateSecrets({
              app_name: appName,
              values: { [name]: desiredPlain },
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.void));
          current = (yield* getByName(appName, name)) ?? current;
        }
      }

      return toAttrs(appName, current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.appName.length === 0 || output.name.length === 0) return;
      yield* machines
        .deleteSecret({
          app_name: output.appName,
          secret_name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(output.appName, output.name).pipe(
        Effect.map((secret) => secret === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
