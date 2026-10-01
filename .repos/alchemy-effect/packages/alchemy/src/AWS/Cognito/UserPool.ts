import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * Password complexity requirements enforced by the user pool at sign-up and
 * password change.
 */
export interface UserPoolPasswordPolicy {
  /**
   * Minimum password length (6-99).
   * @default 8
   */
  minimumLength?: number;
  /**
   * Require at least one uppercase letter.
   * @default true
   */
  requireUppercase?: boolean;
  /**
   * Require at least one lowercase letter.
   * @default true
   */
  requireLowercase?: boolean;
  /**
   * Require at least one number.
   * @default true
   */
  requireNumbers?: boolean;
  /**
   * Require at least one symbol.
   * @default true
   */
  requireSymbols?: boolean;
  /**
   * Number of previous passwords a user cannot reuse. Requires the
   * `ESSENTIALS` or `PLUS` feature tier.
   */
  passwordHistorySize?: number;
  /**
   * How long an admin-set temporary password stays valid, e.g.
   * `"7 days"` (0-365 days). Rounded to whole days on the wire
   * (`TemporaryPasswordValidityDays`).
   * @default 7 days
   */
  temporaryPasswordValidity?: Duration.Input;
}

/**
 * A custom schema attribute added to the user pool. Custom attributes are
 * automatically prefixed with `custom:` by Cognito. Attributes can be added
 * to an existing pool but never removed or changed — removing or modifying a
 * declared attribute triggers a replacement.
 */
export interface UserPoolSchemaAttribute {
  /**
   * Attribute name (without the `custom:` prefix; Cognito adds it).
   * 1-20 characters.
   */
  name: string;
  /**
   * The data type of the attribute.
   * @default "String"
   */
  attributeDataType?: "String" | "Number" | "DateTime" | "Boolean";
  /**
   * Whether users can change the value after it is set.
   * @default true
   */
  mutable?: boolean;
  /**
   * Whether the attribute is required at sign-up. Custom attributes cannot
   * be required.
   * @default false
   */
  required?: boolean;
  /**
   * Min/max length constraints for `String` attributes (stringified numbers,
   * matching the Cognito wire format).
   */
  stringConstraints?: { minLength?: string; maxLength?: string };
  /**
   * Min/max value constraints for `Number` attributes (stringified numbers,
   * matching the Cognito wire format).
   */
  numberConstraints?: { minValue?: string; maxValue?: string };
  /**
   * Developer-only attributes can only be modified with IAM credentials
   * (prefixed `dev:` in addition to `custom:`).
   * @default false
   */
  developerOnlyAttribute?: boolean;
}

/**
 * The user pool Lambda trigger slots that take a plain function ARN — the
 * string-valued keys of the pool's `LambdaConfig`. The versioned custom
 * sender slots are configured separately: `CustomEmailSender` through
 * {@link UserPoolProps.customEmailSender} (+ `kmsKeyId`); `CustomSMSSender`
 * is not modelled yet (an observed one is preserved, never cleared).
 */
export type UserPoolTriggerName =
  | "PreSignUp"
  | "PostConfirmation"
  | "PreAuthentication"
  | "PostAuthentication"
  | "CustomMessage"
  | "DefineAuthChallenge"
  | "CreateAuthChallenge"
  | "VerifyAuthChallengeResponse"
  | "PreTokenGeneration"
  | "UserMigration";

const USER_POOL_TRIGGER_NAMES: readonly UserPoolTriggerName[] = [
  "PreSignUp",
  "PostConfirmation",
  "PreAuthentication",
  "PostAuthentication",
  "CustomMessage",
  "DefineAuthChallenge",
  "CreateAuthChallenge",
  "VerifyAuthChallengeResponse",
  "PreTokenGeneration",
  "UserMigration",
];

/**
 * Lambda trigger configuration for the pool: each key is a trigger slot,
 * each value the ARN of the Lambda function Cognito invokes for it.
 * Usually populated through the trigger event source
 * (`Cognito.onPreSignUp(pool, ...)` etc.) rather than declared directly.
 */
export interface UserPoolLambdaConfig extends Partial<
  Record<UserPoolTriggerName, string>
> {}

/**
 * The binding contract of a user pool: event sources contribute
 * `LambdaConfig` trigger entries (trigger slot → function ARN) that the
 * provider merges with `props.lambdaConfig` and syncs onto the pool.
 */
export interface UserPoolBinding {
  /** Trigger entries injected by `Cognito.onUserPoolTrigger` and friends. */
  lambdaConfig?: UserPoolLambdaConfig;
}

/**
 * Two different Lambda functions were registered for the same user pool
 * trigger slot — Cognito supports exactly one function per trigger.
 */
export class ConflictingUserPoolTrigger extends Data.TaggedError(
  "ConflictingUserPoolTrigger",
)<{
  readonly trigger: string;
  readonly functionArns: readonly string[];
}> {}

/**
 * The user pool's configuration is internally inconsistent (e.g. a custom
 * email sender without the KMS key Cognito needs to encrypt the codes it
 * hands to the function). Raised before any API call is made.
 */
export class InvalidUserPoolConfiguration extends Data.TaggedError(
  "InvalidUserPoolConfiguration",
)<{
  readonly reason: string;
}> {}

