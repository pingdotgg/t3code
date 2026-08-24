import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.RealtimeKit.Preset" as const;
type TypeId = typeof TypeId;

/**
 * Media quality tier for video / screenshare streams.
 */
export type MediaQuality = "hd" | "vga" | "qvga";

/**
 * Meeting layout the preset applies to.
 */
export type ViewType = "GROUP_CALL" | "WEBINAR" | "AUDIO_ROOM";

/**
 * Whether a participant may produce a media kind.
 */
export type CanProduce = "ALLOWED" | "NOT_ALLOWED" | "CAN_REQUEST";

/**
 * What a participant joining with this preset records as.
 */
export type RecorderType = "RECORDER" | "LIVESTREAMER" | "NONE";

/**
 * Waiting-room behavior for participants joining with this preset.
 */
export type WaitingRoomType =
  | "SKIP"
  | "ON_PRIVILEGED_USER_ENTRY"
  | "SKIP_ON_ACCEPT";

/**
 * Media configuration of a preset (stream counts, quality, frame rates).
 */
export type PresetConfig = {
  /**
   * Maximum number of simultaneous screenshares.
   */
  maxScreenshareCount: number;
  /**
   * Maximum simultaneous video streams per device class.
   */
  maxVideoStreams: { desktop: number; mobile: number };
  /**
   * Quality / frame-rate settings for each media kind.
   */
  media: {
    screenshare: { frameRate: number; quality: MediaQuality };
    video: { frameRate: number; quality: MediaQuality };
    audio?: { enableHighBitrate?: boolean; enableStereo?: boolean };
  };
  /**
   * Meeting layout this preset applies to.
   */
  viewType: ViewType;
};

/**
 * UI design tokens of a preset (colors, logo, spacing).
 */
/** Corner rounding of UI elements. */
export type BorderRadius = "sharp" | "rounded" | "extra-rounded" | "circular";

/** Border width of UI elements. */
export type BorderWidth = "none" | "thin" | "fat";

/** Base color theme of the meeting UI. */
export type Theme = "darkest" | "dark" | "light";

export type PresetUi = {
  designTokens: {
    borderRadius: BorderRadius;
    borderWidth: BorderWidth;
    colors: {
      background: {
        "600": string;
        "700": string;
        "800": string;
        "900": string;
        "1000": string;
      };
      brand: {
        "300": string;
        "400": string;
        "500": string;
        "600": string;
        "700": string;
      };
      danger: string;
      success: string;
      text: string;
      textOnBrand: string;
      videoBg: string;
      warning: string;
    };
    logo: string;
    spacingBase: number;
    theme: Theme;
  };
  /**
   * Raw UI-kit config diff applied on top of the design tokens. Required by
   * the live API (defaulted to `{}` when omitted).
   * @default {}
   */
  configDiff?: unknown;
};

/**
 * Participant permissions granted by a preset.
 */
export type PresetPermissions = {
  acceptWaitingRequests: boolean;
  canAcceptProductionRequests: boolean;
  canChangeParticipantPermissions: boolean;
  canEditDisplayName: boolean;
  canLivestream: boolean;
  canRecord: boolean;
  canSpotlight: boolean;
  chat: {
    private: {
      canReceive: boolean;
      canSend: boolean;
      files: boolean;
      text: boolean;
    };
    public: { canSend: boolean; files: boolean; text: boolean };
  };
  connectedMeetings: {
    canAlterConnectedMeetings: boolean;
    canSwitchConnectedMeetings: boolean;
    canSwitchToParentMeeting: boolean;
  };
  disableParticipantAudio: boolean;
  disableParticipantScreensharing: boolean;
  disableParticipantVideo: boolean;
  hiddenParticipant: boolean;
  kickParticipant: boolean;
  media: {
    audio: { canProduce: CanProduce };
    screenshare: { canProduce: CanProduce };
    video: { canProduce: CanProduce };
  };
  pinParticipant: boolean;
  plugins: {
    canClose: boolean;
    canEditConfig: boolean;
    canStart: boolean;
    /**
     * Per-plugin access config keyed by plugin UUID.
     * @default {}
     */
    config?: unknown;
  };
  polls: { canCreate: boolean; canView: boolean; canVote: boolean };
  recorderType: RecorderType;
  showParticipantList: boolean;
  waitingRoomType: WaitingRoomType;
  isRecorder?: boolean;
};

