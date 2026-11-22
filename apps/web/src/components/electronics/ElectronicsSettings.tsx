import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckCircle2Icon, CircuitBoardIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { electronicsEnvironment, useElectronicsState } from "../../state/electronics";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function ElectronicsSettings() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state } = useElectronicsState(environmentId);
  const probeToolchain = useAtomCommand(electronicsEnvironment.toolchainStatus, {
    reportFailure: false,
  });

  const [kicadPathDraft, setKicadPathDraft] = useState(settings.electronicsKicadCliPath);
  const [ngspicePathDraft, setNgspicePathDraft] = useState(settings.electronicsNgspicePath);
  const [syncedScopeKey, setSyncedScopeKey] = useState(
    `${environmentId ?? ""}:${settings.electronicsKicadCliPath}:${settings.electronicsNgspicePath}`,
  );
  const currentScopeKey = `${environmentId ?? ""}:${settings.electronicsKicadCliPath}:${settings.electronicsNgspicePath}`;
  if (currentScopeKey !== syncedScopeKey) {
    setSyncedScopeKey(currentScopeKey);
    setKicadPathDraft(settings.electronicsKicadCliPath);
    setNgspicePathDraft(settings.electronicsNgspicePath);
  }
  const [probing, setProbing] = useState(false);

  const handleSavePaths = () => {
    updateSettings({
      electronicsKicadCliPath: kicadPathDraft.trim(),
      electronicsNgspicePath: ngspicePathDraft.trim(),
    });
    if (environmentId) {
      setProbing(true);
      void probeToolchain({ environmentId, input: { refresh: true } }).then(() => {
        setProbing(false);
      });
    }
  };

  const handleReprobe = () => {
    if (!environmentId) return;
    setProbing(true);
    void probeToolchain({ environmentId, input: { refresh: true } }).then(() => {
      setProbing(false);
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="electronics" title={gt("Electronics Workbench")}>
        <SettingsRow
          id="electronics-workbench-enabled"
          serverScoped
          settingKeys={["enableElectronicsWorkbench"]}
          title={gt("Enable Electronics Workbench")}
          description={gt(
            "Shows the Electronics tab in the right-hand panel with built-in schematic/PCB/SPICE parsing, path validation, and MNA simulation.",
          )}
          control={
            <Switch
              checked={settings.enableElectronicsWorkbench}
              disabled={!canWrite}
              aria-label={gt("Enable Electronics Workbench")}
              onCheckedChange={(checked) => {
                updateSettings({ enableElectronicsWorkbench: Boolean(checked) });
              }}
            />
          }
        />

        <SettingsRow
          id="electronics-agent-access"
          serverScoped
          settingKeys={["enableAgentElectronicsAccess"]}
          title={gt("Allow agent MCP access")}
          description={gt(
            "Lets agents list, inspect, trace paths, validate ERC/DRC, simulate circuits, and open designs in the Electronics panel.",
          )}
          control={
            <Switch
              checked={settings.enableAgentElectronicsAccess}
              disabled={!canWrite || !settings.enableElectronicsWorkbench}
              aria-label={gt("Allow agent MCP access")}
              onCheckedChange={(checked) => {
                updateSettings({ enableAgentElectronicsAccess: Boolean(checked) });
              }}
            />
          }
        />

        <SettingsRow
          id="electronics-external-tools"
          serverScoped
          settingKeys={["electronicsAllowExternalTools"]}
          title={gt("Allow local EDA CLI tools")}
          description={gt(
            "Permits running locally installed kicad-cli (ERC/DRC) and ngspice (full nonlinear SPICE simulation). Built-in checks always work without external binaries.",
          )}
          control={
            <Switch
              checked={settings.electronicsAllowExternalTools}
              disabled={!canWrite || !settings.enableElectronicsWorkbench}
              aria-label={gt("Allow local EDA CLI tools")}
              onCheckedChange={(checked) => {
                updateSettings({ electronicsAllowExternalTools: Boolean(checked) });
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="electronics-toolchain" title={gt("Local Toolchain Detection")}>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs text-muted-foreground">
            <T>
              Optional binaries detected on this environment. Leave path overrides blank to
              auto-detect from PATH.
            </T>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[state.toolchain.kicadCli, state.toolchain.ngspice].map((tool) => (
              <div
                key={tool.name}
                className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card/50 p-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-mono font-semibold text-foreground">
                    <CircuitBoardIcon className="size-3.5 text-primary" />
                    {tool.name}
                  </div>
                  <p className="mt-1 truncate text-2xs text-muted-foreground">
                    {tool.available
                      ? (tool.version ?? tool.path ?? gt("Installed"))
                      : gt("Not detected (built-in TypeScript engine active)")}
                  </p>
                </div>
                {tool.available ? (
                  <Badge variant="success">
                    <CheckCircle2Icon className="size-3" />
                    <T>Ready</T>
                  </Badge>
                ) : (
                  <Badge variant="outline">
                    <XCircleIcon className="size-3" />
                    <T>Optional</T>
                  </Badge>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                <T>kicad-cli executable override</T>
              </span>
              <Input
                size="sm"
                value={kicadPathDraft}
                disabled={!canWrite}
                onChange={(e) => setKicadPathDraft(e.target.value)}
                placeholder={gt("Auto-detect from PATH (kicad-cli)")}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                <T>ngspice executable override</T>
              </span>
              <Input
                size="sm"
                value={ngspicePathDraft}
                disabled={!canWrite}
                onChange={(e) => setNgspicePathDraft(e.target.value)}
                placeholder={gt("Auto-detect from PATH (ngspice)")}
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" disabled={!canWrite} onClick={handleSavePaths}>
              <T>Save overrides</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!environmentId || probing}
              onClick={handleReprobe}
            >
              <RefreshCwIcon className="size-3.5" />
              <T>Re-detect binaries</T>
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
