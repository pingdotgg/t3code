import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { openSettings } from "../settings/settings-navigation";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import type { EnvironmentId, ModelSelection, ServerConfig, ThreadId } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "@t3tools/shared/profiles";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { selectThreadModel } from "../../state/thread-model-selection";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function ProfilePicker(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  selection: ModelSelection;
  config: ServerConfig | null;
  disabled: boolean;
  draftKey?: string;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  // Settings → Refresh and opening the menu update this query, not the connection's config copy.
  const fresh = useEnvironmentQuery(
    serverEnvironment.profileConfig({ environmentId: props.environmentId, input: {} }),
  );
  const catalog = fresh.data?.profiles ?? props.config?.profiles;
  if (!catalog) return null;
  const providers = props.config?.providers ?? [];
  const driver = providers.find(
    (provider) => provider.instanceId === props.selection.instanceId,
  )?.driver;
  const supported = driver !== undefined && supportsProfiles(driver);
  return (
    <Menu
      accessibilityLabel={gt("Profile", { $context: "noun, agent profile picker" })}
      onOpenMenu={fresh.refresh}
      actions={[
        {
          id: "",
          title: gt("No profile"),
          state: props.selection.profileId ? "off" : "on",
          attributes: { disabled: !supported },
        },
        ...Object.entries(catalog.profiles).map(([id, profile]) => ({
          id,
          title: id,
          subtitle: profile.warning ?? profile.description,
          attributes: { disabled: !supported || Boolean(profile.warning) },
          state: props.selection.profileId === id ? ("on" as const) : ("off" as const),
        })),
        { id: "__edit_profiles__", title: gt("Edit profiles…") },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "__edit_profiles__") {
          openSettings(navigation, "SettingsProfiles", { environmentId: props.environmentId });
          return;
        }
        if (props.disabled || !supported) return;
        const id = nativeEvent.event || null;
        if (id && catalog.profiles[id]?.warning) return;
        const picked = selectProfile(
          props.selection,
          id,
          id ? catalog.profiles[id] : undefined,
          providers,
        );
        const nextDriver = providers.find(
          (provider) => provider.instanceId === picked.selection.instanceId,
        )?.driver;
        if (id && (!nextDriver || !supportsProfiles(nextDriver))) {
          Dialog.alert(gt("Profiles not supported here"));
          return;
        }
        if (props.draftKey)
          updateComposerDraftSettings(props.draftKey, { modelSelection: picked.selection });
        else selectThreadModel(props, picked.selection);
        Dialog.alert(
          gt("Profile selected"),
          `${picked.notice ? `${picked.notice}\n\n` : ""}${gt("Applies at the next session start. Stop and restart the thread to apply immediately.")}`,
        );
      }}
    >
      <Button
        onPress={() => {}}
        tone="text"
        label={supported ? (props.selection.profileId ?? gt("No profile")) : gt("Profiles")}
        accessibilityHint={
          supported
            ? gt("Profile for the next session start")
            : gt("This provider does not use profiles; open profile settings")
        }
        disabled={props.disabled}
      />
    </Menu>
  );
}