/**
 * A first-factor sign-in method for choice-based authentication.
 */
export type UserPoolAuthFactor =
  | "PASSWORD"
  | "EMAIL_OTP"
  | "SMS_OTP"
  | "WEB_AUTHN";

/**
 * The sign-in policy of the pool — which first-factor authentication
 * methods users may start with (choice-based authentication). Requires the
 * `ESSENTIALS` or `PLUS` feature tier.
 */
export interface UserPoolSignInPolicy {
  /**
   * First-factor sign-in methods the pool allows. `PASSWORD` is the
   * classic username + password flow; `EMAIL_OTP` / `SMS_OTP` send a
   * one-time code (email OTP is delivered through `customEmailSender` when
   * one is configured); `WEB_AUTHN` is passkey sign-in.
   * Passwordless factors require the `ESSENTIALS` or `PLUS` tier.
   */
  allowedFirstAuthFactors?: UserPoolAuthFactor[];
}

/**
 * The `CustomEmailSender` Lambda trigger: Cognito invokes this function
 * instead of sending email itself, passing the verification / OTP code
 * encrypted with `kmsKeyId` (decrypt it with the AWS Encryption SDK).
 * Requires {@link UserPoolProps.kmsKeyId}. The function must also grant
 * `cognito-idp.amazonaws.com` invoke access (`AWS.Lambda.Permission`).
 */
export interface UserPoolCustomEmailSender {
  /** ARN of the Lambda function that delivers the pool's email messages. */
  lambdaArn: string;
  /**
   * The custom sender event version the function understands.
   * @default "V1_0"
   */
  lambdaVersion?: "V1_0";
}

/**
 * How the user pool delivers its email messages (verification codes, OTPs,
 * invitations): either Cognito's built-in, rate-limited delivery
 * (`COGNITO_DEFAULT`) or your own verified Amazon SES identity
 * (`DEVELOPER`). With `DEVELOPER`, the SES identity's policy must grant
 * `cognito-idp.amazonaws.com` permission to send
 * (`SES.EmailIdentityPolicy`).
 */
export interface UserPoolEmailConfiguration {
  /**
   * Which sending account delivers the pool's email. `COGNITO_DEFAULT`
   * uses Cognito's built-in delivery (limited daily volume);
   * `DEVELOPER` sends through your own SES identity (`sourceArn`
   * required) at your SES quota.
   * @default "COGNITO_DEFAULT"
   */
  emailSendingAccount?: "COGNITO_DEFAULT" | "DEVELOPER";
  /**
   * ARN of a verified SES email identity (address or domain) in a
   * supported region. Required when `emailSendingAccount` is `DEVELOPER`;
   * with `COGNITO_DEFAULT` it customizes the FROM address while Cognito
   * still handles delivery.
   */
  sourceArn?: string;
  /**
   * The FROM address, either bare (`no-reply@example.com`) or with a
   * friendly display name (`"My App <no-reply@example.com>"`). Must be
   * covered by the `sourceArn` identity.
   */
  from?: string;
  /**
   * The destination for replies to the pool's messages.
   */
  replyToEmailAddress?: string;
  /**
   * Name of an SES configuration set applied to email sent by the pool
   * (event publishing, IP pool selection). `DEVELOPER` only.
   */
  configurationSet?: string;
}

/**
 * An account recovery mechanism with its priority (1 is highest).
 */
export interface UserPoolRecoveryMechanism {
  /** Recovery channel. */
  name: "verified_email" | "verified_phone_number" | "admin_only";
  /** Priority of this mechanism; 1 is tried first. */
  priority: number;
}

