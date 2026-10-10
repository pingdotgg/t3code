/**
 * Plugin notifications.
 *
 * A plugin with the `notifications` capability sends short notifications that
 * clients show as toasts. Notifications are transient: the server keeps a few
 * recent ones in memory so a client that briefly lost its connection catches
 * up, and nothing survives a server restart. Delivery is best-effort, never
 * durable or loss-free.
 *
 * @module PluginNotifications
 */
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

/**
 * One frame of `plugins.notifications.subscribe`: every notification the
 * server retains right now, so the latest frame alone is the whole state. The
 * first frame of a subscription is the current set; a new frame follows each
 * change (a notification sent, one evicted or expired, or a stopped plugin's
 * withdrawn). A client toasts a notification once when it first appears above
 * the newest one it has already seen, and closes a toast whose notification
 * is no longer in the set.
 */
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
