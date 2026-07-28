import { createFileRoute } from "@tanstack/react-router";
import { ProviderDriverKind } from "@t3tools/contracts";

import { HermesCronSettings } from "../components/settings/HermesCronSettings";
import { ProviderSettingsPanel } from "../components/settings/SettingsPanels";

export const T3_WORK_SETTINGS_SCROLL_CLASS_NAME =
  "settings-page-scroll-fade scrollbar-gutter-both min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-y-contain";
export const T3_WORK_GATEWAY_DRIVERS = [
  ProviderDriverKind.make("hermes"),
  ProviderDriverKind.make("openclaw"),
] as const;

export const Route = createFileRoute("/settings/hermes-cron")({
  component: T3WorkSettings,
});

function T3WorkSettings() {
  return (
    <div className={T3_WORK_SETTINGS_SCROLL_CLASS_NAME}>
      <ProviderSettingsPanel
        title="Agent gateways"
        includeDriver={(driver) =>
          T3_WORK_GATEWAY_DRIVERS.some((gatewayDriver) => gatewayDriver === driver)
        }
        isComingSoonDriver={(driver) => driver === "openclaw"}
        allowAddInstance={false}
      />
      <HermesCronSettings />
    </div>
  );
}
