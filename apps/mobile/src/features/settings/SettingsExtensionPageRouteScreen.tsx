import { useExtensionPanelContent } from "./useExtensionPanelContent";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { ExtensionSettingsFields } from "./components/ExtensionSettingsFields";
import { MobileExtensionPanel } from "./MobileExtensionPanel";

export function SettingsExtensionPageRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; extensionId: string; pageId: string }>) {
  const { environmentId, extensionId, pageId } = route.params;
  const query = useEnvironmentQuery(extensionEnvironment.state({ environmentId, input: {} }));
  const entry = query.data?.find((entry) => entry.manifest.id === extensionId && entry.enabled);
  const page = entry?.manifest.settingsPages?.find((page) => page.id === pageId);
  return (
    <SettingsScreen title={page?.title ?? "Extension"}>
      <ScreenScrollView>
        {!entry || !page ? (
          <Text className="p-4">
            {query.error ??
              (query.isPending && query.data === null
                ? "Loading extension..."
                : "This extension page is unavailable on its environment.")}
          </Text>
        ) : (
          <Page
            key={`${environmentId}:${extensionId}:${pageId}:${entry.runtimeId ?? "stopped"}`}
            environmentId={environmentId}
            entry={entry}
            page={page}
          />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function Page({
  environmentId,
  entry,
  page,
}: {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
  page: NonNullable<ExtensionInfo["manifest"]["settingsPages"]>[number];
}) {
  const [error, setError] = useState<string | null>(null);
  const settings = useAtomCommand(extensionEnvironment.settings);
  const permission = useAtomValue(extensionEnvironment.settings.permissionAtom(environmentId));
  const html = useExtensionPanelContent(environmentId, entry, page.panelId);
  return (
    <View className="gap-4 p-4">
      <Text>{page.description ?? entry.manifest.description}</Text>
      {entry.status !== "running" && (
        <Text accessibilityRole="alert">
          {entry.diagnostic ?? "This extension is not running. Reload it in Extensions."}
        </Text>
      )}
      <ExtensionSettingsFields
        entry={entry}
        keys={page.settings ?? []}
        disabled={!permission}
        save={(key, value) => {
          void settings({
            environmentId,
            input: { id: entry.manifest.id, settings: { [key]: value } },
          })
            .then((result) => {
              extensionCommandValue(result);
              setError(null);
            })
            .catch((cause: unknown) => setError(extensionFailureMessage(cause)));
        }}
      />
      {(error || html.error) && <Text accessibilityRole="alert">{error ?? html.error}</Text>}
      {html.isPending && !html.data && <Text>Loading panel...</Text>}
      {html.data && (
        <MobileExtensionPanel environmentId={environmentId} entry={entry} html={html.data} />
      )}
    </View>
  );
}
