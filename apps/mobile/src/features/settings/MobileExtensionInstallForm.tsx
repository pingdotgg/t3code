import { m } from "../../i18n/messages";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
} from "@t3tools/client-runtime/state/projects";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { FolderBrowser } from "../projects/FolderBrowser";

export function MobileExtensionInstallForm({
  environmentId,
  baseDirectory,
  platform,
  onInstalled,
}: {
  environmentId: EnvironmentId;
  baseDirectory: string;
  platform: string;
  onInstalled: () => void;
}) {
  const gt = useGT();
  const permission = useAtomValue(extensionEnvironment.install.permissionAtom(environmentId));
  const install = useAtomCommand(extensionEnvironment.install);
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState<"local" | "npm">("local");
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <View className="gap-4 rounded-2xl bg-grouped-card p-4">
      <Text className="font-t3-semibold">
        <T>Install an extension</T>
      </Text>
      <SegmentedControl
        options={[
          { value: "local", label: gt("Local folder") },
          { value: "npm", label: gt("npm package") },
        ]}
        selected={sourceType}
        onSelect={(type) => {
          if (busy) return;
          setSourceType(type);
          setSource("");
          setBrowsing(false);
          setError(null);
        }}
        variant="card"
      />
      <View className="gap-2">
        <Text className="text-sm font-t3-medium">
          {sourceType === "local" ? gt("Folder on this server") : gt("Package name")}
        </Text>
        <TextInput
          accessibilityLabel={gt("Extension source")}
          className="rounded-xl border border-border bg-field px-3 py-3 text-base text-foreground"
          value={source}
          onChangeText={setSource}
          editable={!busy}
          placeholder={sourceType === "local" ? "/path/to/extension" : "@scope/package@version"}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {sourceType === "local" ? (
          <Button
            label={browsing ? gt("Hide folders") : gt("Browse server folders")}
            icon="folder"
            tone="text"
            size="compact"
            disabled={busy || !permission}
            onPress={() => {
              if (!source.trim()) setSource(getAddProjectInitialQuery(baseDirectory));
              setBrowsing(!browsing);
            }}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">
            <T>Use a package name or pin a version with @version.</T>
          </Text>
        )}
      </View>
      {browsing && sourceType === "local" && (
        <FolderBrowser
          environment={{ environmentId, platform }}
          pathInput={source}
          disabled={busy}
          setPathInput={setSource}
          navigateToBrowsePath={async ({ browseDirectoryPath, selectedDirectoryName }) => {
            setSource(
              selectedDirectoryName
                ? appendBrowsePathSegment(browseDirectoryPath, selectedDirectoryName)
                : ensureBrowseDirectoryPath(browseDirectoryPath),
            );
            return true;
          }}
        />
      )}
      <Text className="text-xs leading-4 text-foreground-muted">
        <T>Extensions have full access to this server. Only install code you trust.</T>
      </Text>
      {error && (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <Button
        label={busy ? gt("Installing...") : gt("Install extension")}
        icon="plus"
        tone="primary"
        fullWidth
        disabled={busy || !source.trim() || !permission}
        onPress={() => {
          setBusy(true);
          setError(null);
          void install({ environmentId, input: { source, sourceType } })
            .then((result) => {
              extensionCommandValue(result);
              setSource("");
              setBrowsing(false);
              onInstalled();
            })
            .catch((cause: unknown) => setError(extensionFailureMessage(cause, m)))
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}
