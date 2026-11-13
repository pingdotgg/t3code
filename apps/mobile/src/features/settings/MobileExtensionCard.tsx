import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ExtensionSettingsFields } from "./components/ExtensionSettingsFields";
import { MobileExtensionPanel } from "./MobileExtensionPanel";
import { openSettings } from "./settings-navigation";

export function MobileExtensionCard({
  environmentId,
  entry,
}: {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
}) {
  const navigation = useNavigation();
  const [showSettings, setShowSettings] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manage = useAtomCommand(extensionEnvironment.manage);
  const settings = useAtomCommand(extensionEnvironment.settings);
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  const panel = useAtomCommand(extensionEnvironment.panel);
  const permission = useAtomValue(extensionEnvironment.manage.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [argumentsText, setArgumentsText] = useState("{}");
  const [output, setOutput] = useState<string | null>(null);
  const [opened, setOpened] = useState<{
    html: string;
    title: string;
    runtimeId: string | undefined;
  } | null>(null);
  const run = async (operation: () => Promise<void | AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (result) extensionCommandValue(result);
    } catch (error) {
      setError(extensionFailureMessage(error));
    }
    setBusy(false);
  };
  return (
    <View className="gap-4 rounded-2xl bg-grouped-card p-4">
      <View className="flex-row items-start gap-3">
        <View className="size-10 items-center justify-center rounded-xl bg-secondary">
          <SymbolView name="square.grid.2x2" size={22} tintColorClassName="accent-icon-muted" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-semibold">{entry.manifest.name}</Text>
          <Text className="text-xs text-foreground-muted">v{entry.manifest.version}</Text>
        </View>
        <ThemedSwitch
          accessibilityLabel={`Enable ${entry.manifest.name}`}
          value={entry.enabled}
          disabled={busy || !permission}
          onValueChange={(enabled) =>
            void run(() =>
              manage({
                environmentId,
                input: { id: entry.manifest.id, action: enabled ? "enable" : "disable" },
              }),
            )
          }
        />
        <Menu
          title={entry.manifest.name}
          actions={[
            {
              id: "reload",
              title: "Reload",
              attributes: { disabled: busy || !permission || !entry.enabled },
            },
            ...(entry.sourceType === "npm"
              ? [
                  {
                    id: "update",
                    title: "Update package",
                    attributes: { disabled: busy || !permission },
                  },
                ]
              : []),
            {
              id: "uninstall",
              title: "Uninstall",
              attributes: { destructive: true, disabled: busy || !permission },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            const action = nativeEvent.event;
            if (action === "reload" || action === "update" || action === "uninstall")
              void run(() => manage({ environmentId, input: { id: entry.manifest.id, action } }));
          }}
        >
          <Button
            label=""
            accessibilityLabel={`Actions for ${entry.manifest.name}`}
            icon="ellipsis"
            tone="text"
            size="compact"
            disabled={busy || !permission}
            onPress={() => {}}
          />
        </Menu>
      </View>
      <View className="gap-2">
        <Text
          className={
            entry.status === "failed"
              ? "text-xs font-t3-medium text-danger-foreground"
              : "text-xs font-t3-medium text-foreground-muted"
          }
        >
          {entry.status === "running"
            ? "Running on this server"
            : entry.status === "failed"
              ? "Failed to start"
              : entry.status === "starting"
                ? "Starting..."
                : "Disabled"}
        </Text>
        <Text className="text-sm leading-5 text-foreground-muted">
          {entry.manifest.description}
        </Text>
      </View>
      {(entry.diagnostic || error) && (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? entry.diagnostic}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        {entry.enabled &&
          entry.manifest.settingsPages?.map((page) => (
            <Button
              key={page.id}
              label={(entry.manifest.settingsPages?.length ?? 0) === 1 ? "Settings" : page.title}
              icon="gearshape"
              size="compact"
              onPress={() =>
                openSettings(navigation, "SettingsExtensionPage", {
                  environmentId,
                  extensionId: entry.manifest.id,
                  pageId: page.id,
                })
              }
            />
          ))}
      </View>
      {entry.manifest.panels?.map((item) => (
        <Button
          key={item.id}
          label={`Open ${item.title}`}
          icon="arrow.up.right"
          size="compact"
          disabled={busy || !permission || entry.status !== "running"}
          onPress={() =>
            void run(async () => {
              const result = await panel({
                environmentId,
                input: { id: entry.manifest.id, panelId: item.id, runtimeId: entry.runtimeId },
              });
              setOpened({
                html: extensionCommandValue(result),
                title: item.title,
                runtimeId: entry.runtimeId,
              });
            })
          }
        />
      ))}
      {Object.keys(entry.manifest.settings ?? {}).length > 0 && (
        <View className="gap-3">
          <Button
            label="Extension settings"
            icon={showSettings ? "chevron.up" : "chevron.down"}
            tone="text"
            size="compact"
            onPress={() => setShowSettings(!showSettings)}
          />
          {showSettings && (
            <View className="gap-4">
              <ExtensionSettingsFields
                entry={entry}
                disabled={busy || !permission}
                save={(key, value) =>
                  void run(() =>
                    settings({
                      environmentId,
                      input: { id: entry.manifest.id, settings: { [key]: value } },
                    }),
                  )
                }
              />
            </View>
          )}
        </View>
      )}
      {(entry.manifest.commands?.length ?? 0) > 0 && (
        <View className="gap-3">
          <Button
            label="Advanced commands"
            icon={advanced ? "chevron.up" : "chevron.down"}
            tone="text"
            size="compact"
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced && (
            <View className="gap-3">
              <Text className="text-xs leading-4 text-foreground-muted">
                Run commands directly with JSON arguments. Commands are also in the command palette.
              </Text>
              {(entry.manifest.commands?.length ?? 0) > 0 && (
                <TextInput
                  accessibilityLabel="Command arguments (JSON)"
                  className="rounded border border-border p-3 text-foreground"
                  value={argumentsText}
                  onChangeText={setArgumentsText}
                  autoCapitalize="none"
                />
              )}
              {entry.manifest.commands?.map((command) => (
                <Button
                  key={command.id}
                  label={command.title}
                  disabled={busy || !permission || entry.status !== "running"}
                  onPress={() =>
                    void run(async () => {
                      let input: unknown;
                      try {
                        input = JSON.parse(argumentsText);
                      } catch {
                        setError("Enter valid JSON arguments.");
                        return;
                      }
                      const result = await invoke({
                        environmentId,
                        input: {
                          id: entry.manifest.id,
                          kind: "command",
                          name: command.id,
                          input,
                          context: { surface: "mobile" },
                        },
                      });
                      setOutput(JSON.stringify(extensionCommandValue(result), null, 2));
                    })
                  }
                />
              ))}
              {output && (
                <Text selectable className="rounded-xl bg-secondary p-3 text-xs">
                  {output}
                </Text>
              )}
            </View>
          )}
        </View>
      )}
      <Button
        label="Installation details"
        icon={details ? "chevron.up" : "chevron.down"}
        tone="text"
        size="compact"
        onPress={() => setDetails(!details)}
      />
      {details && (
        <View className="gap-1">
          <Text selectable className="text-xs text-foreground-muted">
            {entry.manifest.id}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {entry.sourceType === "local" ? "Local folder" : "npm package"}: {entry.source}
          </Text>
        </View>
      )}
      {opened && entry.status === "running" && opened.runtimeId === entry.runtimeId && (
        <>
          <Button label={`Close ${opened.title}`} onPress={() => setOpened(null)} />
          <MobileExtensionPanel
            key={opened.html}
            environmentId={environmentId}
            entry={entry}
            html={opened.html}
          />
        </>
      )}
    </View>
  );
}
