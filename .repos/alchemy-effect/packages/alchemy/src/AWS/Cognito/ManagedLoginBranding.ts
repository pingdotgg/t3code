import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * An image asset (logo, favicon, background, …) attached to a managed login
 * branding style, per color mode.
 */
export interface ManagedLoginBrandingAsset {
  /** Which slot of the managed login pages the asset fills. */
  category:
    | "FAVICON_ICO"
    | "FAVICON_SVG"
    | "EMAIL_GRAPHIC"
    | "SMS_GRAPHIC"
    | "AUTH_APP_GRAPHIC"
    | "PASSWORD_GRAPHIC"
    | "PASSKEY_GRAPHIC"
    | "PAGE_HEADER_LOGO"
    | "PAGE_HEADER_BACKGROUND"
    | "PAGE_FOOTER_LOGO"
    | "PAGE_FOOTER_BACKGROUND"
    | "PAGE_BACKGROUND"
    | "FORM_BACKGROUND"
    | "FORM_LOGO"
    | "IDP_BUTTON_ICON";
  /** The color scheme the asset applies to. */
  colorMode: "LIGHT" | "DARK" | "DYNAMIC";
  /** The file type of the asset. */
  extension: "ICO" | "JPEG" | "PNG" | "SVG" | "WEBP";
  /** The image file, as bytes (max 2 MB). */
  bytes?: Uint8Array;
  /** For `IDP_BUTTON_ICON` assets, the identity provider the icon is for. */
  resourceId?: string;
}

export interface ManagedLoginBrandingProps {
  /**
   * The ID of the user pool the branding style belongs to. Changing this
   * triggers a replacement.
   */
  userPoolId: string;
  /**
   * The ID of the app client the branding style is assigned to. Each app
   * client can have exactly one style. Changing this triggers a
   * replacement.
   */
  clientId: string;
  /**
   * Apply Cognito's default branding instead of custom `settings` /
   * `assets`. This is what makes a fresh pool's managed login pages render
   * without a one-time console step.
   * @default true when neither `settings` nor `assets` is provided
   */
  useCognitoProvidedValues?: boolean;
  /**
   * The branding settings JSON document (colors, component styles, …) in
   * the shape produced by the managed login branding designer / returned by
   * `DescribeManagedLoginBranding`.
   */
  settings?: Record<string, unknown>;
  /**
   * Image assets for the branding style (logos, favicons, backgrounds),
   * one per category + color mode.
   */
  assets?: ManagedLoginBrandingAsset[];
}

export interface ManagedLoginBranding extends Resource<
  "AWS.Cognito.ManagedLoginBranding",
  ManagedLoginBrandingProps,
  {
    /** The generated ID of the branding style. */
    managedLoginBrandingId: string;
    /** The ID of the user pool the style belongs to. */
    userPoolId: string;
    /** The ID of the app client the style is assigned to. */
    clientId: string;
  },
  never,
  Providers
> {}

/**
 * A managed login branding style for an Amazon Cognito user pool app
 * client. Assigning a style (even just Cognito's provided defaults) is what
 * activates the hosted managed login pages — a `UserPoolDomain` with
 * `managedLoginVersion: 2` serves them end-to-end without any console step.
 * ### Activating Managed Login
 * **Example:** Default Branding for a Hosted Login Domain
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   callbackUrls: ["https://example.com/callback"],
 *   allowedOAuthFlowsUserPoolClient: true,
 *   allowedOAuthFlows: ["code"],
 *   allowedOAuthScopes: ["openid", "email"],
 * });
 * const domain = yield* Cognito.UserPoolDomain("AuthDomain", {
 *   userPoolId: pool.userPoolId,
 *   managedLoginVersion: 2,
 * });
 * yield* Cognito.ManagedLoginBranding("Branding", {
 *   userPoolId: pool.userPoolId,
 *   clientId: client.clientId,
 * });
 * ```
 *
 * ### Custom Branding
 * **Example:** Custom Settings and a Logo Asset
 * ```typescript
 * yield* Cognito.ManagedLoginBranding("Branding", {
 *   userPoolId: pool.userPoolId,
 *   clientId: client.clientId,
 *   settings: brandingSettings, // designer-exported JSON document
 *   assets: [{
 *     category: "FORM_LOGO",
 *     colorMode: "LIGHT",
 *     extension: "PNG",
 *     bytes: logoBytes,
 *   }],
 * });
 * ```
 *
 * @resource
 */
export const ManagedLoginBranding = Resource<ManagedLoginBranding>(
  "AWS.Cognito.ManagedLoginBranding",
);

const toWireAssets = (
  assets: ManagedLoginBrandingAsset[] | undefined,
): cip.AssetType[] | undefined =>
  assets?.map((asset) => ({
    Category: asset.category,
    ColorMode: asset.colorMode,
    Extension: asset.extension,
    Bytes: asset.bytes,
    ResourceId: asset.resourceId,
  }));

/** Canonicalize an asset list for order-insensitive comparison; bytes are
 * folded to base64. */
