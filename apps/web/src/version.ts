import versionData from "../../../version.json";

const resolvedVersion =
  versionData && typeof versionData === "object" && "version" in versionData
    ? (versionData as { version?: string }).version
    : undefined;

export const APP_VERSION = typeof resolvedVersion === "string" ? resolvedVersion : "0.0.0";
