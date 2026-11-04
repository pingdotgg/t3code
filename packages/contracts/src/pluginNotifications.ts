// Notifications are transient and best-effort; retained memory covers short disconnects, never restarts.
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { ContributionStatusTone } from "./contributionStatus.ts";

/** Manifest capability for `context.proposed.notify`; requires `proposedApi: true`. */
export const PLUGIN_NOTIFICATIONS_CAPABILITY = "notifications";

export const PLUGIN_NOTIFICATION_TITLE_MAX_LENGTH = 80;
export const PLUGIN_NOTIFICATION_BODY_MAX_LENGTH = 240;
/** Most notifications the server retains, so the most one frame carries. Server-enforced. */
export const PLUGIN_NOTIFICATION_MAX_RETAINED = 20;
/**
 * Most UTF-8 bytes one notification takes in a JSON frame. Server-enforced:
 * a larger notification is refused before it is sent. With the retained count
 * this bounds a whole frame to PLUGIN_NOTIFICATION_FRAME_MAX_BYTES.
 */
export const PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES = 4_096;
/** Most UTF-8 bytes of one JSON frame: 20 notifications plus the frame's own fields. */
export const PLUGIN_NOTIFICATION_FRAME_MAX_BYTES =
  PLUGIN_NOTIFICATION_MAX_RETAINED * PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES + 512;

const Epoch = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));

export const PluginNotification = Schema.Struct({
  /** Issue order within the frame's epoch; with the epoch, the notification's identity. */
  sequence: NonNegativeInt,
  pluginId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  /** The plugin's display name from its manifest. */
  pluginName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  /** One plain line, normalized by the server like status text. */
  title: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(PLUGIN_NOTIFICATION_TITLE_MAX_LENGTH),
  ),
  body: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PLUGIN_NOTIFICATION_BODY_MAX_LENGTH)),
  ),
  /** Absent means neutral; unknown tones decode as neutral. */
  tone: Schema.optionalKey(ContributionStatusTone),
  /** The thread the notification is about, which clients may offer to open. */
  threadId: Schema.optionalKey(ThreadId),
  createdAt: IsoDateTime,
});
export type PluginNotification = typeof PluginNotification.Type;

// Each notification frame replaces the retained set; clients toast unseen entries once and close withdrawn entries.
export const PluginNotificationFrame = Schema.Struct({
  /** Changes when the server restarts; sequences start again in a new epoch. */
  epoch: Epoch,
  /**
   * Oldest first; at most PLUGIN_NOTIFICATION_MAX_RETAINED, so the encoded
   * frame is at most PLUGIN_NOTIFICATION_FRAME_MAX_BYTES.
   */
  notifications: ForwardCompatibleArray(PluginNotification),
});
export type PluginNotificationFrame = typeof PluginNotificationFrame.Type;
