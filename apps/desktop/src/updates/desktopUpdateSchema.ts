import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopUpdateActionResult } from "@t3tools/contracts";

export type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

export interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
export type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

export const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Malformed notes must not block update-state decoding; normalizeDesktopUpdateReleaseNotes validates separately.
  releaseNotes: Schema.optional(Schema.Unknown),
  releaseDate: Schema.optional(Schema.String),
});

export const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
export const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
export const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
export const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

export const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
export const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
export const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

export const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