const canonicalAssets = (assets: cip.AssetType[] | undefined) =>
  (assets ?? [])
    .map((asset) =>
      [
        asset.Category,
        asset.ColorMode,
        asset.Extension,
        asset.ResourceId ?? "",
        asset.Bytes === undefined
          ? ""
          : Buffer.from(asset.Bytes).toString("base64"),
      ].join(":"),
    )
    .sort()
    .join(",");

/**
 * Whether the style should carry Cognito's provided default values: an
 * explicit prop wins, otherwise defaults to `true` exactly when no custom
 * settings/assets are declared.
 */
const desiredUseProvidedValues = (news: ManagedLoginBrandingProps) =>
  news.useCognitoProvidedValues ??
  (news.settings === undefined && news.assets === undefined);

/**
 * Bounded retry over the concurrent-modification window (branding updates
 * can race domain/pool operations). Explicitly typed so the conditional
 * `Retry.Return` type never leaks into declaration emit.
 */
const retryWhileConcurrent = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

export const ManagedLoginBrandingProvider = () =>
  Provider.effect(
    ManagedLoginBranding,
    Effect.gen(function* () {
      const describeById = Effect.fn(function* (
        userPoolId: string,
        managedLoginBrandingId: string,
      ) {
        return yield* cip
          .describeManagedLoginBranding({
            UserPoolId: userPoolId,
            ManagedLoginBrandingId: managedLoginBrandingId,
          })
          .pipe(
            Effect.map((r) => r.ManagedLoginBranding),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const describeByClient = Effect.fn(function* (
        userPoolId: string,
        clientId: string,
      ) {
        return yield* cip
          .describeManagedLoginBrandingByClient({
            UserPoolId: userPoolId,
            ClientId: clientId,
          })
          .pipe(
            Effect.map((r) => r.ManagedLoginBranding),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return ManagedLoginBranding.Provider.of({
        stables: ["managedLoginBrandingId", "userPoolId", "clientId"],

        // Sub-resource keyed entirely by its user pool (userPoolId) with no
        // global enumeration API of its own — nuke reaches it through the
        // parent's deletion, so enumeration returns empty per the
        // ProviderService doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const userPoolId = output?.userPoolId ?? olds?.userPoolId;
          const clientId = output?.clientId ?? olds?.clientId;
          if (userPoolId === undefined) return undefined;
          const observed =
            output?.managedLoginBrandingId !== undefined
              ? yield* describeById(userPoolId, output.managedLoginBrandingId)
              : clientId !== undefined
                ? yield* describeByClient(userPoolId, clientId)
                : undefined;
          if (observed?.ManagedLoginBrandingId === undefined) return undefined;
          return {
            managedLoginBrandingId: observed.ManagedLoginBrandingId,
            userPoolId,
            clientId: clientId!,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.userPoolId !== news?.userPoolId ||
            olds?.clientId !== news?.clientId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const { userPoolId, clientId } = news;
          const useProvided = desiredUseProvidedValues(news);

          // 1. OBSERVE — output.managedLoginBrandingId is only a cache;
          //    fall back to the by-client lookup so state loss converges.
          let observed =
            output?.managedLoginBrandingId !== undefined
              ? yield* describeById(userPoolId, output.managedLoginBrandingId)
              : undefined;
          if (observed === undefined) {
            observed = yield* describeByClient(userPoolId, clientId);
          }

          // 2. ENSURE — create when missing; a branding created out-of-band
          //    (or by a concurrent run) for the same client surfaces as
          //    ManagedLoginBrandingExistsException and is taken over.
          if (observed === undefined) {
            observed = yield* cip
              .createManagedLoginBranding({
                UserPoolId: userPoolId,
                ClientId: clientId,
                UseCognitoProvidedValues: useProvided,
                Settings: news.settings,
                Assets: toWireAssets(news.assets),
              })
              .pipe(
                Effect.map((r) => r.ManagedLoginBranding),
                Effect.catchTag("ManagedLoginBrandingExistsException", () =>
                  describeByClient(userPoolId, clientId),
                ),
              );
          }

          const managedLoginBrandingId = observed?.ManagedLoginBrandingId!;

          // 3. SYNC — diff observed style against desired; skip the update
          //    entirely on no-op.
          const drift =
            (observed?.UseCognitoProvidedValues ?? false) !== useProvided ||
            (news.settings !== undefined &&
              JSON.stringify(news.settings) !==
                JSON.stringify(observed?.Settings)) ||
            (news.assets !== undefined &&
              canonicalAssets(toWireAssets(news.assets)) !==
                canonicalAssets(observed?.Assets));
          if (drift) {
            yield* cip
              .updateManagedLoginBranding({
                UserPoolId: userPoolId,
                ManagedLoginBrandingId: managedLoginBrandingId,
                UseCognitoProvidedValues: useProvided,
                Settings: news.settings,
                Assets: toWireAssets(news.assets),
              })
              .pipe(retryWhileConcurrent);
          }

          yield* session.note(managedLoginBrandingId);
          return { managedLoginBrandingId, userPoolId, clientId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .deleteManagedLoginBranding({
              UserPoolId: output.userPoolId,
              ManagedLoginBrandingId: output.managedLoginBrandingId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              retryWhileConcurrent,
            );
        }),
      });
    }),
  );
