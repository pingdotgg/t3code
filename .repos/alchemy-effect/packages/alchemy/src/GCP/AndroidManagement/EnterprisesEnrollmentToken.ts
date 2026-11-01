import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_DURATION,
  getEnrollmentToken,
  jsonEqual,
  lastSegment,
  parentOf,
  replaceOnIdentity,
  toEnterpriseName,
  toEnrollmentTokenName,
} from "./internal.ts";

export type EnterprisesEnrollmentTokenProps = {
  /**
   * Parent enterprise (`enterprises/{enterprise}` or `{enterprise}`).
   * Immutable — changing it replaces the token.
   */
  parent: string;
  /**
   * Policy initially applied to the enrolled device
   * (`enterprises/{enterprise}/policies/{policy}` or `{policy}`).
   * Immutable — changing it replaces the token.
   */
  policyName?: string;
  /**
   * Whether personal usage is allowed on a device provisioned with this
   * token. Immutable — changing it replaces the token.
   */
  allowPersonalUsage?:
    | androidmanagement.EnrollmentTokenAllowPersonalUsageEnum
    | (string & {});
  /**
   * Google authentication options during enrollment. Immutable —
   * changing them replaces the token.
   */
  googleAuthenticationOptions?: androidmanagement.GoogleAuthenticationOptions;
  /**
   * One-time-use token. Immutable — changing it replaces the token.
   */
  oneTimeOnly?: boolean;
  /**
   * Token lifetime as a duration string (for example `3600s`). Defaults
   * to ten years so the resource stays usable until deleted.
   * Immutable — changing it replaces the token.
   * @default "315360000s"
   */
  duration?: string;
  /**
   * Arbitrary data exposed on the Device after enrollment (max 1024
   * characters). List/get return only a partial view and omit this
   * field. Immutable — changing it replaces the token.
   */
  additionalData?: string;
};