export interface UserPoolProps {
  /**
   * Name of the user pool. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID.
   */
  poolName?: string;
  /**
   * Password complexity policy for the pool.
   */
  passwordPolicy?: UserPoolPasswordPolicy;
  /**
   * Attributes users may sign in with *instead of* a username
   * (`email` and/or `phone_number`). When set, Cognito generates an
   * immutable UUID username and the listed attributes become sign-in
   * identifiers. Mutually exclusive with `aliasAttributes`.
   * Changing this triggers a replacement.
   */
  usernameAttributes?: ("email" | "phone_number")[];
  /**
   * Attributes that may be used as sign-in aliases *in addition to* the
   * username (`email`, `phone_number`, `preferred_username`). Mutually
   * exclusive with `usernameAttributes`. Changing this triggers a
   * replacement.
   */
  aliasAttributes?: ("email" | "phone_number" | "preferred_username")[];
  /**
   * Attributes Cognito verifies automatically by sending a code
   * (`email` and/or `phone_number`). `phone_number` requires SMS (SNS)
   * configuration.
   */
  autoVerifiedAttributes?: ("email" | "phone_number")[];
  /**
   * Custom schema attributes. Attributes may be added to an existing pool;
   * removing or changing a declared attribute triggers a replacement.
   */
  schema?: UserPoolSchemaAttribute[];
  /**
   * Choice-based authentication: the first-factor sign-in methods users may
   * start with (`PASSWORD`, `EMAIL_OTP`, `SMS_OTP`, `WEB_AUTHN`). Requires
   * the `ESSENTIALS` or `PLUS` tier when any passwordless factor is listed.
   * When omitted the observed policy is left untouched.
   */
  signInPolicy?: UserPoolSignInPolicy;
  /**
   * Multi-factor authentication mode. `ON` requires SMS or TOTP setup for
   * every user; avoid SMS-based MFA unless the account has SNS spend
   * entitlements.
   * @default "OFF"
   */
  mfaConfiguration?: "OFF" | "OPTIONAL" | "ON";
  /**
   * Account recovery mechanisms in priority order.
   * @default verified_email then verified_phone_number
   */
  accountRecovery?: UserPoolRecoveryMechanism[];
  /**
   * When true the pool cannot be deleted until protection is disabled.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * When true, only administrators (via `AdminCreateUser`) can create
   * users — public `SignUp` is disabled.
   * @default false
   */
  adminCreateUserOnly?: boolean;
  /**
   * Whether usernames are case sensitive. Changing this triggers a
   * replacement.
   * @default true (the API default)
   */
  usernameCaseSensitive?: boolean;
  /**
   * The feature tier of the user pool.
   * @default "ESSENTIALS"
   */
  tier?: "LITE" | "ESSENTIALS" | "PLUS";
  /**
   * Lambda trigger configuration (trigger slot → function ARN). Merged with
   * trigger entries injected through the binding contract by
   * `Cognito.onUserPoolTrigger` / `onPreSignUp` / etc. — prefer those over
   * declaring ARNs here, since the event source also creates the invoke
   * Permission and registers the runtime handler.
   */
  lambdaConfig?: UserPoolLambdaConfig;
  /**
   * Route the pool's email messages (sign-up / OTP / recovery codes,
   * temporary passwords) through your own Lambda function instead of
   * Cognito's built-in delivery. Requires `kmsKeyId`. Omitting this on an
   * existing pool clears the custom sender (Cognito falls back to its own
   * email delivery); ordinary triggers and the other pool settings are
   * never affected by adding or removing it.
   */
  customEmailSender?: UserPoolCustomEmailSender;
  /**
   * How the pool delivers its email messages: Cognito's built-in delivery
   * (`COGNITO_DEFAULT`, the service default) or a verified SES identity
   * (`DEVELOPER`) — no custom sender Lambda required. When omitted, an
   * observed email configuration is preserved rather than reset to the
   * service default.
   */
  emailConfiguration?: UserPoolEmailConfiguration;
  /**
   * ARN of the symmetric KMS key Cognito uses to encrypt the codes it
   * passes to the custom sender function(s) (`LambdaConfig.KMSKeyID`).
   * The principal running the deploy must hold `kms:CreateGrant` on the
   * key — Cognito creates a grant against it when the pool is configured —
   * and the sender function's role needs `kms:Decrypt`.
   */
  kmsKeyId?: string;
  /**
   * Tags to apply to the user pool. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface UserPool extends Resource<
  "AWS.Cognito.UserPool",
  UserPoolProps,
  {
    /** The generated ID of the user pool, e.g. `us-west-2_AbCdEfGhI`. */
    userPoolId: string;
    /** The ARN of the user pool. */
    userPoolArn: string;
    /** The name of the user pool. */
    userPoolName: string;
  },
  UserPoolBinding,
  Providers
> {}

/**
 * An Amazon Cognito user pool — a managed user directory that handles
 * sign-up, sign-in, and token issuance (OIDC-compliant JWTs) for your
 * application.
 * ### Creating a User Pool
 * **Example:** Basic User Pool
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * ```
 *
 * **Example:** Email Sign-In with Password Policy
 * ```typescript
 * const pool = yield* Cognito.UserPool("Users", {
 *   usernameAttributes: ["email"],
 *   autoVerifiedAttributes: ["email"],
 *   passwordPolicy: {
 *     minimumLength: 12,
 *     requireSymbols: false,
 *   },
 * });
 * ```
 *
 * **Example:** Admin-Only User Creation
 * ```typescript
 * const pool = yield* Cognito.UserPool("Users", {
 *   adminCreateUserOnly: true,
 *   accountRecovery: [{ name: "admin_only", priority: 1 }],
 * });
 * ```
 *
 * ### Custom Attributes
 * **Example:** Pool with Custom Schema Attributes
 * ```typescript
 * const pool = yield* Cognito.UserPool("Users", {
 *   schema: [
 *     { name: "tenantId", mutable: false },
 *     { name: "plan", attributeDataType: "String" },
 *   ],
 * });
 * ```
 *
 * ### Sending Email Through SES
 * **Example:** OTP and Verification Email from a Verified SES Identity
 * ```typescript
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 * });
 * // allow Cognito to send through the identity
 * yield* SES.EmailIdentityPolicy("CognitoSend", {
 *   emailIdentity: identity.emailIdentity,
 *   policyName: "cognito",
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "cognito-idp.amazonaws.com" },
 *       Action: ["ses:SendEmail", "ses:SendRawEmail"],
 *       Resource: identity.identityArn,
 *     }],
 *   },
 * });
 * const pool = yield* Cognito.UserPool("Users", {
 *   usernameAttributes: ["email"],
 *   autoVerifiedAttributes: ["email"],
 *   emailConfiguration: {
 *     emailSendingAccount: "DEVELOPER",
 *     sourceArn: identity.identityArn,
 *     from: "My App <no-reply@mail.example.com>",
 *     replyToEmailAddress: "support@example.com",
 *   },
 * });
 * ```
 *
 * ### Email OTP with a Custom Email Sender
 * **Example:** Passwordless Email OTP Delivered by Your Own Lambda
 * ```typescript
 * const key = yield* KMS.Key("CodeKey", {});
 * const sender = yield* Lambda.Function("EmailSender", {
 *   main: import.meta.url,
 * });
 * yield* Lambda.Permission("CognitoInvoke", {
 *   functionName: sender.functionName,
 *   action: "lambda:InvokeFunction",
 *   principal: "cognito-idp.amazonaws.com",
 * });
 * const pool = yield* Cognito.UserPool("Auth", {
 *   tier: "ESSENTIALS",
 *   usernameAttributes: ["email"],
 *   signInPolicy: { allowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] },
 *   customEmailSender: { lambdaArn: sender.functionArn },
 *   kmsKeyId: key.keyArn,
 * });
 * ```
 *
 * ### App Clients and Auth
 * **Example:** Pool with an App Client
 * ```typescript
 * const pool = yield* Cognito.UserPool("Users", {});
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   explicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
 * });
 * ```
 *
 * @resource
 */
