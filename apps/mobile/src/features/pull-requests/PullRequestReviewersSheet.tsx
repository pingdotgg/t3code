import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { readableFailure } from "./pullRequestDetail.logic";
import { parseRoutePositiveInt, type PullRequestDetailRouteParams } from "./pullRequestNavigation";

type PullRequestReviewersSheetProps = StaticScreenProps<PullRequestDetailRouteParams>;

export function PullRequestReviewersSheet(props: PullRequestReviewersSheetProps) {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const number = parseRoutePositiveInt(props.route.params.number);
  const repository = props.route.params.repository;
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const candidatesQuery = useEnvironmentQuery(
    number === null
      ? null
      : pullRequestEnvironment.reviewerCandidates({
          environmentId,
          input: { projectId, repository, number },
        }),
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });
  const needle = query.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      (candidatesQuery.data?.candidates ?? []).filter(
        (candidate) =>
          needle.length === 0 ||
          candidate.login.toLowerCase().includes(needle) ||
          (candidate.name ?? "").toLowerCase().includes(needle),
      ),
    [candidatesQuery.data, needle],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Reviewers" onBack={() => navigation.goBack()} />
      ) : (
        <NativeStackScreenOptions options={{ title: "Reviewers" }} />
      )}
      <View className="px-4 pb-2 pt-3">
        <TextInput
          accessibilityLabel="Search reviewers"
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder="Search people"
          placeholderTextColorClassName="accent-placeholder"
          className="min-h-11 rounded-2xl bg-input px-3.5 py-2 text-base font-sans text-foreground"
          value={query}
        />
      </View>
      {candidatesQuery.isPending && candidatesQuery.data === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : candidatesQuery.error && candidatesQuery.data === null ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState title="Could not load reviewers" detail={candidatesQuery.error} />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          contentInsetAdjustmentBehavior="automatic"
        >
          {candidates.length === 0 ? (
            <EmptyState
              variant="plain"
              title="No matching people"
              detail="The host did not return anyone for this search."
            />
          ) : (
            <View className="overflow-hidden rounded-[20px] bg-card">
              {candidates.map((candidate, index) => (
                <Pressable
                  key={candidate.id}
                  disabled={pendingId !== null || number === null}
                  onPress={() => {
                    if (number === null) return;
                    void (async () => {
                      setPendingId(candidate.id);
                      try {
                        const result = await requestReviewers({
                          environmentId,
                          input: {
                            projectId,
                            repository,
                            number,
                            reviewers: [{ id: candidate.id, kind: candidate.kind }],
                            requested: !candidate.isRequested,
                          },
                        });
                        if (AsyncResult.isFailure(result)) {
                          Alert.alert(
                            "Could not update reviewers",
                            readableFailure(
                              squashAtomCommandFailure(result),
                              "The host refused this reviewer change.",
                            ),
                          );
                          return;
                        }
                        candidatesQuery.refresh();
                      } finally {
                        setPendingId(null);
                      }
                    })();
                  }}
                  className="flex-row items-center justify-between px-4 py-3"
                  style={{
                    borderBottomWidth: index === candidates.length - 1 ? 0 : 1,
                    borderBottomColor: "rgba(127,127,127,0.18)",
                  }}
                >
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                      {candidate.name ?? candidate.login}
                    </Text>
                    {candidate.name ? (
                      <Text className="text-xs text-foreground-muted">{candidate.login}</Text>
                    ) : null}
                  </View>
                  <Text
                    className={cn(
                      "text-xs font-t3-bold",
                      candidate.isRequested ? "text-primary" : "text-foreground-muted",
                    )}
                  >
                    {pendingId === candidate.id ? "…" : candidate.isRequested ? "Requested" : "Ask"}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {candidatesQuery.data?.truncated === true ? (
            <Text className="mt-3 text-xs text-foreground-muted">
              The host has more people with access than this list shows.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
