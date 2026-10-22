import { useRef, useState, type ComponentProps } from "react";
import { View } from "react-native";
import { AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function PullRequestMentionInput({
  params,
  ...props
}: ComponentProps<typeof AppTextInput> & { params: PullRequestParams }) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const cursor = useRef((props.value ?? "").length);
  return (
    <View className="min-w-0 flex-1">
      <AppTextInput
        {...props}
        onSelectionChange={(event) => {
          cursor.current = event.nativeEvent.selection.end;
          props.onSelectionChange?.(event);
        }}
        onChangeText={(text) => {
          const end = Math.max(
            0,
            Math.min(text.length, cursor.current + text.length - (props.value ?? "").length),
          );
          const match = /(?:^|\s)@([^\s<>@]*)$/.exec(text.slice(0, end));
          setQuery(
            detail.data?.provider === "azure-devops" && match
              ? { start: end - match[1]!.length - 1, end, text: match[1]! }
              : null,
          );
          props.onChangeText?.(text);
        }}
      />
      {query ? (
        <MentionChoices
          params={params}
          query={query.text}
          select={(id) => {
            const current = props.value ?? "";
            props.onChangeText?.(
              `${current.slice(0, query.start)}@<${id}> ${current.slice(query.end)}`,
            );
            setQuery(null);
          }}
        />
      ) : null}
    </View>
  );
}
function MentionChoices({
  params,
  query,
  select,
}: {
  params: PullRequestParams;
  query: string;
  select: (id: string) => void;
}) {
  const target = pullRequestTarget(params);
  const people = useEnvironmentQuery(composerPullRequests.reviewerCandidates(target));
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const choices = new Map(
    (people.data?.candidates ?? []).map((person) => [person.id, person.name ?? person.login]),
  );
  for (const [id, name] of Object.entries(activity.data?.identities ?? {}))
    if (!id.startsWith("000000")) choices.set(id, name);
  return (
    <View className="flex-row flex-wrap gap-1 p-1">
      {[...choices]
        .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 6)
        .map(([id, name]) => (
          <Button key={id} label={`@${name}`} onPress={() => select(id)} />
        ))}
    </View>
  );
}
