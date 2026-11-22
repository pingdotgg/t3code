import { msg, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  conversationSummaryPassLabel,
  conversationSummarySourceLabel,
  conversationSummarySourceRangeLabel,
  type ConversationSummarySourceCursor,
} from "@t3tools/client-runtime/conversationSummaries";
import { KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL } from "@t3tools/client-runtime/projectKnowledge";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  conversationSummarySourceKey,
  type ConversationSummaryId,
  type ConversationSummaryRead,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  conversationSummaries,
  conversationSummariesSupportedAtom,
  conversationSummarySearchSupportedAtom,
} from "../../state/conversationSummaries";
import { useEnvironmentQuery } from "../../state/query";
import { ExternalHistoryThreadButton } from "../external-history/ExternalHistoryRouteScreen";

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
  const m = useMessages();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const supported = useAtomValue(conversationSummariesSupportedAtom(environmentId));
  const searchSupported = useAtomValue(conversationSummarySearchSupportedAtom(environmentId));
  const focused = useIsFocused();
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title={m(msg("Conversation summaries"))} onBack={() => navigation.goBack()} />
      <ScreenContent>
        {supported && focused ? (
          <SummaryPages
            key={`${environmentId}:${projectId}:${threadId}:${searchSupported}`}
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
            searchSupported={searchSupported}
          />
        ) : !supported ? (
          <Text className="p-5 text-sm text-foreground-muted">
            {m(
              msg(
                "This environment does not support conversation summaries. Update the server to use them.",
              ),
            )}
          </Text>
        ) : null}
      </ScreenContent>
    </View>
  );
}

function SummaryText({ read }: { readonly read: ConversationSummaryRead }) {
  const m = useMessages();
  if (read.state === "stale")
    return (
      <Text className="text-sm text-foreground-muted">
        {m(msg("Outdated: {reason}. The summary text is hidden and agents no longer receive it."), {
          reason: m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[read.reason]),
        })}
      </Text>
    );
  const position = new Map(
    read.summary.sources.map((source, index) => [conversationSummarySourceKey(source), index + 1]),
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

function SummaryPages(props: Scope & { readonly searchSupported: boolean }) {
  const m = useMessages();
  const [cursors, setCursors] = useState<ReadonlyArray<ConversationSummaryId>>([]);
  const [selected, setSelected] = useState<ConversationSummaryId | null>(null);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const search = () => {
    setQuery(searchText.trim());
    setCursors([]);
  };
  return (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 16 }}
    >
      <ExternalHistoryThreadButton
        environmentId={props.environmentId}
        projectId={props.projectId}
      />
      {selected !== null ? (
        <>
          <Button
            label={m(msg("Back to summaries"))}
            tone="text"
            onPress={() => setSelected(null)}
          />
          <SummarySources key={selected} {...props} summaryId={selected} />
        </>
      ) : (
        <>
          {props.searchSupported ? (
            <View className="gap-2">
              <AppTextInput
                accessibilityLabel={m(msg("Search summaries"))}
                placeholder={m(msg("Search summary text"))}
                value={searchText}
                onChangeText={setSearchText}
                maxLength={256}
                returnKeyType="search"
                onSubmitEditing={search}
              />
              <View className="flex-row gap-2">
                <Button label={m(msg("Search"))} onPress={search} />
                {searchText || query ? (
                  <Button
                    label={m(msg("Clear"))}
                    tone="text"
                    onPress={() => {
                      setSearchText("");
                      setQuery("");
                      setCursors([]);
                    }}
                  />
                ) : null}
              </View>
            </View>
          ) : (
            <Text className="text-xs text-foreground-muted">
              {m(msg("Update this server to search summaries."))}
            </Text>
          )}
          <SummaryList
            key={JSON.stringify([query, cursors.at(-1)])}
            {...props}
            query={query}
            cursors={cursors}
            onEarlier={() => setCursors((current) => current.slice(0, -1))}
            onLater={(cursor) => setCursors((current) => [...current, cursor])}
            onSelect={setSelected}
          />
        </>
      )}
    </ScrollView>
  );
}

