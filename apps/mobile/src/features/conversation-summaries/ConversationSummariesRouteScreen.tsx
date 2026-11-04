import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { conversationSummaryPassLabel } from "@t3tools/client-runtime/conversationSummaries";
import { KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL } from "@t3tools/client-runtime/projectKnowledge";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ConversationSummaryId,
  type ConversationSummaryRead,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  conversationSummaries,
  conversationSummariesSupportedAtom,
} from "../../state/conversationSummaries";
import { useEnvironmentQuery } from "../../state/query";

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export function ConversationSummariesRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly threadId: string;
  }>,
) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const supported = useAtomValue(conversationSummariesSupportedAtom(environmentId));
  const focused = useIsFocused();
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title="Conversation summaries" onBack={() => navigation.goBack()} />
      <ScreenContent>
        {supported && focused ? (
          <SummaryPages
            key={`${environmentId}:${projectId}:${threadId}`}
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
          />
        ) : !supported ? (
          <Text className="p-5 text-sm text-foreground-muted">
            This environment does not support conversation summaries. Update the server to use them.
          </Text>
        ) : null}
      </ScreenContent>
    </View>
  );
}

function SummaryText({ read }: { readonly read: ConversationSummaryRead }) {
  if (read.state === "stale")
    return (
      <Text className="text-sm text-foreground-muted">
        Outdated: {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[read.reason].toLowerCase()}. The summary text
        is hidden and agents no longer receive it.
      </Text>
    );
  const position = new Map(
    read.summary.sources.map((source, index) => [source.messageId, index + 1]),
  );
  return (
    <View className="gap-2">
      {read.summary.statements.map((statement) => (
        <Text
          key={statement.text + statement.citations.join(",")}
          selectable
          className="text-sm text-foreground"
        >
          {statement.text} [{statement.citations.map((id) => "#" + position.get(id)).join(", ")}]
        </Text>
      ))}
    </View>
  );
}

function SummaryPages(props: Scope) {
  const [cursors, setCursors] = useState<ReadonlyArray<ConversationSummaryId>>([]);
  const [selected, setSelected] = useState<ConversationSummaryId | null>(null);
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 16 }}
    >
      {selected !== null ? (
        <>
          <Button label="Back to summaries" tone="text" onPress={() => setSelected(null)} />
          <SummarySources key={selected} {...props} summaryId={selected} />
        </>
      ) : (
        <SummaryList
          key={cursors.at(-1) ?? "first"}
          {...props}
          cursors={cursors}
          onEarlier={() => setCursors((current) => current.slice(0, -1))}
          onLater={(cursor) => setCursors((current) => [...current, cursor])}
          onSelect={setSelected}
        />
      )}
    </ScrollView>
  );
}

function SummaryList(
  props: Scope & {
    readonly cursors: ReadonlyArray<ConversationSummaryId>;
    readonly onEarlier: () => void;
    readonly onLater: (cursor: ConversationSummaryId) => void;
    readonly onSelect: (id: ConversationSummaryId) => void;
  },
) {
  const cursor = props.cursors.at(-1);
  const query = useEnvironmentQuery(
    conversationSummaries.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data) return <Text className="text-foreground-muted">Loading summaries…</Text>;
  const { enabled, lastPass, summaries, nextCursor } = query.data;
  return (
    <>
      <Text className="text-sm text-foreground-muted">
        Model-written summaries of older messages. They can replace history that would not fit in a
        handoff; source messages are kept unchanged.
      </Text>
      {!enabled ? (
        <Text className="text-sm text-foreground-muted">
          Summarize older messages is off for this project. You can turn it on in Settings.
        </Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {lastPass
          ? conversationSummaryPassLabel(lastPass)
          : "No summary pass has run yet. Summaries are written after a turn completes and enough older messages have settled."}
      </Text>
      {summaries.length === 0 ? <Text>This thread has no summaries yet.</Text> : null}
      {summaries.map((read) => {
        const id = read.state === "available" ? read.summary.id : read.id;
        const sourceCount =
          read.state === "available" ? read.summary.sources.length : read.sourceCount;
        const createdAt = read.state === "available" ? read.summary.createdAt : read.createdAt;
        return (
          <View key={id} className="gap-3 rounded-xl border border-border p-4">
            <Text className="text-xs text-foreground-muted">
              {sourceCount} messages · written {new Date(createdAt).toLocaleString()}
            </Text>
            <SummaryText read={read} />
            <Button label="Show source messages" tone="text" onPress={() => props.onSelect(id)} />
          </View>
        );
      })}
      {props.cursors.length > 0 || nextCursor !== null ? (
        <View className="flex-row justify-between gap-3">
          <Button
            label="Earlier summaries"
            disabled={props.cursors.length === 0}
            onPress={props.onEarlier}
          />
          <Button
            label="Later summaries"
            disabled={nextCursor === null}
            onPress={() => {
              if (nextCursor !== null) props.onLater(nextCursor);
            }}
          />
        </View>
      ) : null}
    </>
  );
}

function SummarySources(props: Scope & { readonly summaryId: ConversationSummaryId }) {
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([]);
  const offset = offsets.at(-1) ?? 0;
  return (
    <SummarySourcePage
      key={offset}
      {...props}
      offset={offset}
      onPrevious={() => setOffsets((current) => current.slice(0, -1))}
      onNext={(nextOffset) => setOffsets((current) => [...current, nextOffset])}
    />
  );
}

function SummarySourcePage(
  props: Scope & {
    readonly summaryId: ConversationSummaryId;
    readonly offset: number;
    readonly onPrevious: () => void;
    readonly onNext: (offset: number) => void;
  },
) {
  const { offset } = props;
  const query = useEnvironmentQuery(
    conversationSummaries.expand({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        summaryId: props.summaryId,
        offset,
        limit: 6,
      },
    }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data) return <Text className="text-foreground-muted">Loading messages…</Text>;
  const { summary, sources, nextOffset } = query.data;
  return (
    <>
      <SummaryText read={summary} />
      {sources.map(({ ref, result }, index) => (
        <View key={ref.messageId} className="gap-2 rounded-xl border border-border p-4">
          <Text className="text-xs text-foreground-muted">
            #{offset + index + 1} ·{" "}
            {result.state === "available"
              ? result.role === "user"
                ? "User"
                : "Assistant"
              : "Unavailable"}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {result.state === "available"
              ? result.text
              : KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[result.reason] + "."}
          </Text>
        </View>
      ))}
      <View className="flex-row justify-between gap-3">
        <Button label="Previous messages" disabled={offset === 0} onPress={props.onPrevious} />
        <Button
          label="Next messages"
          disabled={nextOffset === null}
          onPress={() => {
            if (nextOffset !== null) props.onNext(nextOffset);
          }}
        />
      </View>
    </>
  );
}
