import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
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
          label: environments.some(
            (other) => other.environmentId !== entry.environmentId && other.label === entry.label,
          )
            ? `${entry.label} · ${entry.displayUrl || entry.environmentId}`
            : entry.label,
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
      <Alert role="status">
        <AlertDescription>
          <p>{children}</p>
          <AlertAction className="flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={JSON.stringify(choice.search)}
                size="sm"
                variant="outline"
                onClick={() => selectScope(choice.search)}
              >
                {choice.label}
              </Button>
            ))}
          </AlertAction>
        </AlertDescription>
      </Alert>
    </SettingsPageContainer>
  );
}
