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
  const permission = useAtomValue(extensionEnvironment.install.permissionAtom(environmentId));
  const install = useAtomCommand(extensionEnvironment.install);
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState<"local" | "npm">("local");
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <View className="gap-4 rounded-2xl bg-grouped-card p-4">
      <Text className="font-t3-semibold">Install an extension</Text>
      <SegmentedControl
        options={[
          { value: "local", label: "Local folder" },
          { value: "npm", label: "npm package" },
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
          {sourceType === "local" ? "Folder on this server" : "Package name"}
        </Text>
        <TextInput
          accessibilityLabel="Extension source"
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
            label={browsing ? "Hide folders" : "Browse server folders"}
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
            Use a package name or pin a version with @version.
          </Text>
        )}
      </View>
      {browsing && sourceType === "local" && (
        <FolderBrowser
          environment={{ environmentId, platform }}
          pathInput={source}
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
        Extensions have full access to this server. Only install code you trust.
      </Text>
      {error && (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <Button
        label={busy ? "Installing..." : "Install extension"}
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
            .catch((cause: unknown) => setError(extensionFailureMessage(cause)))
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}
