import * as signer from "@distilled.cloud/aws/signer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The signing certificate used to sign code. Required for platforms that
 * sign with an ACM certificate (e.g. `AWSIoTDeviceManagement-SHA256-ECDSA`);
 * the `AWSLambda-*` platforms use AWS-managed signing material and do not
 * accept one.
 */
export interface SigningMaterial {
  /**
   * The ARN of an AWS Certificate Manager (ACM) certificate used to sign
   * code.
   */
  certificateArn: string;
}

/**
 * How long a signature produced by this profile remains valid.
 */
export interface SignatureValidityPeriod {
  /**
   * The numerical value of the validity period.
   * @default 135
   */
  value?: number;

  /**
   * The unit of the validity period.
   * @default "MONTHS"
   */
  type?: "DAYS" | "MONTHS" | "YEARS";
}

/**
 * Overrides applied to the signing configuration of the chosen platform.
 */
export interface SigningPlatformOverrides {
  /**
   * Overrides for the platform's default encryption/hash algorithms.
   */
  signingConfiguration?: {
    /** The encryption algorithm used to sign code (`RSA` or `ECDSA`). */
    encryptionAlgorithm?: "RSA" | "ECDSA";
    /** The hash algorithm used to sign code (`SHA1` or `SHA256`). */
    hashAlgorithm?: "SHA1" | "SHA256";
  };

  /**
   * The signed image format for the platform, e.g. `JSONEmbedded`.
   */
  signingImageFormat?: string;
}

export interface SigningProfileProps {
  /**
   * Name of the signing profile. Must match `^[a-zA-Z0-9_]{2,64}$` (letters,
   * digits, and underscores only — no hyphens). If omitted, a unique
   * underscore-delimited name is generated. Changing it replaces the profile.
   */
  profileName?: string;

  /**
   * The ID of the signing platform, e.g. `AWSLambda-SHA384-ECDSA` for Lambda
   * code signing. Changing it replaces the profile.
   */
  platformId: string;

  /**
   * The ACM certificate used to sign code. Only for platforms that sign with
   * a customer-provided certificate; omit for the `AWSLambda-*` platforms.
   * Changing it replaces the profile.
   */
  signingMaterial?: SigningMaterial;

  /**
   * How long signatures produced by this profile stay valid.
   * Changing it replaces the profile.
   * @default 135 MONTHS
   */
  signatureValidityPeriod?: SignatureValidityPeriod;

  /**
   * Overrides of the platform's default signing configuration.
   * Changing them replaces the profile.
   */
  overrides?: SigningPlatformOverrides;

  /**
   * Map of key-value pairs for signing, attached as-is to every signing job
   * started with this profile. Changing them replaces the profile. Rejected
   * by the `AWSLambda-*` platforms ("Signing parameters should not be
   * present when using AWSLambda-SHA384-ECDSA platform").
   */
  signingParameters?: Record<string, string>;

  /**
   * User tags to attach to the signing profile. Tags are the only mutable
   * aspect of a signing profile.
   */
  tags?: Record<string, string>;
}

export interface SigningProfile extends Resource<
  "AWS.Signer.SigningProfile",
  SigningProfileProps,
  {
    /** The name of the signing profile. */
    profileName: string;
    /** The ARN of the signing profile (unversioned). */
    arn: string;
    /** The current version of the signing profile. */
    profileVersion: string;
    /** The ARN of the current signing profile version. */
    profileVersionArn: string;
    /** The ID of the signing platform. */
    platformId: string;
    /** The status of the signing profile (`Active`, `Canceled`, `Revoked`). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Signer signing profile — a code-signing template (platform +
 * signing material + signature validity) used to sign code, most commonly
 * as the trust anchor for Lambda code signing configs.
 *
 * `PutSigningProfile` is create-only in practice (re-putting an existing
 * name fails with "Profile with name X already exists"), so every property
 * except tags is immutable — changing one replaces the profile under a new
 * generated name. On destroy the profile is canceled — AWS retains canceled
 * profiles (the name stays reserved) and deletes them per its data-retention
 * policy, so prefer generated names over fixed `profileName`s.
 *
 * @resource
 * @section Creating a Signing Profile
 * @example Lambda Code-Signing Profile
 * ```typescript
 * const profile = yield* Signer.SigningProfile("release-profile", {
 *   platformId: "AWSLambda-SHA384-ECDSA",
 * });
 * ```
 *
 * @example Profile with Signature Validity Period
 * ```typescript
 * const profile = yield* Signer.SigningProfile("release-profile", {
 *   platformId: "AWSLambda-SHA384-ECDSA",
 *   signatureValidityPeriod: { value: 12, type: "MONTHS" },
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const SigningProfile = Resource<SigningProfile>(
  "AWS.Signer.SigningProfile",
);

/**
 * Signer profile names accept only `[a-zA-Z0-9_]` — coerce any other
 * character (hyphens from stack/stage names, etc.) to an underscore.
 */
const sanitizeProfileName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_]/g, "_");

/** Coerce a distilled TagMap (values possibly undefined) to a plain record. */
const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) record[key] = value;
  }
  return record;
};