export type PresetProps = {
  /**
   * The RealtimeKit app the preset belongs to. Changing the app triggers a
   * replacement.
   */
  appId: string;
  /**
   * Human readable preset name (e.g. `host`, `guest`). If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Media configuration (stream counts, quality, frame rates).
   * @default a group-call config (hd video at 30fps, hd screenshare at 5fps, 9 desktop / 4 mobile streams)
   */
  config?: PresetConfig;
  /**
   * UI design tokens.
   * @default RealtimeKit's dark theme defaults
   */
  ui?: PresetUi;
  /**
   * Participant permissions. The API requires the full object on create, so
   * unspecified permissions fall back to conservative attendee defaults
   * (chat and polls allowed, no recording / livestreaming / moderation).
   * @default conservative attendee defaults
   */
  permissions?: PresetPermissions;
};

export type PresetAttributes = {
  /**
   * Server-generated preset identifier. Stable across updates.
   */
  presetId: string;
  /**
   * The Cloudflare account the preset belongs to.
   */
  accountId: string;
  /**
   * The RealtimeKit app the preset belongs to.
   */
  appId: string;
  /**
   * Human readable preset name.
   */
  name: string;
  /**
   * Media configuration as stored by Cloudflare.
   */
  config: PresetConfig;
  /**
   * UI design tokens as stored by Cloudflare.
   */
  ui: PresetUi;
  /**
   * Participant permissions as stored by Cloudflare.
   */
  permissions: PresetPermissions | undefined;
};

