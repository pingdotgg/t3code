import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readSmsVoiceTags,
  retrySmsVoiceThrottled,
  syncSmsVoiceTags,
  toTagList,
} from "./internal.ts";

export interface PhoneNumberProps {
  /**
   * Two-character ISO country code of the requested number, e.g. `US`.
   * Changing it replaces the phone number.
   */
  isoCountryCode: string;
  /**
   * Type of messages sent from the number: `TRANSACTIONAL` for
   * time-sensitive messages or `PROMOTIONAL` for marketing content.
   * Changing it replaces the phone number.
   */
  messageType: "TRANSACTIONAL" | "PROMOTIONAL";
  /**
   * Capabilities the number must support: `SMS`, `VOICE`, and/or `MMS`.
   * Changing them replaces the phone number.
   */
  numberCapabilities: string[];
  /**
   * Type of number to lease: `SIMULATOR`, `LONG_CODE`, `TOLL_FREE`, or
   * `TEN_DLC`. `SIMULATOR` numbers only exchange messages with other
   * simulator destinations and carry the smallest cost — use them for
   * testing. Changing it replaces the phone number.
   */
  numberType: string;
  /**
   * Name of the opt-out list to associate with the number.
   * @default the account's Default opt-out list
   */
  optOutListName?: string;
  /**
   * When `true`, `ReleasePhoneNumber` is rejected until protection is
   * disabled again.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * Tags to apply to the phone number. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PhoneNumber extends Resource<
  "AWS.PinpointSMSVoiceV2.PhoneNumber",
  PhoneNumberProps,
  {
    /**
     * ID of the phone number.
     */
    phoneNumberId: string;
    /**
     * ARN of the phone number.
     */
    phoneNumberArn: string;
    /**
     * The provisioned phone number in E.164 format.
     */
    phoneNumber: string;
    /**
     * Provisioning status (e.g. `PENDING`, `ACTIVE`).
     */
    status: string;
    /**
     * Two-letter ISO country code of the number.
     */
    isoCountryCode: string;
    /**
     * Message type the number is registered for (`TRANSACTIONAL` or
     * `PROMOTIONAL`).
     */
    messageType: string;
    /**
     * Capabilities of the number (`SMS`, `VOICE`, `MMS`).
     */
    numberCapabilities: string[];
    /**
     * Number type (e.g. `LONG_CODE`, `TOLL_FREE`, `TEN_DLC`).
     */
    numberType: string;
    /**
     * Monthly leasing price in USD.
     */
    monthlyLeasingPrice: string;
    /**
     * Opt-out list associated with the number.
     */
    optOutListName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS End User Messaging SMS (Pinpoint SMS Voice v2) origination
 * phone number leased into your account.
 *
 * Requesting a number incurs a monthly leasing fee and most number types
 * require account-level entitlement (spending limits, registration).
 * `SIMULATOR` numbers are the cheap, entitlement-free option for testing.
 * @resource
 * @section Requesting Phone Numbers
 * @example Simulator Number
 * ```typescript
 * import * as PinpointSMSVoiceV2 from "alchemy/AWS/PinpointSMSVoiceV2";
 *
 * const number = yield* PinpointSMSVoiceV2.PhoneNumber("TestNumber", {
 *   isoCountryCode: "US",
 *   messageType: "TRANSACTIONAL",
 *   numberCapabilities: ["SMS"],
 *   numberType: "SIMULATOR",
 * });
 * ```
 *
 * @example Toll-Free Number with a Custom Opt-Out List
 * ```typescript
 * const optOuts = yield* PinpointSMSVoiceV2.OptOutList("OptOuts");
 * const number = yield* PinpointSMSVoiceV2.PhoneNumber("Sender", {
 *   isoCountryCode: "US",
 *   messageType: "TRANSACTIONAL",
 *   numberCapabilities: ["SMS", "VOICE"],
 *   numberType: "TOLL_FREE",
 *   optOutListName: optOuts.optOutListName,
 * });
 * ```
 */
export const PhoneNumber = Resource<PhoneNumber>(
  "AWS.PinpointSMSVoiceV2.PhoneNumber",
);

/**
 * Raised when a phone number cannot be observed after `RequestPhoneNumber`
 * succeeded, or the API returned a number without its ID.
 */
export class SmsVoicePhoneNumberMissing extends Data.TaggedError(
  "SmsVoicePhoneNumberMissing",
)<{ message: string }> {}

/**
 * Poll a freshly-requested number out of `PENDING` on a bounded schedule
 * (extracted so declaration emit keeps the provider layer type narrow).
 */
const untilNotPending = <E, R>(
  self: Effect.Effect<smsvoice.PhoneNumberInformation | undefined, E, R>,
): Effect.Effect<smsvoice.PhoneNumberInformation | undefined, E, R> =>
  Effect.repeat(self, {
    until: (p) => p === undefined || p.Status !== "PENDING",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

const toAttrs = (info: smsvoice.PhoneNumberInformation) =>
  Effect.gen(function* () {
    if (info.PhoneNumberId === undefined) {
      return yield* Effect.fail(
        new SmsVoicePhoneNumberMissing({
          message: `phone number '${info.PhoneNumberArn}' is missing its ID`,
        }),
      );
    }
    return {
      phoneNumberId: info.PhoneNumberId,
      phoneNumberArn: info.PhoneNumberArn,
      phoneNumber: info.PhoneNumber,
      status: info.Status,
      isoCountryCode: info.IsoCountryCode,
      messageType: info.MessageType,
      numberCapabilities: [...info.NumberCapabilities],
      numberType: info.NumberType,
      monthlyLeasingPrice: info.MonthlyLeasingPrice,
      optOutListName: info.OptOutListName,
    };
  });

const sameCapabilities = (
  left: readonly string[],
  right: readonly string[],
) => {
  const l = [...left].sort();
  const r = [...right].sort();
  return l.length === r.length && l.every((v, i) => v === r[i]);
};

export const PhoneNumberProvider = () =>
  Provider.effect(
    PhoneNumber,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (phoneNumberId: string) {
        const result = yield* smsvoice
          .describePhoneNumbers({ PhoneNumberIds: [phoneNumberId] })
          .pipe(
            retrySmsVoiceThrottled,
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return result?.PhoneNumbers?.find(
          (p) => p.PhoneNumberId === phoneNumberId,
        );
      });

      return {
        stables: [
          "phoneNumberId",
          "phoneNumberArn",
          "phoneNumber",
          "isoCountryCode",
          "numberType",
        ],

        read: Effect.fn(function* ({ id, output }) {
          // Phone number IDs are assigned by AWS — without a cached output
          // there is no deterministic identity to look up.
          if (output?.phoneNumberId === undefined) return undefined;
          const observed = yield* getById(output.phoneNumberId);
          if (observed === undefined) return undefined;
          const attrs = yield* toAttrs(observed);
          const tags = yield* readSmsVoiceTags(observed.PhoneNumberArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (
            olds.isoCountryCode !== news.isoCountryCode ||
            olds.messageType !== news.messageType ||
            olds.numberType !== news.numberType ||
            !sameCapabilities(
              olds.numberCapabilities ?? [],
              news.numberCapabilities,
            )
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — the ID cache in `output` is the only identity.
          let observed =
            output?.phoneNumberId === undefined
              ? undefined
              : yield* getById(output.phoneNumberId);

          // 2. Ensure — request a number if missing, then wait out PENDING.
          if (observed === undefined) {
            const requested = yield* smsvoice
              .requestPhoneNumber({
                IsoCountryCode: news.isoCountryCode,
                MessageType: news.messageType,
                NumberCapabilities: news.numberCapabilities,
                NumberType: news.numberType,
                OptOutListName: news.optOutListName,
                DeletionProtectionEnabled: news.deletionProtectionEnabled,
                Tags: toTagList(desiredTags),
              })
              .pipe(retrySmsVoiceThrottled);
            if (requested.PhoneNumberId === undefined) {
              return yield* Effect.fail(
                new SmsVoicePhoneNumberMissing({
                  message: "RequestPhoneNumber returned no PhoneNumberId",
                }),
              );
            }
            observed = yield* getById(requested.PhoneNumberId).pipe(
              untilNotPending,
            );
          }
          if (observed === undefined || observed.PhoneNumberId === undefined) {
            return yield* Effect.fail(
              new SmsVoicePhoneNumberMissing({
                message: "phone number not observable after request",
              }),
            );
          }
          const phoneNumberId = observed.PhoneNumberId;

          // 3. Sync — apply a single update carrying only the drifted
          // aspects (opt-out list, deletion protection). Fields the API
          // couples to unmodeled features (e.g. self-managed opt-outs
          // require a two-way channel) are never sent.
          const desiredProtection = news.deletionProtectionEnabled ?? false;
          const optOutDrift =
            news.optOutListName !== undefined &&
            observed.OptOutListName !== news.optOutListName;
          const protectionDrift =
            observed.DeletionProtectionEnabled !== desiredProtection;
          if (optOutDrift || protectionDrift) {
            yield* smsvoice
              .updatePhoneNumber({
                PhoneNumberId: phoneNumberId,
                OptOutListName: optOutDrift ? news.optOutListName : undefined,
                DeletionProtectionEnabled: protectionDrift
                  ? desiredProtection
                  : undefined,
              })
              .pipe(retrySmsVoiceThrottled);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncSmsVoiceTags(observed.PhoneNumberArn, desiredTags);

          // 4. Return fresh attributes.
          const final = yield* getById(phoneNumberId);
          if (final === undefined) {
            return yield* Effect.fail(
              new SmsVoicePhoneNumberMissing({
                message: `phone number '${phoneNumberId}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(final.PhoneNumberArn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* smsvoice
            .releasePhoneNumber({ PhoneNumberId: output.phoneNumberId })
            .pipe(
              retrySmsVoiceThrottled,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.asVoid,
            );
        }),

        list: () =>
          smsvoice.describePhoneNumbers.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap(
              Effect.forEach(
                (info) =>
                  toAttrs(info).pipe(
                    // Tolerate a number missing its ID — drop it.
                    Effect.catchTag("SmsVoicePhoneNumberMissing", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
