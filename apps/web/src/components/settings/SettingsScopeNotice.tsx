import { Button } from "../ui/button";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import type { SettingsScopeSearch } from "./settingsScope";

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
}: {
  children: string;
  target: "device" | "environment" | "all";
}) {
  const { selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const choices: { label: string; search: SettingsScopeSearch }[] =
    target === "environment"
      ? environments.map((entry) => ({
          label: entry.label,
          search: { machine: entry.environmentId },
        }))
      : [
          {
            label: target === "device" ? "Open settings for this device" : "Open all environments",
            search: { scope: target },
          },
        ];
  return (
    <SettingsPageContainer>
      <div className="space-y-4 rounded-xl border border-border/60 p-4 text-sm">
        <p className="text-muted-foreground">{children}</p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <Button
              key={choice.label}
              size="sm"
              variant="outline"
              onClick={() => selectScope(choice.search)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </div>
    </SettingsPageContainer>
  );
}