export type Preset = Resource<
  TypeId,
  PresetProps,
  PresetAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare RealtimeKit preset — a named participant role (e.g. `host`,
 * `guest`) bundling permissions, media quality, and UI design tokens for a
 * RealtimeKit app.
 *
 * Name, config, UI, and permissions are all mutable in place; only moving
 * the preset to a different app forces a replacement. The create API
 * requires the full config / UI / permissions objects, so the resource fills
 * unspecified sections with sensible defaults.
 * @resource
 * @product Realtime Kit
 * @category Media
 * @section Creating a Preset
 * @example Default group-call preset
 * ```typescript
 * const app = yield* Cloudflare.RealtimeKit.App("Meetings", {});
 *
 * const guest = yield* Cloudflare.RealtimeKit.Preset("Guest", {
 *   appId: app.appId,
 *   name: "guest",
 * });
 * ```
 *
 * @example Host preset with moderation permissions
 * ```typescript
 * const host = yield* Cloudflare.RealtimeKit.Preset("Host", {
 *   appId: app.appId,
 *   name: "host",
 *   permissions: {
 *     ...Cloudflare.RealtimeKit.defaultRealtimeKitPresetPermissions(),
 *     canRecord: true,
 *     kickParticipant: true,
 *     pinParticipant: true,
 *     acceptWaitingRequests: true,
 *   },
 * });
 * ```
 *
 * @section Updating a Preset
 * @example Switch to a webinar layout
 * ```typescript
 * const preset = yield* Cloudflare.RealtimeKit.Preset("Guest", {
 *   appId: app.appId,
 *   name: "guest",
 *   config: {
 *     ...Cloudflare.RealtimeKit.defaultRealtimeKitPresetConfig(),
 *     viewType: "WEBINAR",
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/realtime/realtimekit/
 */
export const Preset = Resource<Preset>(TypeId);

/**
 * Returns true if the given value is a Preset resource.
 */
export const isPreset = (value: unknown): value is Preset =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * The default media configuration used when `config` is omitted: a group
 * call with hd video at 30fps, hd screenshare at 5fps, and 9 desktop /
 * 4 mobile video streams.
 */
export const defaultRealtimeKitPresetConfig = (): PresetConfig => ({
  maxScreenshareCount: 1,
  maxVideoStreams: { desktop: 9, mobile: 4 },
  media: {
    screenshare: { frameRate: 5, quality: "hd" },
    video: { frameRate: 30, quality: "hd" },
  },
  viewType: "GROUP_CALL",
});

/**
 * The default UI design tokens used when `ui` is omitted: RealtimeKit's
 * dark theme.
 */
export const defaultRealtimeKitPresetUi = (): PresetUi => ({
  designTokens: {
    borderRadius: "rounded",
    borderWidth: "thin",
    colors: {
      background: {
        "600": "#1f2937",
        "700": "#1a232e",
        "800": "#141d26",
        "900": "#10171e",
        "1000": "#0b1116",
      },
      brand: {
        "300": "#93c5fd",
        "400": "#60a5fa",
        "500": "#3b82f6",
        "600": "#2563eb",
        "700": "#1d4ed8",
      },
      danger: "#ff2d2d",
      success: "#62a504",
      text: "#ffffff",
      textOnBrand: "#ffffff",
      videoBg: "#191919",
      warning: "#ffc107",
    },
    logo: "",
    spacingBase: 4,
    theme: "dark",
  },
  configDiff: {},
});

/**
 * The default permissions used when `permissions` is omitted: a conservative
 * attendee role — chat, polls, and media production allowed; recording,
 * livestreaming, and moderation denied.
 */
export const defaultRealtimeKitPresetPermissions = (): PresetPermissions => ({
  acceptWaitingRequests: false,
  canAcceptProductionRequests: false,
  canChangeParticipantPermissions: false,
  canEditDisplayName: false,
  canLivestream: false,
  canRecord: false,
  canSpotlight: false,
  chat: {
    private: { canReceive: true, canSend: true, files: true, text: true },
    public: { canSend: true, files: true, text: true },
  },
  connectedMeetings: {
    canAlterConnectedMeetings: false,
    canSwitchConnectedMeetings: false,
    canSwitchToParentMeeting: false,
  },
  disableParticipantAudio: false,
  disableParticipantScreensharing: false,
  disableParticipantVideo: false,
  hiddenParticipant: false,
  kickParticipant: false,
  media: {
    audio: { canProduce: "ALLOWED" },
    screenshare: { canProduce: "ALLOWED" },
    video: { canProduce: "ALLOWED" },
  },
  pinParticipant: false,
  plugins: {
    canClose: true,
    canEditConfig: true,
    canStart: true,
    config: {},
  },
  polls: { canCreate: true, canView: true, canVote: true },
  recorderType: "NONE",
  showParticipantList: true,
  waitingRoomType: "SKIP",
});

export const PresetProvider = () =>
  Provider.succeed(Preset, {
    stables: ["presetId", "accountId", "appId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The app is a path parameter — a preset cannot move between apps in
      // place. By diff time both sides are resolved strings.
      const oldAppId = output?.appId ?? olds?.appId;
      if (
        typeof oldAppId === "string" &&
        typeof news.appId === "string" &&
        oldAppId !== news.appId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const appId = output?.appId ?? (olds?.appId as string | undefined);
      if (appId === undefined) return undefined;

      if (output?.presetId) {
        const observed = yield* getPreset(acct, appId, output.presetId);
        return observed ? toAttributes(observed, acct, appId) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createPresetName(id, olds?.name);
      const match = yield* findByName(acct, appId, name);
      if (match?.id) {
        const observed = yield* getPreset(acct, appId, match.id);
        return observed ? toAttributes(observed, acct, appId) : undefined;
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const appId = news.appId as string;
      const name = yield* createPresetName(id, news.name);
      const desired = {
        name,
        config: news.config ?? defaultRealtimeKitPresetConfig(),
        ui: withUiDefaults(news.ui),
        permissions: withPermissionsDefaults(news.permissions),
      };

      // Observe — the presetId cached on `output` is a hint, not a
      // guarantee: a missing preset falls through and we recreate.
      const observed = output?.presetId
        ? yield* getPreset(
            output.accountId ?? accountId,
            appId,
            output.presetId,
          )
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the full
        // desired body. The API rejects a duplicate name in the same app
        // with a 409 (`RealtimeKitPresetExists`); this happens when a prior
        // run leaked a same-named preset (lost state) or when a retried
        // create races a 500 that actually persisted. Adopt the existing
        // preset by name and converge it to the desired body instead of
        // leaking / failing.
        const created = yield* realtimeKit
          .createPreset({ accountId, appId, ...desired })
          .pipe(
            Effect.catchTag("RealtimeKitPresetExists", () =>
              Effect.succeed(undefined),
            ),
          );
        if (created) {
          return toAttributes(created.data, accountId, appId);
        }
        const existing = yield* findByName(accountId, appId, name);
        if (!existing?.id) {
          // Conflict reported but the preset isn't visible yet — let the
          // engine retry the reconcile rather than silently succeeding.
          return yield* realtimeKit
            .createPreset({ accountId, appId, ...desired })
            .pipe(
              Effect.map((res) => toAttributes(res.data, accountId, appId)),
            );
        }
        yield* realtimeKit.patchPreset({
          accountId,
          appId,
          presetId: existing.id,
          ...desired,
        });
        const adopted = yield* realtimeKit.getPresetByIdPreset({
          accountId,
          appId,
          presetId: existing.id,
        });
        return toAttributes(adopted.data, accountId, appId);
      }

      // Sync — diff what the user asked for against observed cloud state.
      // The API fills/echoes extra server-side fields (e.g. `simulcast`),
      // so compare only the desired keys against the observed echo.
      if (subsetEquals(desired, observed)) {
        return toAttributes(observed, accountId, appId);
      }
      yield* realtimeKit.patchPreset({
        accountId,
        appId,
        presetId: observed.id,
        ...desired,
      });
      // The PATCH response omits the preset id — re-read for fresh state.
      const fresh = yield* realtimeKit.getPresetByIdPreset({
        accountId,
        appId,
        presetId: observed.id,
      });
      return toAttributes(fresh.data, accountId, appId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* realtimeKit
        .deletePreset({
          accountId: output.accountId,
          appId: output.appId,
          presetId: output.presetId,
        })
        .pipe(Effect.catchTag("RealtimeKitPresetNotFound", () => Effect.void));
    }),
    // Presets are sub-resources of a RealtimeKit app. There is no
    // account-wide preset enumeration API, so fan out: list every app in the
    // account, then list every preset within each app. The per-app preset
    // list returns only a slim `{ id, name }` shape, so each row is hydrated
    // via `getPresetByIdPreset` into the full `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const apps = yield* listAllApps(accountId);
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          Effect.gen(function* () {
            const appId = app.id;
            if (!appId) return [];
            const presets = yield* listAllPresets(accountId, appId);
            const hydrated = yield* Effect.forEach(
              presets,
              (preset) =>
                preset.id
                  ? getPreset(accountId, appId, preset.id).pipe(
                      Effect.map((observed) =>
                        observed
                          ? toAttributes(observed, accountId, appId)
                          : undefined,
                      ),
                    )
                  : Effect.succeed(undefined),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (row): row is PresetAttributes => row !== undefined,
            );
          }),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

