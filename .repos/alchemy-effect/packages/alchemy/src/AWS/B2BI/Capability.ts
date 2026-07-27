import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readB2biTags, syncB2biTags, toWireTags } from "./internal.ts";

export interface CapabilityProps {
  /**
   * The name of the capability.
   */
  name: string;
  /**
   * The type of the capability. EDI is the only supported type today.
   * @default "edi"
   */
  type?: "edi";
  /**
   * The capability configuration. For EDI capabilities this describes the
   * X12 transaction set, direction, transformer, and the input/output S3
   * locations. `configuration.edi.transformerId` may reference a
   * {@link Transformer}'s `transformerId` output.
   */
  configuration: b2bi.CapabilityConfiguration;
  /**
   * S3 locations of instruction documents (implementation guides) attached
   * to the capability.
   */
  instructionsDocuments?: b2bi.S3Location[];
  /**
   * User-defined tags for the capability.
   */
  tags?: Record<string, string>;
}

export interface Capability extends Resource<
  "AWS.B2BI.Capability",
  CapabilityProps,
  {
    /**
     * Service-assigned unique ID of the capability.
     */
    capabilityId: string;
    /**
     * ARN of the capability.
     */
    capabilityArn: string;
    /**
     * Name of the capability.
     */
    name: string;
    /**
     * Capability type (`edi`).
     */
    type: string;
  },
  never,
  Providers
> {}

/**
 * An AWS B2B Data Interchange (B2BI) capability. A capability contains the
 * information required to transform incoming or outgoing EDI documents: the
 * X12 transaction set, a transformer, and the S3 input/output locations.
 * @resource
 * @section Creating a Capability
 * @example Inbound X12 850 Capability
 * ```typescript
 * const capability = yield* B2BI.Capability("Orders", {
 *   name: "inbound-orders",
 *   configuration: {
 *     edi: {
 *       capabilityDirection: "INBOUND",
 *       type: { x12Details: { transactionSet: "X12_850", version: "VERSION_4010" } },
 *       inputLocation: { bucketName: bucket.bucketName, key: "inbound/" },
 *       outputLocation: { bucketName: bucket.bucketName, key: "processed/" },
 *       transformerId: transformer.transformerId,
 *     },
 *   },
 * });
 * ```
 */
export const Capability = Resource<Capability>("AWS.B2BI.Capability");

const toAttrs = (
  r:
    | b2bi.GetCapabilityResponse
    | b2bi.CreateCapabilityResponse
    | b2bi.UpdateCapabilityResponse,
) => ({
  capabilityId: r.capabilityId,
  capabilityArn: r.capabilityArn,
  name: r.name,
  type: r.type,
});

export const CapabilityProvider = () =>
  Provider.effect(
    Capability,
    Effect.gen(function* () {
      const findByName = (name: string) =>
        b2bi.listCapabilities.items({}).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? b2bi
                  .getCapability({ capabilityId: head.value.capabilityId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["capabilityId", "capabilityArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.capabilityId
            ? yield* b2bi
                .getCapability({ capabilityId: output.capabilityId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(olds?.name ?? "");
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readB2biTags(attrs.capabilityArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let live = output?.capabilityId
            ? yield* b2bi
                .getCapability({ capabilityId: output.capabilityId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(news.name);

          // 2. Ensure.
          if (live === undefined) {
            const created = yield* b2bi.createCapability({
              name: news.name,
              type: news.type ?? "edi",
              configuration: news.configuration,
              instructionsDocuments: news.instructionsDocuments,
              tags: toWireTags(desiredTags),
            });
            live = yield* b2bi.getCapability({
              capabilityId: created.capabilityId,
            });
          } else {
            // 3. Sync — converge name, configuration, and instruction docs.
            const nameDrift = live.name !== news.name;
            const configDrift =
              JSON.stringify(live.configuration) !==
              JSON.stringify(news.configuration);
            const docsDrift =
              JSON.stringify(live.instructionsDocuments ?? null) !==
              JSON.stringify(news.instructionsDocuments ?? null);
            if (nameDrift || configDrift || docsDrift) {
              const updated = yield* b2bi.updateCapability({
                capabilityId: live.capabilityId,
                name: news.name,
                configuration: news.configuration,
                instructionsDocuments: news.instructionsDocuments,
              });
              live = { ...live, ...updated };
            }
          }

          // 3b. Sync tags.
          yield* syncB2biTags(live.capabilityArn, desiredTags);

          yield* session.note(live.capabilityId);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* b2bi
            .deleteCapability({ capabilityId: output.capabilityId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          b2bi.listCapabilities.items({}).pipe(
            Stream.mapEffect((s) =>
              b2bi.getCapability({ capabilityId: s.capabilityId }).pipe(
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
