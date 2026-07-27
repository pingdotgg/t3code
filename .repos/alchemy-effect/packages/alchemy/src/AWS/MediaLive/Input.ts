import * as medialive from "@distilled.cloud/aws/medialive";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  MediaLiveResourcePending,
  ensureIdentified,
  retryWhileConflict,
  retryWhilePending,
  syncMlTags,
  toTagRecord,
} from "./internal.ts";

/**
 * The observed shape shared by `DescribeInputResponse` and the `Input`
 * struct returned by create/update/list.
 */
type ObservedInput = Pick<
  medialive.Input,
  | "Arn"
  | "Id"
  | "Name"
  | "State"
  | "Type"
  | "InputClass"
  | "Destinations"
  | "SecurityGroups"
  | "Sources"
  | "RoleArn"
  | "MediaConnectFlows"
  | "Tags"
>;

type IdentifiedInput = ObservedInput & { Id: string; Arn: string };

export interface InputProps {
  /**
   * Name of the input. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Names are mutable — changing the name updates the
   * input in place.
   */
  name?: string;
  /**
   * The input type (e.g. `RTMP_PUSH`, `URL_PULL`, `MEDIACONNECT`,
   * `MP4_FILE`). Changing the type replaces the input.
   */
  type: medialive.InputType;
  /**
   * Destination settings for PUSH-type inputs — e.g. the application/stream
   * name pair for `RTMP_PUSH` (`{ StreamName: "live/stream" }`).
   */
  destinations?: medialive.InputDestinationRequest[];
  /**
   * Source URLs for PULL-type inputs (`URL_PULL`, `RTMP_PULL`, `MP4_FILE`,
   * `TS_FILE`), with optional basic-auth credentials.
   */
  sources?: medialive.InputSourceRequest[];
  /**
   * IDs of input security groups to attach. Required for PUSH-type inputs
   * that ingest over the public internet.
   */
  inputSecurityGroups?: string[];
  /**
   * MediaConnect flows to use as the input source (for `MEDIACONNECT`
   * inputs).
   */
  mediaConnectFlows?: medialive.MediaConnectFlowRequest[];
  /**
   * ARN of the IAM role MediaLive assumes to access the input (required for
   * VPC and MediaConnect inputs).
   */
  roleArn?: string;
  /**
   * VPC settings for a VPC push input. Changing the VPC settings replaces
   * the input.
   */
  vpc?: medialive.InputVpcRequest;
  /**
   * User-defined tags for the input.
   */
  tags?: Record<string, string>;
}