const LIST_PER_PAGE = 100;

/**
 * Exhaustively enumerate every RealtimeKit app in the account. The list op is
 * not generated as a paginated method, so fetch the first page, derive the
 * page count from `paging.totalCount`, then fan out the remaining pages.
 */
const listAllApps = (accountId: string) =>
  Effect.gen(function* () {
    const first = yield* realtimeKit.getApp({
      accountId,
      pageNo: 1,
      perPage: LIST_PER_PAGE,
    });
    const apps = (first.data ?? []).filter(
      (a): a is NonNullable<typeof a> => a !== null,
    );
    const total = first.paging?.totalCount ?? apps.length;
    const pages = Math.ceil(total / LIST_PER_PAGE);
    if (pages <= 1) return apps;
    const rest = yield* Effect.forEach(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      (pageNo) =>
        realtimeKit
          .getApp({ accountId, pageNo, perPage: LIST_PER_PAGE })
          .pipe(
            Effect.map((res) =>
              (res.data ?? []).filter(
                (a): a is NonNullable<typeof a> => a !== null,
              ),
            ),
          ),
      { concurrency: 10 },
    );
    return [...apps, ...rest.flat()];
  });

/**
 * Exhaustively enumerate every preset within a single app, paginating off
 * `paging.totalCount` the same way as {@link listAllApps}.
 */