export const UserPool = Resource<UserPool>("AWS.Cognito.UserPool");

/** Map camelCase password policy props to the Cognito wire shape (the wire
 * unit for `TemporaryPasswordValidityDays` is whole days). */
const toWirePasswordPolicy = (policy: UserPoolPasswordPolicy | undefined) =>
  policy === undefined
    ? undefined
    : {
        MinimumLength: policy.minimumLength,
        RequireUppercase: policy.requireUppercase,
        RequireLowercase: policy.requireLowercase,
        RequireNumbers: policy.requireNumbers,
        RequireSymbols: policy.requireSymbols,
        PasswordHistorySize: policy.passwordHistorySize,
        TemporaryPasswordValidityDays: toWireDays(
          policy.temporaryPasswordValidity,
        ),
      };

const toWireSchemaAttribute = (attribute: UserPoolSchemaAttribute) => ({
  Name: attribute.name,
  AttributeDataType: attribute.attributeDataType ?? "String",
  Mutable: attribute.mutable ?? true,
  Required: attribute.required ?? false,
  DeveloperOnlyAttribute: attribute.developerOnlyAttribute,
  StringAttributeConstraints:
    attribute.stringConstraints === undefined
      ? undefined
      : {
          MinLength: attribute.stringConstraints.minLength,
          MaxLength: attribute.stringConstraints.maxLength,
        },
  NumberAttributeConstraints:
    attribute.numberConstraints === undefined
      ? undefined
      : {
          MinValue: attribute.numberConstraints.minValue,
          MaxValue: attribute.numberConstraints.maxValue,
        },
});

const toWireAccountRecovery = (
  mechanisms: UserPoolRecoveryMechanism[] | undefined,
) =>
  mechanisms === undefined
    ? undefined
    : {
        RecoveryMechanisms: mechanisms.map((m) => ({
          Name: m.name,
          Priority: m.priority,
        })),
      };

const toWireSignInPolicy = (policy: UserPoolSignInPolicy | undefined) =>
  policy === undefined
    ? undefined
    : { AllowedFirstAuthFactors: policy.allowedFirstAuthFactors };

const toWireEmailConfiguration = (
  config: UserPoolEmailConfiguration | undefined,
): cip.EmailConfigurationType | undefined =>
  config === undefined
    ? undefined
    : {
        EmailSendingAccount: config.emailSendingAccount ?? "COGNITO_DEFAULT",
        SourceArn: config.sourceArn,
        From: config.from,
        ReplyToEmailAddress: config.replyToEmailAddress,
        ConfigurationSet: config.configurationSet,
      };

/** Observed/desired email configuration with the service default filled in,
 * for order- and absence-insensitive comparison (`JSON.stringify` drops the
 * `undefined` members on both sides). */
const normalizedEmailConfiguration = (
  config: cip.EmailConfigurationType | undefined,
) => ({
  emailSendingAccount: config?.EmailSendingAccount ?? "COGNITO_DEFAULT",
  sourceArn: config?.SourceArn,
  from: config?.From,
  replyToEmailAddress: config?.ReplyToEmailAddress,
  configurationSet: config?.ConfigurationSet,
});

const toWireCustomEmailSender = (
  sender: UserPoolCustomEmailSender | undefined,
): cip.CustomEmailLambdaVersionConfigType | undefined =>
  sender === undefined
    ? undefined
    : {
        LambdaArn: sender.lambdaArn,
        LambdaVersion: sender.lambdaVersion ?? "V1_0",
      };

const PASSWORDLESS_AUTH_FACTORS: readonly UserPoolAuthFactor[] = [
  "EMAIL_OTP",
  "SMS_OTP",
  "WEB_AUTHN",
];

/**
 * Reject configurations Cognito would refuse (or silently mangle) before
 * any API call is made.
 */
