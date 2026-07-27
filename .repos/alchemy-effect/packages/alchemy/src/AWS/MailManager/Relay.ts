import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readMailManagerTags,
  sameShape,
  syncMailManagerTags,
} from "./internal.ts";

export interface RelayProps {
  /**
   * Name of the relay. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Renames apply in place.
   */
  relayName?: string;
  /**
   * Hostname of the downstream SMTP server emails are relayed to. Updates
   * apply in place.
   */
  serverName: string;
  /**
   * Port of the downstream SMTP server (e.g. 25, 587). Updates apply in
   * place.
   */
  serverPort: number;
  /**
   * How Mail Manager authenticates to the downstream server: a Secrets
   * Manager secret ARN holding SMTP credentials, or explicit
   * `{ NoAuthentication: {} }`. Updates apply in place.
   */
  authentication: mm.RelayAuthentication;
  /**
   * Tags applied to the relay. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface Relay extends Resource<
  "AWS.MailManager.Relay",
  RelayProps,
  {
    /** Server-assigned ID of the relay. */
    relayId: string;
    /** ARN of the relay. */
    relayArn: string;
    /** Name of the relay. */
    relayName: string;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager relay — a downstream SMTP destination that rule-set
 * `Relay` actions forward incoming email to (e.g. an on-prem Exchange
 * server or a third-party filter).
 *
 * All aspects (name, server, port, authentication, tags) update in place.
 * @resource
 * @section Creating Relays
 * @example Unauthenticated Relay
 * ```typescript
 * import * as MailManager from "alchemy/AWS/MailManager";
 *
 * const relay = yield* MailManager.Relay("Downstream", {
 *   serverName: "smtp.example.com",
 *   serverPort: 25,
 *   authentication: { NoAuthentication: {} },
 * });
 * ```
 *
 * @example Authenticated Relay
 * ```typescript
 * const relay = yield* MailManager.Relay("Downstream", {
 *   serverName: "smtp.example.com",
 *   serverPort: 587,
 *   authentication: { SecretArn: secret.secretArn },
 * });
 * ```
 *
 * @section Using in a Rule Set
 * @example Relay Action
 * ```typescript
 * const ruleSet = yield* MailManager.RuleSet("Inbound", {
 *   rules: [
 *     {
 *       Name: "RelayAll",
 *       Actions: [{ Relay: { Relay: relay.relayId } }],
 *     },
 *   ],
 * });
 * ```
 */
export const Relay = Resource<Relay>("AWS.MailManager.Relay");

export const RelayProvider = () =>
  Provider.effect(
    Relay,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { relayName?: string },
      ) {
        return (
          props.relayName ?? (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const getById = (relayId: string) =>
        mm
          .getRelay({ RelayId: relayId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (name: string) =>
        mm.listRelays.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.Relays ?? [])
              .find((r) => r.RelayName === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: Relay["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.relayId !== undefined) {
          const found = yield* getById(output.relayId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.RelayId === undefined) return undefined;
        return yield* getById(summary.RelayId);
      });

      const toAttrs = Effect.fn(function* (relay: mm.GetRelayResponse) {
        if (relay.RelayArn === undefined || relay.RelayName === undefined) {
          return yield* Effect.fail(
            new Error(
              `Mail Manager relay '${relay.RelayId}' returned without ARN/name`,
            ),
          );
        }
        return {
          relayId: relay.RelayId,
          relayArn: relay.RelayArn,
          relayName: relay.RelayName,
        };
      });

      return Relay.Provider.of({
        stables: ["relayId", "relayArn"],

        list: () =>
          mm.listRelays.pages({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.forEach(
                Array.from(chunk)
                  .flatMap((page) => page.Relays ?? [])
                  .flatMap((r) => (r.RelayId !== undefined ? [r.RelayId] : [])),
                (relayId) => getById(relayId),
              ),
            ),
            Effect.flatMap((results) =>
              Effect.forEach(
                results.flatMap((r) => (r === undefined ? [] : [r])),
                (r) => toAttrs(r),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.relayName ?? (yield* createName(id, olds ?? {}));
          const relay = yield* observe(output, name);
          if (relay === undefined) return undefined;
          const attrs = yield* toAttrs(relay);
          const tags = yield* readMailManagerTags(attrs.relayArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Every prop updates in place — no replacement triggers, so the
        // engine's default update path applies (no diff needed).

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE.
          let relay = yield* observe(output, name);

          // 2. ENSURE — create if missing; a Conflict race re-observes.
          if (relay === undefined) {
            yield* session.note(`creating relay ${name}`);
            const created = yield* mm
              .createRelay({
                RelayName: name,
                ServerName: news.serverName,
                ServerPort: news.serverPort,
                Authentication: news.authentication,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            relay =
              created !== undefined
                ? yield* getById(created.RelayId)
                : yield* observe(undefined, name);
          }
          if (relay === undefined) {
            return yield* Effect.fail(
              new Error(`Mail Manager relay '${name}' not found after create`),
            );
          }

          // 3. SYNC — diff OBSERVED state against desired; apply only the
          //    delta.
          if (
            relay.RelayName !== name ||
            relay.ServerName !== news.serverName ||
            relay.ServerPort !== news.serverPort ||
            !sameShape(relay.Authentication, news.authentication)
          ) {
            yield* mm.updateRelay({
              RelayId: relay.RelayId,
              RelayName: name,
              ServerName: news.serverName,
              ServerPort: news.serverPort,
              Authentication: news.authentication,
            });
          }

          // 3b. SYNC TAGS.
          const attrs = yield* toAttrs(relay);
          yield* syncMailManagerTags(attrs.relayArn, desiredTags);

          yield* session.note(attrs.relayId);
          return { ...attrs, relayName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* mm.deleteRelay({ RelayId: output.relayId }).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
