import { linearMoveHint } from "@t3tools/client-runtime/linear/launch-plan";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import {
  updateComposerDraftSettings,
  useComposerDraftLinearIssue,
} from "../../state/use-composer-drafts";

/** Under the new-task heading of a draft started from an issue: where its project came from. */
export function LinearDraftProjectHint(props: {
  readonly draftKey: string | null;
  readonly projectId: string | null;
}) {
  const launch = useComposerDraftLinearIssue(props.draftKey);
  if (!launch) return null;
  const fromMapping = launch.mappedProjectId !== null && launch.mappedProjectId === props.projectId;
  return (
    <Text className="text-center text-sm text-foreground-muted">
      From {launch.identifier}
      {fromMapping ? " · from mapping" : " · no Linear mapping for this project"}
    </Text>
  );
}

/** What sending will write back to Linear; each part toggles for this launch only. */
export function LinearWriteBackRow(props: { readonly draftKey: string | null }) {
  const { draftKey } = props;
  const launch = useComposerDraftLinearIssue(draftKey);
  if (!launch || draftKey === null) return null;
  const moveLabel = linearMoveHint(launch);
  return (
    <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-2">
      {moveLabel !== null ? (
        <Chip
          size="small"
          label={moveLabel}
          selected={launch.moveEnabled}
          accessibilityLabel={`${moveLabel}, ${launch.moveEnabled ? "on" : "off"} for this launch`}
          onPress={() =>
            updateComposerDraftSettings(draftKey, {
              linearIssue: { ...launch, moveEnabled: !launch.moveEnabled },
            })
          }
        />
      ) : null}
      <Chip
        size="small"
        label="comments link"
        selected={launch.commentEnabled}
        accessibilityLabel={`Comment on ${launch.identifier} with a link, ${launch.commentEnabled ? "on" : "off"} for this launch`}
        onPress={() =>
          updateComposerDraftSettings(draftKey, {
            linearIssue: { ...launch, commentEnabled: !launch.commentEnabled },
          })
        }
      />
    </View>
  );
}