function SummaryList(
  props: Scope & {
    readonly query: string;
    readonly cursors: ReadonlyArray<ConversationSummaryId>;
    readonly onEarlier: () => void;
    readonly onLater: (cursor: ConversationSummaryId) => void;
    readonly onSelect: (id: ConversationSummaryId) => void;
  },
) {
  const m = useMessages();
  const cursor = props.cursors.at(-1);
  const query = useEnvironmentQuery(
    conversationSummaries.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
        ...(props.query ? { query: props.query } : {}),
      },
    }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data)
    return <Text className="text-foreground-muted">{m(msg("Loading summaries…"))}</Text>;
  const { enabled, lastPass, summaries, nextCursor } = query.data;
  return (
    <>
      <Text className="text-sm text-foreground-muted">
        {m(
          msg(
            "Model-written summaries of older messages and tool output. They can replace history that would not fit in a handoff; sources are kept unchanged.",
          ),
        )}
      </Text>
      {!enabled ? (
        <Text className="text-sm text-foreground-muted">
          {m(
            msg(
              "Summarize older messages is off for this project. You can turn it on in Settings.",
            ),
          )}
        </Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {lastPass
          ? conversationSummaryPassLabel(lastPass, m)
          : m(
              msg(
                "No summary pass has run yet. Summaries are written after a turn completes and enough older messages have settled.",
              ),
            )}
      </Text>
      {summaries.length === 0 ? (
        <Text>
          {props.query
            ? m(msg("No summaries match your search."))
            : m(msg("This thread has no summaries yet."))}
        </Text>
      ) : null}
      {summaries.map((read) => {
        const id = read.state === "available" ? read.summary.id : read.id;
        const sourceCount =
          read.state === "available" ? read.summary.sources.length : read.sourceCount;
        const createdAt = read.state === "available" ? read.summary.createdAt : read.createdAt;
        return (
          <View key={id} className="gap-3 rounded-xl border border-border p-4">
            <Text className="text-xs text-foreground-muted">
              {m(msg("{count, plural, one {# source} other {# sources}} · written {date}"), {
                count: sourceCount,
                date: new Date(createdAt).toLocaleString(),
              })}
            </Text>
            <SummaryText read={read} />
            <Button label={m(msg("Show sources"))} tone="text" onPress={() => props.onSelect(id)} />
          </View>
        );
      })}
      {props.cursors.length > 0 || nextCursor !== null ? (
        <View className="flex-row justify-between gap-3">
          <Button
            label={m(msg("Earlier summaries"))}
            disabled={props.cursors.length === 0}
            onPress={props.onEarlier}
          />
          <Button
            label={m(msg("Later summaries"))}
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
  const [cursors, setCursors] = useState<ReadonlyArray<ConversationSummarySourceCursor>>([]);
  const cursor = cursors.at(-1) ?? { offset: 0, textOffset: 0 };
  return (
    <SummarySourcePage
      key={`${cursor.offset}:${cursor.textOffset}`}
      {...props}
      cursor={cursor}
      hasPrevious={cursors.length > 0}
      onPrevious={() => setCursors((current) => current.slice(0, -1))}
      onNext={(nextCursor) => setCursors((current) => [...current, nextCursor])}
    />
  );
}

function SummarySourcePage(
  props: Scope & {
    readonly summaryId: ConversationSummaryId;
    readonly cursor: ConversationSummarySourceCursor;
    readonly hasPrevious: boolean;
    readonly onPrevious: () => void;
    readonly onNext: (cursor: ConversationSummarySourceCursor) => void;
  },
) {
  const m = useMessages();
  const { offset, textOffset } = props.cursor;
  const query = useEnvironmentQuery(
    conversationSummaries.expand({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        summaryId: props.summaryId,
        offset,
        textOffset,
        limit: 6,
        maxChars: 12_000,
      },
    }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data)
    return <Text className="text-foreground-muted">{m(msg("Loading sources…"))}</Text>;
  const { summary, sources, nextOffset, nextTextOffset } = query.data;
  return (
    <>
      <SummaryText read={summary} />
      {sources.map(({ ref, result }, index) => (
        <View
          key={conversationSummarySourceKey(ref)}
          className="gap-2 rounded-xl border border-border p-4"
        >
          <Text selectable className="text-xs text-foreground-muted">
            #{offset + index + 1} · {conversationSummarySourceLabel(ref, result, m)}
          </Text>
          {conversationSummarySourceRangeLabel(ref, result, m) ? (
            <Text className="text-xs text-foreground-muted">
              {conversationSummarySourceRangeLabel(ref, result, m)}
            </Text>
          ) : null}
          <Text selectable className="text-sm text-foreground">
            {result.state === "available"
              ? result.text
              : m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[result.reason]) + "."}
          </Text>
        </View>
      ))}
      <View className="flex-row justify-between gap-3">
        <Button
          label={m(msg("Previous sources"))}
          disabled={!props.hasPrevious}
          onPress={props.onPrevious}
        />
        <Button
          label={m(msg("Next sources"))}
          disabled={nextOffset === null}
          onPress={() => {
            if (nextOffset !== null)
              props.onNext({ offset: nextOffset, textOffset: nextTextOffset ?? 0 });
          }}
        />
      </View>
    </>
  );
}
