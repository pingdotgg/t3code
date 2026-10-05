import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  findEnterpriseByDisplayName,
  getEnterprise,
  jsonEqual,
  lastSegment,
  MAX_DISPLAY_NAME_LENGTH,
  sameStringList,
  sameText,
  toDisplayName,
  toEnterpriseName,
  updateMaskOf,
} from "./internal.ts";

export type EnterpriseProps = {
  /**
   * Cloud project that owns the enterprise. Defaults to the stack
   * project. Immutable — changing it replaces the enterprise.
   */
  projectId?: string;
  /**
   * Signup URL name from `signupUrls.create`. Set with
   * `enterpriseToken` for a customer-managed enterprise.
   */
  signupUrlName?: string;
  /**
   * Enterprise token appended to the signup callback URL. Set with
   * `signupUrlName` for a customer-managed enterprise.
   */
  enterpriseToken?: string;
  /**
   * Whether the admin accepted the managed Google Play Agreement.
   * Required for EMM-managed enterprises; must be omitted for
   * customer-managed ones.
   * @default true when `signupUrlName` is omitted
   */
  agreementAccepted?: boolean;
  /**
   * Display name shown to users (max 100 characters). Enterprises have
   * no labels field, so without state Alchemy finds the enterprise by
   * this name.
   * @default a unique name generated from the stack, stage, and logical id
   */
  enterpriseDisplayName?: string;
  /**
   * Predominant UI color as `(red << 16) | (green << 8) | blue`.
   */
  primaryColor?: number;
  /**
   * Pub/Sub topic for enterprise notifications
   * (`projects/{project}/topics/{topic}`).
   */
  pubsubTopic?: string;
  /**
   * Enabled Pub/Sub notification types (`ENROLLMENT`, `COMMAND`, …).
   */
  enabledNotificationTypes?: Array<
    androidmanagement.EnterpriseEnabledNotificationTypesItemEnum | (string & {})
  >;
  /**
   * Logo shown during device provisioning.
   */
  logo?: androidmanagement.ExternalData;
  /**
   * Terms and conditions pages shown during provisioning.
   */
  termsAndConditions?: androidmanagement.TermsAndConditionsList;
  /**
   * Sign-in details used for custom enrollment.
   */
  signinDetails?: androidmanagement.SigninDetailList;
  /**
   * Contact info for an EMM-managed enterprise.
   */
  contactInfo?: androidmanagement.ContactInfo;
};

export type Enterprise = Resource<
  "GCP.AndroidManagement.Enterprise",
  EnterpriseProps,
  {
    /** Resource name `enterprises/{enterprise}`. */
    name: string;
    /** Enterprise id (last path segment). */
    enterpriseId: string;
    /** Project id used when the enterprise was reconciled. */
    project: string;
    /** Display name. */
    enterpriseDisplayName: string | undefined;
    /** Predominant UI color. */
    primaryColor: number | undefined;
    /** Pub/Sub topic for notifications. */
    pubsubTopic: string | undefined;
    /** Enabled notification types. */
    enabledNotificationTypes: string[] | undefined;
    /** Provisioning logo. */
    logo: androidmanagement.ExternalData | undefined;
    /** Terms and conditions. */
    termsAndConditions: androidmanagement.TermsAndConditionsList | undefined;
    /** Sign-in details. */
    signinDetails: androidmanagement.SigninDetailList | undefined;
    /** Contact info. */
    contactInfo: androidmanagement.ContactInfo | undefined;
    /** Enterprise type. */
    enterpriseType: string | undefined;
    /** Managed Google Play Accounts enterprise type. */
    managedGooglePlayAccountsEnterpriseType: string | undefined;
    /** Managed Google domain type. */
    managedGoogleDomainType: string | undefined;
    /** Google authentication settings. */
    googleAuthenticationSettings:
      | androidmanagement.GoogleAuthenticationSettings
      | undefined;
  },
  never,
  Providers
>;

/**
 * An Android Management API enterprise.
 *
 * Enterprises have no labels field, so Alchemy tracks the enterprise by
 * its resource name; without state it is found by display name, and one
 * found under an explicit (non-generated) display name is reported as
 * unowned. Customer-managed
 * enterprises need `signupUrlName` plus `enterpriseToken`; otherwise an
 * EMM-managed enterprise is created with `agreementAccepted`. Display
 * name, color, notifications, logo, terms, sign-in details, and contact
 * info update in place. Changing `projectId` replaces the enterprise.
 * `enterprises.delete` only works for EMM-managed enterprises.
 *
 * ### Creating an Enterprise
 * **Example:** EMM-managed enterprise
 * ```typescript
 * const enterprise = yield* GCP.AndroidManagement.Enterprise("Work", {
 *   enterpriseDisplayName: "Alchemy Work",
 * });
 * ```
 *
 * **Example:** Customer-managed after signup
 * ```typescript
 * const enterprise = yield* GCP.AndroidManagement.Enterprise("Work", {
 *   signupUrlName: "signupUrls/abc",
 *   enterpriseToken: token,
 *   enterpriseDisplayName: "Acme",
 * });
 * ```
 *
 * ### Updating an Enterprise
 * **Example:** Rename
 * ```typescript
 * const enterprise = yield* GCP.AndroidManagement.Enterprise("Work", {
 *   enterpriseDisplayName: "Alchemy Work 2026",
 * });
 * ```
 *
 * @resource
 * @category AndroidManagement
 */
