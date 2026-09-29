export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : {
        supported: false,
        subtitle: translate(
          "common:mobileLabels.unavailableOnPlatform",
          "Unavailable on this platform",
        ),
      };
}
import { translate } from "@t3tools/i18n";