export const SigningProfileProvider = () =>
  Provider.effect(
    SigningProfile,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<SigningProfileProps, "profileName">,
      ) {
        return (
          props.profileName ??
          sanitizeProfileName(
            yield* createPhysicalName({ id, delimiter: "_", maxLength: 64 }),
          )
        );
      });

      const getProfile = (profileName: string) =>
        signer
          .getSigningProfile({ profileName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttributes = (
        profileName: string,
        live: signer.GetSigningProfileResponse,
      ) => ({
        profileName,
        arn: live.arn!,
        profileVersion: live.profileVersion!,
        profileVersionArn: live.profileVersionArn!,
        platformId: live.platformId!,
        status: (live.status ?? "Active") as string,
      });

      return SigningProfile.Provider.of({
        // Updates only sync tags (all other props replace), so every
        // identifying attribute — including the version — is update-stable.
        stables: [
          "profileName",
          "arn",
          "profileVersion",
          "profileVersionArn",
          "platformId",
        ],

        list: () =>
          signer.listSigningProfiles.pages({ includeCanceled: false }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.profiles ?? [])
                  .filter(
                    (p) =>
                      p.profileName != null &&
                      p.arn != null &&
                      p.profileVersion != null &&
                      p.profileVersionArn != null &&
                      p.platformId != null,
                  )
                  .map((p) => ({
                    profileName: p.profileName!,
                    arn: p.arn!,
                    profileVersion: p.profileVersion!,
                    profileVersionArn: p.profileVersionArn!,
                    platformId: p.platformId!,
                    status: (p.status ?? "Active") as string,
                  })),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const profileName =
            output?.profileName ?? (yield* createName(id, olds ?? {}));
          const live = yield* getProfile(profileName);
          // Canceled/revoked profiles cannot sign — treat them as deleted so
          // a re-deploy publishes a fresh active version.
          if (live === undefined || live.status !== "Active") return undefined;
          const attrs = toAttributes(profileName, live);
          const tags = toTagRecord(live.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // PutSigningProfile is create-only (re-putting an existing name
          // fails with "already exists"), so every property except tags is
          // immutable — any change replaces the profile. Mirrors
          // CloudFormation, where all AWS::Signer::SigningProfile properties
          // trigger replacement.
          if (
            olds.platformId !== news.platformId ||
            JSON.stringify(olds.signatureValidityPeriod ?? null) !==
              JSON.stringify(news.signatureValidityPeriod ?? null) ||
            JSON.stringify(olds.signingParameters ?? null) !==
              JSON.stringify(news.signingParameters ?? null) ||
            JSON.stringify(olds.signingMaterial ?? null) !==
              JSON.stringify(news.signingMaterial ?? null) ||
            JSON.stringify(olds.overrides ?? null) !==
              JSON.stringify(news.overrides ?? null)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const profileName =
            output?.profileName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // OBSERVE — cloud state is authoritative; output is only a cache
          let live = yield* getProfile(profileName);

          // ENSURE — PutSigningProfile is create-only in practice: re-putting
          // an existing name (even Active with identical config) fails with
          // "Profile with name X already exists". Every property except tags
          // is therefore immutable and handled by diff → replace; here we
          // only create when the profile is missing.
          if (live === undefined) {
            yield* signer
              .putSigningProfile({
                profileName,
                platformId: news.platformId,
                signingMaterial: news.signingMaterial,
                signatureValidityPeriod: news.signatureValidityPeriod,
                overrides: news.overrides,
                signingParameters: news.signingParameters,
                tags: desiredTags,
              })
              .pipe(
                // Race with a concurrent create — fall through to re-observe.
                Effect.catchTag(
                  "SigningProfileAlreadyExists",
                  () => Effect.void,
                ),
              );
            live = yield* getProfile(profileName);
          }
          if (live === undefined) {
            // Extremely unlikely read-after-write miss; surface loudly.
            return yield* Effect.fail(
              new signer.ResourceNotFoundException({
                message: `signing profile ${profileName} not visible after PutSigningProfile`,
              }),
            );
          }
          if (live.status !== "Active") {
            // The name is tombstoned by a canceled/revoked profile — Signer
            // reserves canceled names, so the profile cannot be recreated
            // under this name. Only reachable with a user-fixed profileName
            // (generated names get a fresh random suffix per instance).
            return yield* Effect.fail(
              new signer.SigningProfileAlreadyExists({
                message: `signing profile ${profileName} exists with status ${live.status}; canceled profile names stay reserved — use a different profileName (or omit it to generate one)`,
              }),
            );
          }

          // SYNC TAGS — diff against OBSERVED cloud tags (adoption may bring
          // foreign tags; put only applies tags on first creation).
          const observedTags = toTagRecord(live.tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* signer.tagResource({
              resourceArn: live.arn!,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* signer.untagResource({
              resourceArn: live.arn!,
              tagKeys: removed,
            });
          }

          yield* session.note(profileName);
          return toAttributes(profileName, live);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Signing profiles cannot be deleted directly — cancel deactivates
          // them and AWS deletes canceled profiles per its data-retention
          // policy. Cancel is idempotent (re-canceling a canceled profile
          // succeeds); a missing profile is not an error.
          yield* signer
            .cancelSigningProfile({ profileName: output.profileName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