export type EnterprisesEnrollmentToken = Resource<
  "GCP.AndroidManagement.EnterprisesEnrollmentToken",
  EnterprisesEnrollmentTokenProps,
  {
    /** Resource name `enterprises/{enterprise}/enrollmentTokens/{token}`. */
    name: string;
    /** Token id (last path segment). */
    enrollmentTokenId: string;
    /** Parent enterprise name. */
    parent: string;
    /** Project id used when the token was reconciled. */
    project: string;
    /** Initial policy name. */
    policyName: string | undefined;
    /** Personal-usage setting. */
    allowPersonalUsage: string | undefined;
    /** Google authentication options. */
    googleAuthenticationOptions:
      | androidmanagement.GoogleAuthenticationOptions
      | undefined;
    /** One-time-use flag. */
    oneTimeOnly: boolean | undefined;
    /** Requested lifetime. */
    duration: string | undefined;
    /** Additional data exposed on the enrolled device. */
    additionalData: string | undefined;
    /** Token value passed to the device. */
    value: string | undefined;
    /** QR code payload for enrollment. */
    qrCode: string | undefined;
    /** RFC3339 expiration timestamp. */
    expirationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Android Management enrollment token.
 *
 * Tokens are create-only (no patch API). Identity is the parent
 * enterprise plus the server-assigned name. Changing parent, policy,
 * duration, personal-usage, or additional data replaces the token.
 * List/get return a partial view (`name`, `expirationTimestamp`,
 * `allowPersonalUsage`, `value`, `qrCode`) and tokens have no labels,
 * so Alchemy tracks a token only by the name recorded in state.
 *
 * ### Creating an Enrollment Token
 * **Example:** Long-lived token
 * ```typescript
 * const token = yield* GCP.AndroidManagement.EnterprisesEnrollmentToken(
 *   "Enroll",
 *   { parent: enterprise.name },
 * );
 * ```
 *
 * **Example:** One-time token for a policy
 * ```typescript
 * const token = yield* GCP.AndroidManagement.EnterprisesEnrollmentToken(
 *   "Enroll",
 *   {
 *     parent: enterprise.name,
 *     policyName: "default",
 *     oneTimeOnly: true,
 *     duration: "86400s",
 *   },
 * );
 * ```
 *
 * @resource
 * @category AndroidManagement
 */
export const EnterprisesEnrollmentToken = Resource<EnterprisesEnrollmentToken>(
  "GCP.AndroidManagement.EnterprisesEnrollmentToken",
);

const toAttrs = (
  token: androidmanagement.EnrollmentToken,
  project: string,
  extras?: {
    parent?: string;
    policyName?: string;
    googleAuthenticationOptions?: androidmanagement.GoogleAuthenticationOptions;
    oneTimeOnly?: boolean;
    duration?: string;
    additionalData?: string;
  },
) => {
  const name = token.name ?? "";
  return {
    name,
    enrollmentTokenId: lastSegment(name),
    parent: extras?.parent ?? parentOf(name),
    project,
    policyName: extras?.policyName ?? token.policyName,
    allowPersonalUsage: token.allowPersonalUsage,
    googleAuthenticationOptions:
      extras?.googleAuthenticationOptions ?? token.googleAuthenticationOptions,
    oneTimeOnly: extras?.oneTimeOnly ?? token.oneTimeOnly,
    duration: extras?.duration ?? token.duration,
    additionalData: extras?.additionalData ?? token.additionalData,
    value: token.value,
    qrCode: token.qrCode,
    expirationTimestamp: token.expirationTimestamp,
  };
};

export const EnterprisesEnrollmentTokenProvider = () =>
  Provider.succeed(EnterprisesEnrollmentToken, {
    stables: [
      "name",
      "enrollmentTokenId",
      "parent",
      "project",
      "expirationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const identity = replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        extra:
          (news.policyName !== undefined &&
            olds?.policyName !== undefined &&
            news.policyName !== olds.policyName) ||
          (news.duration !== undefined &&
            olds?.duration !== undefined &&
            news.duration !== olds.duration) ||
          (news.oneTimeOnly !== undefined &&
            olds?.oneTimeOnly !== undefined &&
            news.oneTimeOnly !== olds.oneTimeOnly) ||
          (news.allowPersonalUsage !== undefined &&
            output?.allowPersonalUsage !== undefined &&
            news.allowPersonalUsage !== output.allowPersonalUsage) ||
          (news.additionalData !== undefined &&
            olds?.additionalData !== undefined &&
            news.additionalData !== olds.additionalData) ||
          (news.googleAuthenticationOptions !== undefined &&
            olds?.googleAuthenticationOptions !== undefined &&
            !jsonEqual(
              news.googleAuthenticationOptions,
              olds.googleAuthenticationOptions,
            )),
      });
      return identity;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const existing = yield* getEnrollmentToken(output?.name ?? "");
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, {
        parent,
        policyName: olds?.policyName ?? output?.policyName,
        googleAuthenticationOptions:
          olds?.googleAuthenticationOptions ??
          output?.googleAuthenticationOptions,
        oneTimeOnly: olds?.oneTimeOnly ?? output?.oneTimeOnly,
        duration: olds?.duration ?? output?.duration,
        additionalData: olds?.additionalData ?? output?.additionalData,
      });
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toEnterpriseName(news.parent);
      const additionalData = news.additionalData;
      const duration = news.duration ?? output?.duration ?? DEFAULT_DURATION;
      const desired: androidmanagement.EnrollmentToken = {
        policyName: news.policyName,
        allowPersonalUsage: news.allowPersonalUsage,
        googleAuthenticationOptions: news.googleAuthenticationOptions,
        oneTimeOnly: news.oneTimeOnly,
        duration,
        additionalData,
      };

      let current = yield* getEnrollmentToken(
        toEnrollmentTokenName(parent, output?.name),
      );

      if (current === undefined) {
        current = yield* androidmanagement.createEnterprisesEnrollmentTokens({
          parent,
          body: desired,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const fresh = (yield* getEnrollmentToken(name)) ?? current;
      return toAttrs(fresh, env.project, {
        parent,
        policyName: news.policyName ?? output?.policyName,
        googleAuthenticationOptions:
          news.googleAuthenticationOptions ??
          output?.googleAuthenticationOptions,
        oneTimeOnly: news.oneTimeOnly ?? output?.oneTimeOnly,
        duration,
        additionalData,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* androidmanagement
        .deleteEnterprisesEnrollmentTokens({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
