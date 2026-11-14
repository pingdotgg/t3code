import { useState } from "react";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";

export function NativeToolsSettings() {
  const { environment } = useSettingsScope();
  const enabled = useScopedSettings((settings) => settings.nativeToolEnabled);
  const update = useUpdateScopedSettings({ scope: "environment" });
  const canWrite = useScopedSettingsWriteAllowed();
  const [search, setSearch] = useState("");
  const tools = environment?.serverConfig?.nativeTools;
  const query = search.trim().toLowerCase();
  const visible = tools?.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 tools">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Choose which built-in T3 tools agents can use on this environment, across all providers.
            Disabling a tool blocks new calls immediately. Reconnect existing agent sessions to
            refresh their tool lists. Calls already running are not cancelled.
          </p>
          <Input
            aria-label="Search T3 tools"
            placeholder="Search tools, e.g. t3_thread_send"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {tools ? (
            <p className="text-xs text-muted-foreground">
              {tools.filter((tool) => enabled[tool.name] !== false).length} of {tools.length} tools
              enabled
            </p>
          ) : null}
        </div>
        {tools === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">
            Connect to an environment with T3 tool settings support.
          </p>
        ) : visible?.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No matching tools.</p>
        ) : (
          visible?.map((tool) => (
            <SettingsRow
              key={tool.name}
              title={tool.name}
              description={tool.description}
              managedPaths={[`nativeToolEnabled.${tool.name}`]}
              control={
                <Switch
                  aria-label={tool.name}
                  checked={enabled[tool.name] !== false}
                  disabled={!canWrite}
                  onCheckedChange={(checked) =>
                    update({ nativeToolEnabled: { [tool.name]: checked } })
                  }
                />
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
