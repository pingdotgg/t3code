import * as turnstile from "@distilled.cloud/cloudflare/turnstile";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Turnstile.Widget" as const;
type TypeId = typeof TypeId;

/**
 * Rendering / interaction mode of a Turnstile widget.
 */
export type WidgetMode = "managed" | "non-interactive" | "invisible";

/**
 * Region a Turnstile widget can be served from. Cannot be changed after
 * creation.
 */
export type WidgetRegion = "world" | "china";

/**
 * Clearance level granted when the widget is embedded on a Cloudflare zone.
 */
export type ClearanceLevel =
  | "no_clearance"
  | "jschallenge"
  | "managed"
  | "interactive";

export type WidgetProps = {
  /**
   * Human readable widget name. Not unique. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Hostnames the widget is allowed to run on (e.g. `example.com`).
   * Subdomains are covered automatically.
   */
  domains: string[];
  /**
   * Widget mode: `managed` (Cloudflare decides if an interaction is
   * required), `non-interactive` (never requires interaction), or
   * `invisible` (no visible widget).
   */
  mode: WidgetMode;
  /**
   * Region where this widget can be used. Cannot be changed after creation —
   * updating this property triggers a replacement.
   * @default "world"
   */
  region?: WidgetRegion;
  /**
   * If `true`, Cloudflare issues computationally expensive challenges in
   * response to malicious bots (Enterprise only).
   * @default false
   */
  botFightMode?: boolean;
  /**
   * If Turnstile is embedded on a Cloudflare site and the widget should
   * grant challenge clearance, this setting determines the clearance level.
   * @default "no_clearance"
   */
  clearanceLevel?: ClearanceLevel;
  /**
   * Return the Ephemeral ID in `/siteverify` responses (Enterprise only).
   * @default false
   */
  ephemeralId?: boolean;
  /**
   * Do not show any Cloudflare branding on the widget (Enterprise only).
   * @default false
   */
  offlabel?: boolean;
};

export type WidgetAttributes = {
  /**
   * Widget item identifier tag. This is the public sitekey embedded in HTML.
   */
  sitekey: string;
  /**
   * Secret key for this widget, used server-side with the
   * `/turnstile/v0/siteverify` endpoint.
   */
  secret: Redacted.Redacted<string>;
  /**
   * The Cloudflare account the widget belongs to.
   */
  accountId: string;
  /**
   * Human readable widget name.
   */
  name: string;
  /**
   * Hostnames the widget is allowed to run on.
   */
  domains: string[];
  /**
   * Widget mode.
   */
  mode: WidgetMode;
  /**
   * Region where this widget can be used.
   */
  region: WidgetRegion;
  /**
   * Whether bot fight mode is enabled (Enterprise only).
   */
  botFightMode: boolean;
  /**
   * Clearance level granted on Cloudflare zones.
   */
  clearanceLevel: ClearanceLevel;
  /**
   * Whether the Ephemeral ID is returned in `/siteverify` (Enterprise only).
   */
  ephemeralId: boolean;
  /**
   * Whether Cloudflare branding is hidden (Enterprise only).
   */
  offlabel: boolean;
  /**
   * When the widget was created.
   */
  createdOn: string;
  /**
   * When the widget was last modified.
   */
  modifiedOn: string;
};

export type Widget = Resource<
  TypeId,
  WidgetProps,
  WidgetAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Turnstile widget — Cloudflare's CAPTCHA alternative.
 *
 * A widget is identified by its auto-assigned `sitekey` (the public key you
 * embed in HTML) and produces a `secret` used server-side against the
 * `/turnstile/v0/siteverify` endpoint. Name, domains, mode, and clearance
 * settings are all mutable in place; only `region` forces a replacement.
 * @resource
 * @product Turnstile
 * @category Application Security
 * @section Creating a Widget
 * @example Managed widget
 * ```typescript
 * const widget = yield* Cloudflare.Turnstile.Widget("signup-form", {
 *   domains: ["example.com"],
 *   mode: "managed",
 * });
 * ```
 *
 * @example Invisible widget with an explicit name
 * ```typescript
 * const widget = yield* Cloudflare.Turnstile.Widget("api-guard", {
 *   name: "api-guard",
 *   domains: ["example.com", "app.example.com"],
 *   mode: "invisible",
 * });
 * ```
 *
 * @section Using the keys
 * @example Embedding the sitekey and verifying tokens
 * ```typescript
 * // The sitekey is public — render it in your HTML:
 * const sitekey = widget.sitekey;
 *
 * // The secret is redacted — pass it to your server-side verifier:
 * const secret = widget.secret; // Redacted<string>
 * ```
 *
 * @see https://developers.cloudflare.com/turnstile/
 */
export const Widget = Resource<Widget>(TypeId);

/**
 * Returns true if the given value is a Widget resource.
 */
