import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

/**
 * Read state for PostHog reports is device-local: PostHog's own `viewed`
 * endpoint only records browser-session calls, so the inbox tracks what this
 * client has seen. A report counts as read while its `updated_at` is no newer
 * than the value stored here.
 */
export const REPORT_SEEN_STORAGE_KEY = "t3code:posthog:report-seen:v1";

const ReportSeenMapSchema = Schema.Record(Schema.String, Schema.String);

export function readReportSeenMap(): Record<string, string> {
  if (!hasWindow()) {
    return {};
  }

  try {
    return getLocalStorageItem(REPORT_SEEN_STORAGE_KEY, ReportSeenMapSchema) ?? {};
  } catch (error) {
    console.error("Could not read persisted report read state.", error);
    return {};
  }
}

export function writeReportSeenMap(seen: Record<string, string>): void {
  if (!hasWindow()) {
    return;
  }

  try {
    setLocalStorageItem(REPORT_SEEN_STORAGE_KEY, seen, ReportSeenMapSchema);
  } catch (error) {
    console.error("Could not persist report read state.", error);
  }
}