export const Enterprise = Resource<Enterprise>(
  "GCP.AndroidManagement.Enterprise",
);

export class EnterpriseNotResolved extends Data.TaggedError(
  "GCP.AndroidManagement.EnterpriseNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (enterprise: androidmanagement.Enterprise, project: string) => {
  const name = enterprise.name ?? "";
  return {
    name,
    enterpriseId: lastSegment(name),
    project,
    enterpriseDisplayName: enterprise.enterpriseDisplayName,
    primaryColor: enterprise.primaryColor,
    pubsubTopic: enterprise.pubsubTopic,
    enabledNotificationTypes: enterprise.enabledNotificationTypes,
    logo: enterprise.logo,
    termsAndConditions: enterprise.termsAndConditions,
    signinDetails: enterprise.signinDetails,
    contactInfo: enterprise.contactInfo,
    enterpriseType: enterprise.enterpriseType,
    managedGooglePlayAccountsEnterpriseType:
      enterprise.managedGooglePlayAccountsEnterpriseType,
    managedGoogleDomainType: enterprise.managedGoogleDomainType,
    googleAuthenticationSettings: enterprise.googleAuthenticationSettings,
  };
};

const desiredBody = (input: {
  displayName: string;
  news: EnterpriseProps;
}): androidmanagement.Enterprise => ({
  enterpriseDisplayName: input.displayName,
  primaryColor: input.news.primaryColor,
  pubsubTopic: input.news.pubsubTopic,
  enabledNotificationTypes: input.news.enabledNotificationTypes,
  logo: input.news.logo,
  termsAndConditions: input.news.termsAndConditions,
  signinDetails: input.news.signinDetails,
  contactInfo: input.news.contactInfo,
});

export const EnterpriseProvider = () =>
  Provider.succeed(Enterprise, {
    stables: ["name", "enterpriseId", "project", "enterpriseType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = olds?.projectId ?? output?.project;
      if (
        news.projectId !== undefined &&
        previousProject !== undefined &&
        news.projectId !== previousProject
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const projectId = olds?.projectId ?? output?.project ?? env.project;
      const byName = yield* getEnterprise(
        output?.name ?? toEnterpriseName(output?.enterpriseId ?? ""),
      );
      if (byName !== undefined) return toAttrs(byName, projectId);
      const generated = yield* toDisplayName(id, undefined, undefined);
      const displayName = olds?.enterpriseDisplayName ?? generated;
      const found = yield* findEnterpriseByDisplayName(projectId, displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, projectId);
      // A generated display name is unique to this stack, stage and id.
      return displayName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const projectId = news.projectId ?? output?.project ?? env.project;
      const displayName = yield* toDisplayName(
        id,
        news.enterpriseDisplayName,
        output?.enterpriseDisplayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const desired = desiredBody({ displayName, news });
      const customerManaged =
        (news.signupUrlName !== undefined && news.signupUrlName.length > 0) ||
        (news.enterpriseToken !== undefined && news.enterpriseToken.length > 0);

      let current = yield* getEnterprise(
        output?.name ?? toEnterpriseName(output?.enterpriseId ?? ""),
      );
      if (current === undefined) {
        current = yield* findEnterpriseByDisplayName(projectId, displayName);
      }

      if (current === undefined) {
        const created = yield* androidmanagement
          .createEnterprises({
            projectId,
            signupUrlName: news.signupUrlName,
            enterpriseToken: news.enterpriseToken,
            agreementAccepted: customerManaged
              ? news.agreementAccepted
              : (news.agreementAccepted ?? true),
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findEnterpriseByDisplayName(projectId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnterpriseNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(
        current.enterpriseDisplayName,
        displayName,
      );
      const colorChanged =
        news.primaryColor !== undefined &&
        current.primaryColor !== news.primaryColor;
      const topicChanged =
        news.pubsubTopic !== undefined &&
        !sameText(current.pubsubTopic, news.pubsubTopic);
      const notificationsChanged =
        news.enabledNotificationTypes !== undefined &&
        !sameStringList(
          current.enabledNotificationTypes,
          news.enabledNotificationTypes,
        );
      const logoChanged =
        news.logo !== undefined && !jsonEqual(current.logo, news.logo);
      const termsChanged =
        news.termsAndConditions !== undefined &&
        !jsonEqual(current.termsAndConditions, news.termsAndConditions);
      const signinChanged =
        news.signinDetails !== undefined &&
        !jsonEqual(current.signinDetails, news.signinDetails);
      const contactChanged =
        news.contactInfo !== undefined &&
        !jsonEqual(current.contactInfo, news.contactInfo);

      const updateMask = updateMaskOf(
        displayChanged ? "enterpriseDisplayName" : undefined,
        colorChanged ? "primaryColor" : undefined,
        topicChanged ? "pubsubTopic" : undefined,
        notificationsChanged ? "enabledNotificationTypes" : undefined,
        logoChanged ? "logo" : undefined,
        termsChanged ? "termsAndConditions" : undefined,
        signinChanged ? "signinDetails" : undefined,
        contactChanged ? "contactInfo" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        current = yield* androidmanagement.patchEnterprises({
          name,
          updateMask,
          body: desired,
        });
      }

      const fresh = (yield* getEnterprise(name)) ?? current;
      return toAttrs(fresh, projectId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* androidmanagement.deleteEnterprises({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        // Customer-managed enterprises cannot be deleted through the API.
        Effect.catchTag("BadRequest", () => Effect.void),
      );
    }),
  });
