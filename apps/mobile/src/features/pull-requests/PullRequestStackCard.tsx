import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestStatus } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";

export function PullRequestStackCard(props: {
  readonly params: PullRequestParams;
  readonly state: PullRequestStackState;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const stack = props.state.stack;
  if (!stack) {
    const summary =
      props.params.initialSummary?.number === props.params.number
        ? props.params.initialSummary.stack
        : undefined;
    if (!summary) return null;
    return (
      <PullRequestCardGroup>
        <PullRequestCardRow
          title="Stack"
          icon="square.3.layers.3d"
          value={`${summary.position} of ${summary.size}`}
          last
        />
      </PullRequestCardGroup>
    );
  }
  const position = stack.layers.findIndex((layer) => layer.number === props.params.number) + 1;
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title="Stack"
        icon="square.3.layers.3d"
        value={`${position} of ${stack.layers.length}`}
        accessibilityLabel={`Stack, ${position} of ${stack.layers.length}${props.state.isFresh ? "" : ", showing saved stack"}`}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === props.params.number;
            const status = pullRequestStatus({
              state: layer.state,
              isDraft: layer.isDraft === true,
            });
            return (
              <View key={layer.number} className={selected ? "bg-subtle-strong" : undefined}>
                <PullRequestCardRow
                  title={layer.title ?? layer.headBranch}
                  icon={status.icon}
                  tint={status.tint}
                  value={selected ? "Current" : status.label}
                  detail={`#${layer.number} · ${index + 1} of ${stack.layers.length}`}
                  onPress={
                    selected
                      ? undefined
                      : () =>
                          navigation.dispatch(
                            StackActions.push("PullRequest", {
                              ...props.params,
                              number: layer.number,
                            }),
                          )
                  }
                  last={index === stack.layers.length - 1}
                />
              </View>
            );
          })}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            Base: {stack.base}. Open a layer to review it or merge the stack through that layer.
          </Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  );
}
