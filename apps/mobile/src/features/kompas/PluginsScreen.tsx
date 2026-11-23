import { PLUGIN_CATALOG } from "@t3tools/client-runtime/state/kompas";
import type { Plugin, PluginState } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { Card, KompasPage } from "./KompasPage";
import { type Kompas, kompasEnvironment, reportFailure } from "./state";

/** The state carries fields the server owns; only the plugin itself is saved back. */
const asPlugin = ({ tools: _tools, needsSignIn: _signIn, error: _error, ...plugin }: PluginState) =>
  plugin;

function readHeader(line: string): Record<string, string> {
  const at = line.indexOf(":");
  return at === -1 ? {} : { [line.slice(0, at).trim()]: line.slice(at + 1).trim() };
}

function usePluginActions(kompas: Kompas) {
  const { environmentId } = kompas;
  const connection = usePreparedConnection(environmentId);
  const savePlugin = useAtomCommand(kompasEnvironment.savePlugin, { reportFailure: false });
  const testPlugin = useAtomCommand(kompasEnvironment.testPlugin, { reportFailure: false });
  const signInPlugin = useAtomCommand(kompasEnvironment.signInPlugin, { reportFailure: false });
  return {
    // The connection result lands in the snapshot, so its own failure needs no alert here.
    save: async (plugin: Plugin) => {
      const saved = reportFailure(await savePlugin({ environmentId, input: plugin }));
      if (saved && plugin.enabled) void testPlugin({ environmentId, input: { id: plugin.id } });
      return saved;
    },
    test: async (id: string) => reportFailure(await testPlugin({ environmentId, input: { id } })),
    signIn: async (id: string) => {
      if (connection._tag !== "Some") return;
      const redirectBaseUrl = connection.value.httpBaseUrl;
      const result = await signInPlugin({ environmentId, input: { id, redirectBaseUrl } });
      if (!reportFailure(result) || result._tag !== "Success") return;
      if (result.value.authorizationUrl !== null) {
        await tryOpenExternalUrl(result.value.authorizationUrl, "provider-auth");
      }
    },
  };
}

function PluginCard(props: { readonly kompas: Kompas; readonly plugin: PluginState }) {
  const { kompas, plugin } = props;
  const gt = useGT();
  const actions = usePluginActions(kompas);
  const removePlugin = useAtomCommand(kompasEnvironment.removePlugin, { reportFailure: false });
  const [showTools, setShowTools] = useState(false);
  const status = plugin.needsSignIn
    ? gt("Sign in needed")
    : (plugin.error ??
      gt("{enabled} of {total} tools", {
        enabled: plugin.tools.filter((tool) => !plugin.disabledTools.includes(tool.name)).length,
        total: plugin.tools.length,
      }));
  return (
    <SettingsSection title={plugin.label} footer={status}>
      <SettingsSwitchRow
        label={gt("On", { $context: "plugin switch" })}
        value={plugin.enabled}
        onValueChange={(enabled) => void actions.save({ ...asPlugin(plugin), enabled })}
      />
      <SettingsSwitchRow
        label={gt("On in every conversation")}
        value={plugin.allConversations}
        onValueChange={(allConversations) =>
          void actions.save({ ...asPlugin(plugin), allConversations })
        }
      />
      {showTools
        ? plugin.tools.map((tool) => (
            <SettingsSwitchRow
              key={tool.name}
              label={tool.title ?? tool.name}
              subtitle={tool.description}
              value={!plugin.disabledTools.includes(tool.name)}
              onValueChange={(on) =>
                void actions.save({
                  ...asPlugin(plugin),
                  disabledTools: on
                    ? plugin.disabledTools.filter((name) => name !== tool.name)
                    : [...plugin.disabledTools, tool.name],
                })
              }
            />
          ))
        : null}
      <View className="flex-row flex-wrap gap-2 bg-grouped-card p-3">
        {plugin.tools.length === 0 ? null : (
          <Button
            size="compact"
            label={showTools ? gt("Hide tools") : gt("Choose tools")}
            onPress={() => setShowTools(!showTools)}
          />
        )}
        <Button
          size="compact"
          label={gt("Test connection")}
          onPress={() => void actions.test(plugin.id)}
        />
        {plugin.transport.type === "http" ? (
          <Button
            size="compact"
            tone={plugin.needsSignIn ? "primary" : "secondary"}
            label={gt("Sign in")}
            onPress={() => void actions.signIn(plugin.id)}
          />
        ) : null}
        <Button
          size="compact"
          tone="text"
          label={gt("Remove")}
          onPress={() =>
            Dialog.confirm({
              title: gt("Remove {plugin} and its saved sign-in?", { plugin: plugin.label }),
              confirmText: gt("Remove"),
              destructive: true,
              onConfirm: () =>
                void removePlugin({
                  environmentId: kompas.environmentId,
                  input: { id: plugin.id },
                }).then(reportFailure),
            })
          }
        />
      </View>
    </SettingsSection>
  );
}

function AddPlugin({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const actions = usePluginActions(kompas);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [header, setHeader] = useState("");
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const add = async (plugin: { name: string; label: string; url: string }, secret = "") => {
    const saved = await actions.save({
      id: uuidv4(),
      name: plugin.name,
      label: plugin.label,
      enabled: true,
      allConversations: true,
      transport: {
        type: "http",
        url: plugin.url,
        headers: readHeader(secret),
      },
      disabledTools: [],
    });
    if (!saved) return;
    setLabel("");
    setUrl("");
    setHeader("");
  };
  return (
    <>
      {PLUGIN_CATALOG.filter(
        (entry) => !kompas.snapshot.plugins.some((plugin) => plugin.name === entry.name),
      ).map((entry) => (
        <Card key={entry.name}>
          <Text className="font-t3-bold text-base">{entry.brand}</Text>
          <Text className="text-sm text-foreground-muted">
            {entry.keyless
              ? gt("Web search for any model. Works without a key, within a free limit.")
              : gt("Web search for any model. Sign in or add a key.")}
          </Text>
          <Button
            tone="primary"
            size="compact"
            label={gt("Add")}
            onPress={() => void add({ name: entry.name, label: entry.brand, url: entry.url })}
          />
        </Card>
      ))}
      <Card>
        <Text className="font-t3-bold text-base">{gt("Add your own")}</Text>
        <TextInput placeholder={gt("Name")} value={label} onChangeText={setLabel} />
        <TextInput
          placeholder={gt("MCP address")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={url}
          onChangeText={setUrl}
        />
        <SecretTextInput
          editable
          accessibilityLabel={gt("Header")}
          onSubmitEditing={setHeader}
          placeholder={gt("Header, for example {value}", { value: "x-api-key: 1234" })}
          value={header}
          onChangeText={setHeader}
        />
        <Button
          tone="primary"
          size="compact"
          label={gt("Save")}
          disabled={name === "" || !/^https?:\/\/\S+$/.test(url.trim())}
          onPress={() => void add({ name, label: label.trim(), url: url.trim() }, header)}
        />
      </Card>
    </>
  );
}

export function PluginsScreen() {
  const gt = useGT();
  return (
    <KompasPage title={gt("Plugins")}>
      {(kompas) => (
        <>
          <Text className="text-sm text-foreground-muted">
            {gt("Add a plugin once and every model can use it, from the next conversation on.")}
          </Text>
          {kompas.snapshot.plugins.map((plugin) => (
            <PluginCard key={plugin.id} kompas={kompas} plugin={plugin} />
          ))}
          <AddPlugin kompas={kompas} />
        </>
      )}
    </KompasPage>
  );
}