const validateProps = (props: UserPoolProps) =>
  props.customEmailSender !== undefined && props.kmsKeyId === undefined
    ? Effect.fail(
        new InvalidUserPoolConfiguration({
          reason:
            "customEmailSender requires kmsKeyId — Cognito encrypts the codes it passes to the custom sender with that KMS key",
        }),
      )
    : props.emailConfiguration?.emailSendingAccount === "DEVELOPER" &&
        props.emailConfiguration.sourceArn === undefined
      ? Effect.fail(
          new InvalidUserPoolConfiguration({
            reason:
              "emailConfiguration with emailSendingAccount DEVELOPER requires sourceArn — the ARN of the verified SES identity Cognito sends from",
          }),
        )
      : props.tier === "LITE" &&
          (props.signInPolicy?.allowedFirstAuthFactors ?? []).some((factor) =>
            PASSWORDLESS_AUTH_FACTORS.includes(factor),
          )
        ? Effect.fail(
            new InvalidUserPoolConfiguration({
              reason:
                "passwordless first-auth factors (EMAIL_OTP / SMS_OTP / WEB_AUTHN) require the ESSENTIALS or PLUS tier, not LITE",
            }),
          )
        : Effect.void;

const tagRecordOf = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * The wire name an observed pool attribute would have for a declared custom
 * schema attribute (Cognito prefixes `custom:`, or `dev:custom:` for
 * developer-only attributes).
 */
const customAttributeWireName = (attribute: UserPoolSchemaAttribute) =>
  attribute.developerOnlyAttribute
    ? `dev:custom:${attribute.name}`
    : `custom:${attribute.name}`;

const schemaAttributeChanged = (
  before: UserPoolSchemaAttribute,
  after: UserPoolSchemaAttribute,
) =>
  JSON.stringify(toWireSchemaAttribute(before)) !==
  JSON.stringify(toWireSchemaAttribute(after));