const listAllPresets = (accountId: string, appId: string) =>
  Effect.gen(function* () {
    const first = yield* realtimeKit.getPreset({
      accountId,
      appId,
      pageNo: 1,
      perPage: LIST_PER_PAGE,
    });
    const presets = [...first.data];
    const total = first.paging?.totalCount ?? presets.length;
    const pages = Math.ceil(total / LIST_PER_PAGE);
    if (pages <= 1) return presets;
    const rest = yield* Effect.forEach(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      (pageNo) =>
        realtimeKit
          .getPreset({ accountId, appId, pageNo, perPage: LIST_PER_PAGE })
          .pipe(Effect.map((res) => [...res.data])),
      { concurrency: 10 },
    );
    return [...presets, ...rest.flat()];
  });

type ObservedPreset = realtimeKit.GetPresetByIdPresetResponse["data"];

/**
 * Read a preset by id, mapping "gone" (`RealtimeKitPresetNotFound`,
 * HTTP 404) to `undefined`.
 */
const getPreset = (accountId: string, appId: string, presetId: string) =>
  realtimeKit.getPresetByIdPreset({ accountId, appId, presetId }).pipe(
    Effect.map((res) => res.data),
    Effect.catchTag("RealtimeKitPresetNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a preset by exact name in the app's preset list. If several presets
 * carry the same name, pick the oldest for determinism.
 */
const findByName = (accountId: string, appId: string, name: string) =>
  realtimeKit.getPreset({ accountId, appId, perPage: 100 }).pipe(
    Effect.map((list) =>
      [...list.data]
        .filter((p) => p.name === name)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
        .at(0),
    ),
  );

const createPresetName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const withUiDefaults = (
  ui: PresetUi | undefined,
): PresetUi & { configDiff: unknown } => {
  const base = ui ?? defaultRealtimeKitPresetUi();
  // `config_diff` is required by the API even though it's incidental —
  // default it so users don't have to care.
  return { ...base, configDiff: base.configDiff ?? {} };
};

/**
 * Fill `plugins.config` (required by the create API even though it's
 * incidental) so users don't have to care. The return type intentionally
 * stays inferred: `CreatePresetRequest` requires `plugins.config` to be
 * present, and annotating `PresetPermissions` (where it is
 * optional) would erase the guarantee the literal provides.
 */
const withPermissionsDefaults = (
  permissions: PresetPermissions | undefined,
) => {
  const base = permissions ?? defaultRealtimeKitPresetPermissions();
  return {
    ...base,
    plugins: {
      ...base.plugins,
      config: (base.plugins.config ?? {}) as unknown,
    },
  };
};

/**
 * Deep "is `desired` a subset of `observed`" comparison. The RealtimeKit
 * API echoes extra server-computed fields (e.g. `simulcast`) alongside what
 * we sent, so a strict deep-equal would always report drift.
 */
const subsetEquals = (desired: unknown, observed: unknown): boolean => {
  if (
    typeof desired === "object" &&
    desired !== null &&
    typeof observed === "object" &&
    observed !== null &&
    !Array.isArray(desired) &&
    !Array.isArray(observed)
  ) {
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        value === undefined ||
        subsetEquals(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (Array.isArray(desired) && Array.isArray(observed)) {
    return (
      desired.length === observed.length &&
      desired.every((value, i) => subsetEquals(value, observed[i]))
    );
  }
  return desired === observed;
};

const toAttributes = (
  preset: ObservedPreset,
  accountId: string,
  appId: string,
): PresetAttributes => ({
  presetId: preset.id,
  accountId,
  appId,
  name: preset.name,
  // Distilled widens generated string enums to open unions (`string & {}`)
  // and marks echoes readonly — re-shape into our prop types.
  config: {
    maxScreenshareCount: preset.config.maxScreenshareCount,
    maxVideoStreams: {
      desktop: preset.config.maxVideoStreams.desktop,
      mobile: preset.config.maxVideoStreams.mobile,
    },
    media: {
      screenshare: {
        frameRate: preset.config.media.screenshare.frameRate,
        quality: preset.config.media.screenshare.quality as MediaQuality,
      },
      video: {
        frameRate: preset.config.media.video.frameRate,
        quality: preset.config.media.video.quality as MediaQuality,
      },
      ...(preset.config.media.audio
        ? {
            audio: {
              ...(preset.config.media.audio.enableHighBitrate != null
                ? {
                    enableHighBitrate:
                      preset.config.media.audio.enableHighBitrate,
                  }
                : {}),
              ...(preset.config.media.audio.enableStereo != null
                ? { enableStereo: preset.config.media.audio.enableStereo }
                : {}),
            },
          }
        : {}),
    },
    viewType: preset.config.viewType as ViewType,
  },
  ui: {
    designTokens: {
      borderRadius: preset.ui.designTokens.borderRadius as BorderRadius,
      borderWidth: preset.ui.designTokens.borderWidth as BorderWidth,
      colors: {
        background: { ...preset.ui.designTokens.colors.background },
        brand: { ...preset.ui.designTokens.colors.brand },
        danger: preset.ui.designTokens.colors.danger,
        success: preset.ui.designTokens.colors.success,
        text: preset.ui.designTokens.colors.text,
        textOnBrand: preset.ui.designTokens.colors.textOnBrand,
        videoBg: preset.ui.designTokens.colors.videoBg,
        warning: preset.ui.designTokens.colors.warning,
      },
      logo: preset.ui.designTokens.logo ?? "",
      spacingBase: preset.ui.designTokens.spacingBase,
      theme: preset.ui.designTokens.theme as Theme,
    },
    configDiff: preset.ui.configDiff ?? {},
  },
  permissions: preset.permissions
    ? {
        acceptWaitingRequests: preset.permissions.acceptWaitingRequests,
        canAcceptProductionRequests:
          preset.permissions.canAcceptProductionRequests,
        canChangeParticipantPermissions:
          preset.permissions.canChangeParticipantPermissions,
        canEditDisplayName: preset.permissions.canEditDisplayName,
        canLivestream: preset.permissions.canLivestream,
        canRecord: preset.permissions.canRecord,
        canSpotlight: preset.permissions.canSpotlight,
        chat: {
          private: { ...preset.permissions.chat.private },
          public: { ...preset.permissions.chat.public },
        },
        connectedMeetings: { ...preset.permissions.connectedMeetings },
        disableParticipantAudio: preset.permissions.disableParticipantAudio,
        disableParticipantScreensharing:
          preset.permissions.disableParticipantScreensharing,
        disableParticipantVideo: preset.permissions.disableParticipantVideo,
        hiddenParticipant: preset.permissions.hiddenParticipant,
        kickParticipant: preset.permissions.kickParticipant,
        media: {
          audio: {
            canProduce: preset.permissions.media.audio.canProduce as CanProduce,
          },
          screenshare: {
            canProduce: preset.permissions.media.screenshare
              .canProduce as CanProduce,
          },
          video: {
            canProduce: preset.permissions.media.video.canProduce as CanProduce,
          },
        },
        pinParticipant: preset.permissions.pinParticipant,
        plugins: {
          canClose: preset.permissions.plugins.canClose,
          canEditConfig: preset.permissions.plugins.canEditConfig,
          canStart: preset.permissions.plugins.canStart,
          config: preset.permissions.plugins.config ?? {},
        },
        polls: { ...preset.permissions.polls },
        recorderType: preset.permissions.recorderType as RecorderType,
        showParticipantList: preset.permissions.showParticipantList,
        waitingRoomType: preset.permissions.waitingRoomType as WaitingRoomType,
        ...(preset.permissions.isRecorder != null
          ? { isRecorder: preset.permissions.isRecorder }
          : {}),
      }
    : undefined,
});
