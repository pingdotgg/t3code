import * as medialive from "@distilled.cloud/aws/medialive";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { ensureIdentified, syncMlTags, toTagRecord } from "./internal.ts";

// Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
// provider lifecycle op leaks `Retry.Return`'s conditional into declaration
// emit and widens the provider layer to `unknown` R for every consumer of
// `AWS.providers()`.
//
// An Input Security Group attached to a still-deleting Input rejects
// deletion with a `BadRequestException` until the Input is fully gone.
const retryWhileInUse = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "BadRequestException" || e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/** An input security group whose server-assigned identity is present. */
type IdentifiedGroup = medialive.InputSecurityGroup & {
  Id: string;
  Arn: string;
};

const hasIdentity = (
  isg: medialive.InputSecurityGroup,
): isg is IdentifiedGroup => isg.Id !== undefined && isg.Arn !== undefined;

export interface InputSecurityGroupProps {
  /**
   * IPv4 CIDR ranges allowed to push content to inputs attached to this
   * security group (e.g. `"10.0.0.0/16"`, `"0.0.0.0/0"`).
   * @default ["0.0.0.0/0"]
   */
  whitelistRules?: string[];
  /**
   * User-defined tags for the input security group.
   */
  tags?: Record<string, string>;
}

export interface InputSecurityGroup extends Resource<
  "AWS.MediaLive.InputSecurityGroup",
  InputSecurityGroupProps,
  {
    /** Server-assigned unique id of the input security group. */
    inputSecurityGroupId: string;
    /** ARN of the input security group. */
    inputSecurityGroupArn: string;
    /** Current state (e.g. `IDLE`, `IN_USE`). */
    state: medialive.InputSecurityGroupState | undefined;
    /** Allowlisted source CIDR blocks. */
    whitelistRules: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaLive input security group — an IP allowlist that
 * gates which source networks may push content to attached PUSH inputs
 * (RTMP_PUSH, RTP_PUSH, UDP_PUSH).
 *
 * @resource
 * @section Creating an Input Security Group
 * @example Allow a single network
 * ```typescript
 * const isg = yield* MediaLive.InputSecurityGroup("Allowlist", {
 *   whitelistRules: ["10.0.0.0/16"],
 * });
 * ```
 *
 * @example Open to the world (test-only)
 * ```typescript
 * const isg = yield* MediaLive.InputSecurityGroup("Open", {
 *   whitelistRules: ["0.0.0.0/0"],
 *   tags: { team: "media" },
 * });
 * ```
 *
 * @section Attaching to an Input
 * @example Gate an RTMP push input
 * ```typescript
 * const input = yield* MediaLive.Input("Stream", {
 *   type: "RTMP_PUSH",
 *   inputSecurityGroups: [isg.inputSecurityGroupId],
 *   destinations: [{ StreamName: "live/stream" }],
 * });
 * ```
 */
export const InputSecurityGroup = Resource<InputSecurityGroup>(
  "AWS.MediaLive.InputSecurityGroup",
);

export const InputSecurityGroupProvider = () =>
  Provider.effect(
    InputSecurityGroup,
    Effect.gen(function* () {
      const toAttrs = (isg: IdentifiedGroup) => ({
        inputSecurityGroupId: isg.Id,
        inputSecurityGroupArn: isg.Arn,
        state: isg.State,
        whitelistRules: (isg.WhitelistRules ?? [])
          .map((r) => r.Cidr)
          .filter((cidr): cidr is string => cidr !== undefined),
      });

      /** Describe by id; typed not-found (or tombstone state) → undefined. */
      const getGroup = Effect.fn(function* (id: string) {
        const isg = yield* medialive
          .describeInputSecurityGroup({ InputSecurityGroupId: id })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (isg === undefined || isg.State === "DELETED") return undefined;
        if (!hasIdentity(isg)) return undefined;
        return isg;
      });

      /**
       * Input security groups have server-assigned ids and no name, so a
       * read without cached output scans the account list for the group
       * carrying this logical id's Alchemy tags.
       */
      const findByTags = Effect.fn(function* (id: string) {
        const groups = yield* medialive.listInputSecurityGroups.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        for (const isg of groups) {
          if (isg.State === "DELETED" || !hasIdentity(isg)) continue;
          if (yield* hasAlchemyTags(id, toTagRecord(isg.Tags))) {
            return isg;
          }
        }
        return undefined;
      });

      const desiredRules = (props: InputSecurityGroupProps) =>
        (props.whitelistRules ?? ["0.0.0.0/0"]).map((cidr) => ({
          Cidr: cidr,
        }));

      return InputSecurityGroup.Provider.of({
        stables: ["inputSecurityGroupId", "inputSecurityGroupArn"],

        list: () =>
          medialive.listInputSecurityGroups.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .filter(
                  (isg): isg is IdentifiedGroup =>
                    hasIdentity(isg) && isg.State !== "DELETED",
                )
                .map(toAttrs),
            ),
          ),

        read: Effect.fn(function* ({ id, output }) {
          const isg =
            output?.inputSecurityGroupId !== undefined
              ? yield* getGroup(output.inputSecurityGroupId)
              : yield* findByTags(id);
          if (isg === undefined) return undefined;
          const attrs = toAttrs(isg);
          return (yield* hasAlchemyTags(id, toTagRecord(isg.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        // No immutable props — every drift is an in-place update.
        diff: Effect.fn(function* () {}),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const rules = desiredRules(news);

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let isg =
            output?.inputSecurityGroupId !== undefined
              ? yield* getGroup(output.inputSecurityGroupId)
              : yield* findByTags(id);

          // 2. Ensure — create if missing.
          if (isg === undefined) {
            const created = yield* medialive.createInputSecurityGroup({
              WhitelistRules: rules,
              Tags: desiredTags,
            });
            isg = yield* ensureIdentified(
              created.SecurityGroup,
              "CreateInputSecurityGroup SecurityGroup Id/Arn",
            );
          } else {
            // 3. Sync — apply whitelist rules only when they drift.
            const observed = (isg.WhitelistRules ?? [])
              .map((r) => r.Cidr)
              .filter((cidr): cidr is string => cidr !== undefined)
              .sort();
            const wanted = rules
              .map((r) => r.Cidr)
              .slice()
              .sort();
            if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
              const updated = yield* medialive.updateInputSecurityGroup({
                InputSecurityGroupId: isg.Id,
                WhitelistRules: rules,
              });
              isg = yield* ensureIdentified(
                updated.SecurityGroup,
                "UpdateInputSecurityGroup SecurityGroup Id/Arn",
              );
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMlTags(isg.Arn, desiredTags);

          yield* session.note(isg.Id);
          return toAttrs(isg);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* medialive
            .deleteInputSecurityGroup({
              InputSecurityGroupId: output.inputSecurityGroupId,
            })
            .pipe(
              retryWhileInUse,
              Effect.catchTag("NotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