export const UserPoolProvider = () =>
  Provider.effect(
    UserPool,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<UserPoolProps, "poolName">,
      ) {
        return (
          props.poolName ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const describePool = Effect.fn(function* (userPoolId: string) {
        return yield* cip.describeUserPool({ UserPoolId: userPoolId }).pipe(
          Effect.map((r) => r.UserPool),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      /**
       * Find a pool by exact name. Pool names are not unique, so return every
       * candidate — callers disambiguate by ownership tags.
       */
      const findPoolsByName = Effect.fn(function* (name: string) {
        const pages = yield* cip.listUserPools
          .pages({ MaxResults: 60 })
          .pipe(Stream.runCollect);
        const candidates = Array.from(pages)
          .flatMap((page) => page.UserPools ?? [])
          .filter((pool) => pool.Name === name && pool.Id !== undefined);
        return yield* Effect.forEach(
          candidates,
          (candidate) => describePool(candidate.Id!),
          { concurrency: 3 },
        ).pipe(
          Effect.map((pools) => pools.filter((pool) => pool !== undefined)),
        );
      });

      const attributesOf = (pool: cip.UserPoolType) => ({
        userPoolId: pool.Id!,
        userPoolArn: pool.Arn!,
        userPoolName: pool.Name!,
      });

      /**
       * The pool's desired trigger slots: `props.lambdaConfig` merged with
       * the trigger entries contributed through the binding contract
       * (`Cognito.onUserPoolTrigger` and friends). Fails when two different
       * function ARNs target the same trigger slot.
       */
      const resolveTriggers = Effect.fn(function* (
        news: UserPoolProps,
        bindings: ReadonlyArray<UserPoolBinding | { data?: UserPoolBinding }>,
      ) {
        const merged: Partial<Record<UserPoolTriggerName, string>> = {};
        const contributions = [
          news.lambdaConfig,
          ...bindings.map(
            (binding) =>
              (binding as { data?: UserPoolBinding }).data?.lambdaConfig ??
              (binding as UserPoolBinding).lambdaConfig,
          ),
        ];
        for (const config of contributions) {
          if (config === undefined) continue;
          for (const trigger of USER_POOL_TRIGGER_NAMES) {
            const arn = config[trigger];
            if (arn === undefined) continue;
            const existing = merged[trigger];
            if (existing !== undefined && existing !== arn) {
              return yield* Effect.fail(
                new ConflictingUserPoolTrigger({
                  trigger,
                  functionArns: [existing, arn],
                }),
              );
            }
            merged[trigger] = arn;
          }
        }
        return merged as UserPoolLambdaConfig;
      });

      /**
       * The full desired `LambdaConfig` wire shape: the string trigger slots
       * plus the versioned `CustomEmailSender` + `KMSKeyID` from props. The
       * provider owns `LambdaConfig` outright, so a trigger or custom sender
       * removed from the program is cleared on the pool. The one exception
       * is `CustomSMSSender`, which the props cannot express yet: an
       * observed one (and the KMS key it needs) is carried over rather than
       * wiped by an unrelated update. Returns `undefined` when nothing is
       * desired (omitting `LambdaConfig` clears it on both create and
       * update).
       */
      const desiredLambdaConfig = (
        news: UserPoolProps,
        triggers: UserPoolLambdaConfig,
        observed: cip.LambdaConfigType | undefined,
      ): cip.LambdaConfigType | undefined => {
        const customSMSSender = observed?.CustomSMSSender;
        const config: cip.LambdaConfigType = {
          ...triggers,
          CustomEmailSender: toWireCustomEmailSender(news.customEmailSender),
          CustomSMSSender: customSMSSender,
          KMSKeyID:
            news.kmsKeyId ??
            (customSMSSender !== undefined ? observed?.KMSKeyID : undefined),
        };
        const present = Object.fromEntries(
          Object.entries(config).filter(([, value]) => value !== undefined),
        ) as cip.LambdaConfigType;
        return Object.keys(present).length > 0 ? present : undefined;
      };

      /** True when the managed parts of the observed `LambdaConfig` differ
       * from the desired one. */
      const lambdaConfigDrifted = (
        desired: cip.LambdaConfigType | undefined,
        observed: cip.LambdaConfigType | undefined,
      ) => {
        for (const trigger of USER_POOL_TRIGGER_NAMES) {
          if (desired?.[trigger] !== observed?.[trigger]) return true;
        }
        if (
          desired?.CustomEmailSender?.LambdaArn !==
            observed?.CustomEmailSender?.LambdaArn ||
          desired?.CustomEmailSender?.LambdaVersion !==
            observed?.CustomEmailSender?.LambdaVersion
        ) {
          return true;
        }
        return desired?.KMSKeyID !== observed?.KMSKeyID;
      };

      /** The update body sent to `updateUserPool` — always the full desired
       * state, because Cognito resets any omitted field to its default.
       * Props the user left undefined are "don't care" (see `hasDrift`), so
       * their OBSERVED value is echoed back rather than dropped — an update
       * to one setting must not reset another to its default. */
      const desiredUpdate = (
        news: UserPoolProps,
        observed: cip.UserPoolType,
        lambdaConfig: cip.LambdaConfigType | undefined,
      ): Omit<cip.UpdateUserPoolRequest, "UserPoolId"> => {
        const PasswordPolicy =
          news.passwordPolicy === undefined
            ? observed.Policies?.PasswordPolicy
            : toWirePasswordPolicy(news.passwordPolicy);
        const SignInPolicy =
          news.signInPolicy === undefined
            ? observed.Policies?.SignInPolicy
            : toWireSignInPolicy(news.signInPolicy);
        return {
          LambdaConfig: lambdaConfig,
          // updateUserPool resets an omitted EmailConfiguration to the
          // service default — echo the OBSERVED configuration back when the
          // prop is undefined so unrelated updates never clear it.
          EmailConfiguration:
            news.emailConfiguration === undefined
              ? observed.EmailConfiguration
              : toWireEmailConfiguration(news.emailConfiguration),
          Policies:
            PasswordPolicy === undefined && SignInPolicy === undefined
              ? undefined
              : { PasswordPolicy, SignInPolicy },
          DeletionProtection: news.deletionProtection ? "ACTIVE" : "INACTIVE",
          AutoVerifiedAttributes:
            news.autoVerifiedAttributes ?? observed.AutoVerifiedAttributes,
          MfaConfiguration: news.mfaConfiguration ?? "OFF",
          AdminCreateUserConfig:
            news.adminCreateUserOnly === undefined
              ? observed.AdminCreateUserConfig === undefined
                ? undefined
                : {
                    // never echo the deprecated UnusedAccountValidityDays —
                    // Cognito rejects it next to TemporaryPasswordValidityDays
                    AllowAdminCreateUserOnly:
                      observed.AdminCreateUserConfig.AllowAdminCreateUserOnly,
                    InviteMessageTemplate:
                      observed.AdminCreateUserConfig.InviteMessageTemplate,
                  }
              : { AllowAdminCreateUserOnly: news.adminCreateUserOnly },
          AccountRecoverySetting:
            news.accountRecovery === undefined
              ? observed.AccountRecoverySetting
              : toWireAccountRecovery(news.accountRecovery),
          UserPoolTier: news.tier ?? observed.UserPoolTier,
        };
      };

      /** Canonicalize a recovery-mechanism list for order-insensitive
       * comparison. */
      const canonicalRecovery = (
        mechanisms: {
          priority: number | undefined;
          name: string | undefined;
        }[],
      ) =>
        mechanisms
          .map((m) => `${m.priority}:${m.name}`)
          .sort()
          .join(",");

      /** Full password policy with the Cognito API defaults filled in, so a
       * partial desired policy compares fairly against the observed one.
       * Operates on the wire shape — `temporaryPasswordValidityDays` is a
       * whole number of days (desired durations are converted first). */
      const normalizedPasswordPolicy = (
        policy: Omit<UserPoolPasswordPolicy, "temporaryPasswordValidity"> & {
          temporaryPasswordValidityDays?: number;
        },
      ): Required<
        Omit<
          UserPoolPasswordPolicy,
          "passwordHistorySize" | "temporaryPasswordValidity"
        >
      > & {
        passwordHistorySize: number | undefined;
        temporaryPasswordValidityDays: number;
      } => ({
        minimumLength: policy.minimumLength ?? 8,
        requireUppercase: policy.requireUppercase ?? true,
        requireLowercase: policy.requireLowercase ?? true,
        requireNumbers: policy.requireNumbers ?? true,
        requireSymbols: policy.requireSymbols ?? true,
        passwordHistorySize: policy.passwordHistorySize,
        temporaryPasswordValidityDays:
          policy.temporaryPasswordValidityDays ?? 7,
      });

      /** True when the observed pool differs from the desired mutable state.
       * Props the user left undefined are "don't care" and never drift —
       * except `LambdaConfig`, which the provider owns outright (bindings
       * contribute to it), so a trigger or custom sender removed from the
       * program is drift that clears the observed entry. */
      const hasDrift = (
        news: UserPoolProps,
        observed: cip.UserPoolType,
        lambdaConfig: cip.LambdaConfigType | undefined,
      ) => {
        if (lambdaConfigDrifted(lambdaConfig, observed.LambdaConfig)) {
          return true;
        }
        if (
          news.signInPolicy?.allowedFirstAuthFactors !== undefined &&
          [...news.signInPolicy.allowedFirstAuthFactors].sort().join(",") !==
            [
              ...(observed.Policies?.SignInPolicy?.AllowedFirstAuthFactors ??
                []),
            ]
              .sort()
              .join(",")
        ) {
          return true;
        }
        if (news.passwordPolicy !== undefined) {
          const desired = normalizedPasswordPolicy({
            ...news.passwordPolicy,
            temporaryPasswordValidityDays: toWireDays(
              news.passwordPolicy.temporaryPasswordValidity,
            ),
          });
          const actual = normalizedPasswordPolicy({
            minimumLength: observed.Policies?.PasswordPolicy?.MinimumLength,
            requireUppercase:
              observed.Policies?.PasswordPolicy?.RequireUppercase,
            requireLowercase:
              observed.Policies?.PasswordPolicy?.RequireLowercase,
            requireNumbers: observed.Policies?.PasswordPolicy?.RequireNumbers,
            requireSymbols: observed.Policies?.PasswordPolicy?.RequireSymbols,
            passwordHistorySize:
              observed.Policies?.PasswordPolicy?.PasswordHistorySize,
            temporaryPasswordValidityDays:
              observed.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays,
          });
          if (JSON.stringify(desired) !== JSON.stringify(actual)) return true;
        }
        if (
          (news.deletionProtection ? "ACTIVE" : "INACTIVE") !==
          (observed.DeletionProtection ?? "INACTIVE")
        ) {
          return true;
        }
        if (
          news.autoVerifiedAttributes !== undefined &&
          [...news.autoVerifiedAttributes].sort().join(",") !==
            [...(observed.AutoVerifiedAttributes ?? [])].sort().join(",")
        ) {
          return true;
        }
        if (
          (news.mfaConfiguration ?? "OFF") !==
          (observed.MfaConfiguration ?? "OFF")
        ) {
          return true;
        }
        if (
          news.emailConfiguration !== undefined &&
          JSON.stringify(
            normalizedEmailConfiguration(
              toWireEmailConfiguration(news.emailConfiguration),
            ),
          ) !==
            JSON.stringify(
              normalizedEmailConfiguration(observed.EmailConfiguration),
            )
        ) {
          return true;
        }
        if (
          news.adminCreateUserOnly !== undefined &&
          news.adminCreateUserOnly !==
            (observed.AdminCreateUserConfig?.AllowAdminCreateUserOnly ?? false)
        ) {
          return true;
        }
        if (
          news.accountRecovery !== undefined &&
          canonicalRecovery(news.accountRecovery) !==
            canonicalRecovery(
              (observed.AccountRecoverySetting?.RecoveryMechanisms ?? []).map(
                (m) => ({ priority: m.Priority, name: m.Name }),
              ),
            )
        ) {
          return true;
        }
        if (news.tier !== undefined && news.tier !== observed.UserPoolTier) {
          return true;
        }
        return false;
      };

      return UserPool.Provider.of({
        stables: ["userPoolId", "userPoolArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* cip.listUserPools
              .pages({ MaxResults: 60 })
              .pipe(Stream.runCollect);
            const descriptions = Array.from(pages).flatMap(
              (page) => page.UserPools ?? [],
            );
            const pools = yield* Effect.forEach(
              descriptions.filter((d) => d.Id !== undefined),
              (d) => describePool(d.Id!),
              { concurrency: 5 },
            );
            return pools
              .filter((pool) => pool !== undefined)
              .map((pool) => attributesOf(pool));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.userPoolId !== undefined) {
            const pool = yield* describePool(output.userPoolId);
            if (pool === undefined) return undefined;
            const attrs = attributesOf(pool);
            const tags = tagRecordOf(pool.UserPoolTags);
            return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
          }
          const name = yield* createName(id, olds ?? {});
          const pools = yield* findPoolsByName(name);
          if (pools.length === 0) return undefined;
          for (const pool of pools) {
            if (yield* hasAlchemyTags(id, tagRecordOf(pool.UserPoolTags))) {
              return attributesOf(pool);
            }
          }
          return Unowned(attributesOf(pools[0]!));
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) return { action: "replace" } as const;
          // sign-in configuration is immutable
          if (
            JSON.stringify(olds?.usernameAttributes ?? []) !==
              JSON.stringify(news?.usernameAttributes ?? []) ||
            JSON.stringify(olds?.aliasAttributes ?? []) !==
              JSON.stringify(news?.aliasAttributes ?? []) ||
            (olds?.usernameCaseSensitive ?? true) !==
              (news?.usernameCaseSensitive ?? true)
          ) {
            return { action: "replace" } as const;
          }
          // schema attributes are add-only: removal or mutation ⇒ replace
          const oldSchema = olds?.schema ?? [];
          const newSchema = news?.schema ?? [];
          for (const before of oldSchema) {
            const after = newSchema.find((a) => a.name === before.name);
            if (after === undefined || schemaAttributeChanged(before, after)) {
              return { action: "replace" } as const;
            }
          }
        }),

        reconcile: Effect.fn(function* ({
          id,
          news = {},
          output,
          session,
          bindings,
        }) {
          yield* validateProps(news);
          const name = output?.userPoolName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const triggers = yield* resolveTriggers(news, bindings);

          // 1. OBSERVE — output.userPoolId is only a cache; fall back to a
          //    name search so out-of-band deletes and adoption converge.
          let observed =
            output?.userPoolId !== undefined
              ? yield* describePool(output.userPoolId)
              : undefined;
          if (observed === undefined) {
            // Recover from state loss by name — only take over a pool that
            // carries our ownership tags (adoption flows arrive with output
            // set, not through this path).
            const candidates = yield* findPoolsByName(name);
            for (const candidate of candidates) {
              if (
                yield* hasAlchemyTags(id, tagRecordOf(candidate.UserPoolTags))
              ) {
                observed = candidate;
                break;
              }
            }
          }

          // 2. ENSURE — create when missing.
          if (observed === undefined) {
            observed = yield* cip
              .createUserPool({
                PoolName: name,
                LambdaConfig: desiredLambdaConfig(news, triggers, undefined),
                Policies:
                  news.passwordPolicy === undefined &&
                  news.signInPolicy === undefined
                    ? undefined
                    : {
                        PasswordPolicy: toWirePasswordPolicy(
                          news.passwordPolicy,
                        ),
                        SignInPolicy: toWireSignInPolicy(news.signInPolicy),
                      },
                DeletionProtection: news.deletionProtection
                  ? "ACTIVE"
                  : "INACTIVE",
                EmailConfiguration: toWireEmailConfiguration(
                  news.emailConfiguration,
                ),
                UsernameAttributes: news.usernameAttributes,
                AliasAttributes: news.aliasAttributes,
                AutoVerifiedAttributes: news.autoVerifiedAttributes,
                Schema: news.schema?.map(toWireSchemaAttribute),
                MfaConfiguration: news.mfaConfiguration ?? "OFF",
                AdminCreateUserConfig:
                  news.adminCreateUserOnly === undefined
                    ? undefined
                    : { AllowAdminCreateUserOnly: news.adminCreateUserOnly },
                AccountRecoverySetting: toWireAccountRecovery(
                  news.accountRecovery,
                ),
                UsernameConfiguration:
                  news.usernameCaseSensitive === undefined
                    ? undefined
                    : { CaseSensitive: news.usernameCaseSensitive },
                UserPoolTier: news.tier,
                UserPoolTags: desiredTags,
              })
              .pipe(Effect.map((r) => r.UserPool!));
          } else {
            // 3. SYNC — updateUserPool resets omitted fields to defaults, so
            //    the body is always the full desired mutable state; skip the
            //    call entirely when nothing drifted.
            const lambdaConfig = desiredLambdaConfig(
              news,
              triggers,
              observed.LambdaConfig,
            );
            if (hasDrift(news, observed, lambdaConfig)) {
              yield* cip.updateUserPool({
                UserPoolId: observed.Id!,
                ...desiredUpdate(news, observed, lambdaConfig),
              });
            }

            // 3b. SYNC SCHEMA — custom attributes are add-only.
            const observedNames = new Set(
              (observed.SchemaAttributes ?? [])
                .map((attribute) => attribute.Name)
                .filter((n): n is string => n !== undefined),
            );
            const missing = (news.schema ?? []).filter(
              (attribute) =>
                !observedNames.has(customAttributeWireName(attribute)) &&
                !observedNames.has(attribute.name),
            );
            if (missing.length > 0) {
              yield* cip.addCustomAttributes({
                UserPoolId: observed.Id!,
                CustomAttributes: missing.map(toWireSchemaAttribute),
              });
            }
          }

          const userPoolId = observed.Id!;
          const userPoolArn = observed.Arn!;

          // 3c. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (never olds/output).
          const observedTags = yield* cip
            .listTagsForResource({ ResourceArn: userPoolArn })
            .pipe(
              Effect.map((r) => tagRecordOf(r.Tags)),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({} as Record<string, string>),
              ),
            );
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* cip.tagResource({
              ResourceArn: userPoolArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* cip.untagResource({
              ResourceArn: userPoolArn,
              TagKeys: removed,
            });
          }

          yield* session.note(userPoolId);
          return { userPoolId, userPoolArn, userPoolName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .deleteUserPool({ UserPoolId: output.userPoolId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
