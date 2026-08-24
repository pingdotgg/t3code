import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readB2biTags, syncB2biTags, toWireTags } from "./internal.ts";

export interface PartnershipProps {
  /**
   * The unique identifier for the profile connected to this partnership.
   * May reference a {@link Profile}'s `profileId` output. Changing the
   * profile replaces the partnership.
   */
  profileId: string;
  /**
   * The name of the partnership.
   */
  name: string;
  /**
   * The email address associated with the trading partner.
   */
  email: string;
  /**
   * The phone number associated with the trading partner, in E.164 format.
   */
  phone?: string;
  /**
   * A list of capability IDs (see {@link Capability}) enabled for this
   * partnership.
   */
  capabilities?: string[];
  /**
   * Inbound/outbound EDI options that override the defaults for this
   * partnership.
   */
  capabilityOptions?: b2bi.CapabilityOptions;
  /**
   * User-defined tags for the partnership.
   */
  tags?: Record<string, string>;
}

export interface Partnership extends Resource<
  "AWS.B2BI.Partnership",
  PartnershipProps,
  {
    /**
     * Service-assigned unique ID of the partnership.
     */
    partnershipId: string;
    /**
     * ARN of the partnership.
     */
    partnershipArn: string;
    /**
     * ID of the profile the partnership belongs to.
     */
    profileId: string;
    /**
     * Service-assigned ID of the trading partner.
     */
    tradingPartnerId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS B2B Data Interchange (B2BI) partnership. A partnership connects a
 * customer {@link Profile} to a trading partner and enables a set of
 * {@link Capability | capabilities} for exchanging EDI documents.
 * @resource
 * @section Creating a Partnership
 * @example Basic Partnership
 * ```typescript
 * const partnership = yield* B2BI.Partnership("AcmeToPartner", {
 *   profileId: profile.profileId,
 *   name: "acme-partner",
 *   email: "edi@partner.example",
 *   capabilities: [capability.capabilityId],
 * });
 * ```
 */
export const Partnership = Resource<Partnership>("AWS.B2BI.Partnership");

const toAttrs = (
  r:
    | b2bi.GetPartnershipResponse
    | b2bi.CreatePartnershipResponse
    | b2bi.UpdatePartnershipResponse,
) => ({
  partnershipId: r.partnershipId,
  partnershipArn: r.partnershipArn,
  profileId: r.profileId,
  tradingPartnerId: r.tradingPartnerId,
});

export const PartnershipProvider = () =>
  Provider.effect(
    Partnership,
    Effect.gen(function* () {
      const findByName = (name: string) =>
        b2bi.listPartnerships.items({}).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? b2bi
                  .getPartnership({ partnershipId: head.value.partnershipId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["partnershipId", "partnershipArn", "profileId"],

        diff: Effect.fn(function* ({ olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          // The profile a partnership belongs to is immutable. Delete-first:
          // the replacement keeps the same user-facing name, which is how
          // lost state is recovered (findByName), so the old instance must
          // be gone before the new one is created.
          if (
            olds.profileId !== undefined &&
            olds.profileId !== news.profileId
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.partnershipId
            ? yield* b2bi
                .getPartnership({ partnershipId: output.partnershipId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(olds?.name ?? "");
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readB2biTags(attrs.partnershipArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let live = output?.partnershipId
            ? yield* b2bi
                .getPartnership({ partnershipId: output.partnershipId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(news.name);

          // 2. Ensure.
          if (live === undefined) {
            const created = yield* b2bi.createPartnership({
              profileId: news.profileId,
              name: news.name,
              email: news.email,
              phone: news.phone,
              capabilities: news.capabilities ?? [],
              capabilityOptions: news.capabilityOptions,
            });
            live = yield* b2bi.getPartnership({
              partnershipId: created.partnershipId,
            });
          } else {
            // 3. Sync — converge name, capabilities, and capability options
            // (email/phone/profile are set only at create time).
            const nameDrift = live.name !== news.name;
            const capsDrift =
              JSON.stringify([...(live.capabilities ?? [])].sort()) !==
              JSON.stringify([...(news.capabilities ?? [])].sort());
            const optsDrift =
              JSON.stringify(live.capabilityOptions ?? null) !==
              JSON.stringify(news.capabilityOptions ?? null);
            if (nameDrift || capsDrift || optsDrift) {
              const updated = yield* b2bi.updatePartnership({
                partnershipId: live.partnershipId,
                name: news.name,
                capabilities: news.capabilities,
                capabilityOptions: news.capabilityOptions,
              });
              live = { ...live, ...updated };
            }
          }

          // 3b. Sync tags.
          yield* syncB2biTags(live.partnershipArn, desiredTags);

          yield* session.note(live.partnershipId);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* b2bi
            .deletePartnership({ partnershipId: output.partnershipId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          b2bi.listPartnerships.items({}).pipe(
            Stream.mapEffect((s) =>
              b2bi.getPartnership({ partnershipId: s.partnershipId }).pipe(
                Effect.map(toAttrs),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              ),
            ),
            Stream.filter((item) => item !== undefined),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