export const isWidget = (value: unknown): value is Widget =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WidgetProvider = () =>
  Provider.succeed(Widget, {
    stables: ["sitekey", "accountId", "region", "createdOn"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Region cannot be changed after creation.
      const oldRegion = output?.region ?? olds?.region ?? "world";
      if ((news.region ?? "world") !== oldRegion) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.sitekey) {
        const observed = yield* getWidget(acct, output.sitekey);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createWidgetName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match) {
        const observed = yield* getWidget(acct, match.sitekey);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createWidgetName(id, news.name);

      // Observe — the sitekey cached on `output` is a hint, not a
      // guarantee: a 404 falls through to "missing" and we recreate.
      const observed = output?.sitekey
        ? yield* getWidget(output.accountId ?? accountId, output.sitekey)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. Names are not unique so there is no
        // AlreadyExists race to tolerate.
        const created = yield* turnstile.createWidget({
          accountId,
          name,
          domains: news.domains,
          mode: news.mode,
          region: news.region,
          botFightMode: news.botFightMode,
          clearanceLevel: news.clearanceLevel,
          ephemeralId: news.ephemeralId,
          offlabel: news.offlabel,
        });
        return toAttributes(created, accountId);
      }

      // Sync — diff observed cloud state against desired; the update API
      // is a PUT that requires the full body, so send everything, but
      // skip the call entirely on a no-op.
      const desired = {
        name,
        domains: news.domains,
        mode: news.mode,
        botFightMode: news.botFightMode ?? observedBool(observed.botFightMode),
        clearanceLevel:
          news.clearanceLevel ?? (observed.clearanceLevel as ClearanceLevel),
        ephemeralId: news.ephemeralId ?? observedBool(observed.ephemeralId),
        offlabel: news.offlabel ?? observedBool(observed.offlabel),
      };
      const dirty =
        observed.name !== desired.name ||
        observed.mode !== desired.mode ||
        !sameDomains(observed.domains, desired.domains) ||
        (news.botFightMode !== undefined &&
          observed.botFightMode !== news.botFightMode) ||
        (news.clearanceLevel !== undefined &&
          observed.clearanceLevel !== news.clearanceLevel) ||
        (news.ephemeralId !== undefined &&
          observed.ephemeralId !== news.ephemeralId) ||
        (news.offlabel !== undefined && observed.offlabel !== news.offlabel);

      if (!dirty) {
        return toAttributes(observed, observed.accountId);
      }

      const updated = yield* turnstile.updateWidget({
        accountId: observed.accountId,
        sitekey: observed.sitekey,
        ...desired,
      });
      return toAttributes(updated, observed.accountId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* turnstile
        .deleteWidget({
          accountId: output.accountId,
          sitekey: output.sitekey,
        })
        .pipe(Effect.catchTag("WidgetNotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Enumerate every widget in the account, paginating exhaustively.
      const pages = yield* turnstile.listWidgets
        .pages({ accountId })
        .pipe(Stream.runCollect);
      const sitekeys = Array.from(pages).flatMap((page) =>
        (page.result ?? []).map((w) => w.sitekey),
      );
      // The list payload omits the write-only `secret`, so hydrate each
      // widget via `getWidget` to produce the exact `read` Attributes
      // shape. A widget deleted between list and get surfaces as
      // `WidgetNotFound` (mapped to `undefined` by `getWidget`).
      const rows = yield* Effect.forEach(
        sitekeys,
        (sitekey) =>
          getWidget(accountId, sitekey).pipe(
            Effect.map((w) => (w ? toAttributes(w, accountId) : undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is WidgetAttributes => row !== undefined);
    }),
  });

type ObservedWidget = turnstile.GetWidgetResponse & { accountId: string };

/**
 * Read a widget by sitekey, mapping "gone" (`WidgetNotFound`, Cloudflare
 * error code 10404) to `undefined`.
 */
const getWidget = (accountId: string, sitekey: string) =>
  turnstile.getWidget({ accountId, sitekey }).pipe(
    Effect.map((w): ObservedWidget => ({ ...w, accountId })),
    Effect.catchTag("WidgetNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a widget by exact name. Cloudflare's `filter` is a case-insensitive
 * substring match, so re-check exactly client-side. If several widgets carry
 * the same name, pick the oldest for determinism.
 */
const findByName = (accountId: string, name: string) =>
  turnstile.listWidgets.items({ accountId, filter: `name:${name}` }).pipe(
    Stream.filter((w) => w.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.createdOn.localeCompare(b.createdOn))
        .at(0),
    ),
  );

const createWidgetName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const observedBool = (value: boolean | undefined) => value ?? false;

const sameDomains = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  widget:
    | turnstile.GetWidgetResponse
    | turnstile.CreateWidgetResponse
    | turnstile.UpdateWidgetResponse,
  accountId: string,
): WidgetAttributes => ({
  sitekey: widget.sitekey,
  secret: Redacted.make(widget.secret),
  accountId,
  name: widget.name,
  // Distilled widens generated string enums to open unions (`string & {}`).
  domains: [...widget.domains],
  mode: widget.mode as WidgetMode,
  region: widget.region as WidgetRegion,
  botFightMode: widget.botFightMode,
  clearanceLevel: widget.clearanceLevel as ClearanceLevel,
  ephemeralId: widget.ephemeralId,
  offlabel: widget.offlabel,
  createdOn: widget.createdOn,
  modifiedOn: widget.modifiedOn,
});