export interface Input extends Resource<
  "AWS.MediaLive.Input",
  InputProps,
  {
    /** Server-assigned unique id of the input. */
    inputId: string;
    /** ARN of the input. */
    inputArn: string;
    /** Name of the input. */
    inputName: string | undefined;
    /** Current lifecycle state (e.g. `DETACHED`, `ATTACHED`). */
    state: medialive.InputState | undefined;
    /** The input type (e.g. `RTMP_PUSH`, `URL_PULL`). */
    type: medialive.InputType | undefined;
    /** `STANDARD` (two ingest endpoints) or `SINGLE_PIPELINE`. */
    inputClass: medialive.InputClass | undefined;
    /** Resolved ingest destinations (push URLs) for the input. */
    destinations: medialive.InputDestination[];
    /** IDs of the attached input security groups. */
    securityGroups: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaLive input — the ingest endpoint or source locator a
 * channel reads live content from (RTMP/RTP push, HLS/MP4 pull,
 * MediaConnect flow, ...).
 *
 * @resource
 * @section Creating Inputs
 * @example RTMP push input behind an allowlist
 * ```typescript
 * const isg = yield* MediaLive.InputSecurityGroup("Allowlist", {
 *   whitelistRules: ["0.0.0.0/0"],
 * });
 * const input = yield* MediaLive.Input("Stream", {
 *   type: "RTMP_PUSH",
 *   inputSecurityGroups: [isg.inputSecurityGroupId],
 *   destinations: [{ StreamName: "live/stream" }],
 * });
 * ```
 *
 * @example HLS pull input
 * ```typescript
 * const input = yield* MediaLive.Input("Vod", {
 *   type: "URL_PULL",
 *   sources: [{ Url: "https://example.com/stream/index.m3u8" }],
 * });
 * ```
 *
 * @section Attaching to a Channel
 * @example Feed a channel
 * ```typescript
 * const channel = yield* MediaLive.Channel("Live", {
 *   roleArn: role.roleArn,
 *   inputAttachments: [
 *     { InputId: input.inputId, InputAttachmentName: "primary" },
 *   ],
 *   encoderSettings,
 *   destinations,
 * });
 * ```
 */
export const Input = Resource<Input>("AWS.MediaLive.Input");

export const InputProvider = () =>
  Provider.effect(
    Input,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const toAttrs = (input: IdentifiedInput) => ({
        inputId: input.Id,
        inputArn: input.Arn,
        inputName: input.Name,
        state: input.State,
        type: input.Type,
        inputClass: input.InputClass,
        destinations: [...(input.Destinations ?? [])],
        securityGroups: [...(input.SecurityGroups ?? [])],
      });

      const isGone = (state: medialive.InputState | undefined) =>
        state === "DELETED" || state === "DELETING";

      /** Describe by id; typed not-found (or tombstone state) → undefined. */
      const getInput = Effect.fn(function* (inputId: string) {
        const input = yield* medialive
          .describeInput({ InputId: inputId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (input === undefined || isGone(input.State)) return undefined;
        return yield* ensureIdentified(input, "DescribeInput Id/Arn");
      });

      /**
       * Inputs have server-assigned ids, so a read without cached output
       * searches the account list by the deterministic physical name.
       */
      const findByName = Effect.fn(function* (name: string) {
        const inputs = yield* medialive.listInputs.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        const match = inputs.find(
          (input) => input.Name === name && !isGone(input.State),
        );
        if (match === undefined) return undefined;
        return yield* ensureIdentified(match, "ListInputs item Id/Arn");
      });

      /** Wait (bounded) for a fresh input to leave `CREATING`. */
      const awaitActive = Effect.fn(function* (inputId: string) {
        return yield* medialive.describeInput({ InputId: inputId }).pipe(
          Effect.flatMap((input) =>
            input.State === "CREATING"
              ? Effect.fail(
                  new MediaLiveResourcePending({
                    message: `input ${inputId} is still CREATING`,
                  }),
                )
              : Effect.succeed(input),
          ),
          retryWhilePending,
          Effect.flatMap((input) =>
            ensureIdentified(input, "DescribeInput Id/Arn"),
          ),
        );
      });

      return Input.Provider.of({
        stables: ["inputId", "inputArn"],

        list: () =>
          medialive.listInputs.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .filter(
                  (input): input is medialive.Input & IdentifiedInput =>
                    input.Id !== undefined &&
                    input.Arn !== undefined &&
                    !isGone(input.State),
                )
                .map(toAttrs),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const input =
            output?.inputId !== undefined
              ? yield* getInput(output.inputId)
              : yield* findByName(yield* createName(id, olds ?? {}));
          if (input === undefined) return undefined;
          const attrs = toAttrs(input);
          return (yield* hasAlchemyTags(id, toTagRecord(input.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The input type is immutable.
          if (olds.type !== news.type) return { action: "replace" } as const;
          // VPC placement is fixed at creation.
          if (JSON.stringify(olds.vpc) !== JSON.stringify(news.vpc)) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const name = yield* createName(id, news);

          // 1. Observe — cloud state is authoritative; output is an id cache.
          // MediaLive input names are not unique, so a name match is only
          // trusted when its immutable type agrees with the desired state —
          // during a replacement the same-named survivor is the doomed old
          // instance, not this one.
          let input: IdentifiedInput | undefined;
          if (output?.inputId !== undefined) {
            input = yield* getInput(output.inputId);
          } else {
            const found = yield* findByName(name);
            input =
              found !== undefined && found.Type === news.type
                ? found
                : undefined;
          }

          // 2. Ensure — create if missing, then wait for CREATING to settle.
          if (input === undefined) {
            const created = yield* medialive.createInput({
              Name: name,
              Type: news.type,
              Destinations: news.destinations,
              Sources: news.sources,
              InputSecurityGroups: news.inputSecurityGroups,
              MediaConnectFlows: news.mediaConnectFlows,
              RoleArn: news.roleArn,
              Vpc: news.vpc,
              Tags: desiredTags,
            });
            const fresh = yield* ensureIdentified(
              created.Input,
              "CreateInput Input Id/Arn",
            );
            input = yield* awaitActive(fresh.Id);
          } else {
            // 3. Sync — apply the in-place-updatable aspects only on drift.
            // Destination stream names are not echoed back by Describe (the
            // API returns resolved URLs), so `olds` is the no-op hint there.
            const sameStringSet = (
              a: readonly (string | undefined)[],
              b: readonly (string | undefined)[],
            ) =>
              JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
            const nameDrift = input.Name !== name;
            const roleDrift =
              news.roleArn !== undefined && input.RoleArn !== news.roleArn;
            const sgDrift = !sameStringSet(
              news.inputSecurityGroups ?? [],
              input.SecurityGroups ?? [],
            );
            const sourceDrift = !sameStringSet(
              (news.sources ?? []).map((s) => s.Url),
              (input.Sources ?? []).map((s) => s.Url),
            );
            const flowDrift = !sameStringSet(
              (news.mediaConnectFlows ?? []).map((f) => f.FlowArn),
              (input.MediaConnectFlows ?? []).map((f) => f.FlowArn),
            );
            const destinationDrift =
              olds === undefined
                ? news.destinations !== undefined
                : JSON.stringify(olds.destinations) !==
                  JSON.stringify(news.destinations);
            if (
              nameDrift ||
              roleDrift ||
              sgDrift ||
              sourceDrift ||
              flowDrift ||
              destinationDrift
            ) {
              yield* medialive
                .updateInput({
                  InputId: input.Id,
                  Name: name,
                  Destinations: news.destinations,
                  Sources: news.sources,
                  InputSecurityGroups: news.inputSecurityGroups,
                  MediaConnectFlows: news.mediaConnectFlows,
                  RoleArn: news.roleArn,
                })
                .pipe(retryWhileConflict);
              input = yield* awaitActive(input.Id);
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMlTags(input.Arn, desiredTags);

          yield* session.note(input.Id);
          return toAttrs(input);
        }),

        delete: Effect.fn(function* ({ output }) {
          // An input attached to a still-deleting channel transiently
          // rejects deletion; deletion itself is async (DELETING → DELETED),
          // which `read` treats as gone.
          yield* medialive.deleteInput({ InputId: output.inputId }).pipe(
            retryWhileConflict,
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
