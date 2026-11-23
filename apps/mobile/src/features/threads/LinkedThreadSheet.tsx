import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  isLinkedThreadWorking,
  linkedThreadFailure,
  type LinkedThreadFailure,
  type LinkedThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import {
  toolCallLines,
  turnItemDetailRevision,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT, useLocale, useMessages } from "gt-react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useEnvironments } from "../../state/environments";
import {
  buildThreadFeed,
  createThreadFeedCache,
  formatItemFullDetail,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "../../lib/threadActivity";
import { useConnectLinkedEnvironment, useLinkedThreadView } from "../../state/linkedThread";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import type { LinkedThreadRouteParams } from "./linkedThreadRoute";
import { ReadOnlyComposerBar } from "./ReadOnlyComposerBar";
import { ThreadInspectorHeader, type ThreadInspectorPresentation } from "./thread-inspector-header";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

function ActivityRow(props: {
  readonly activity: ThreadFeedActivity;
  readonly target: LinkedThreadTarget;
}) {
  const { activity, target } = props;
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const row = activity.projectedItem;
  // The stream leaves long output out; an open row reads its item in full through the link.
  const fetched = useEnvironmentQuery(
    open && activity.fetchesDetail
      ? peerLinkEnvironment.threadItem({
          environmentId: target.viaEnvironmentId,
          input: {
            environmentId: target.environmentId,
            threadId: row.sourceThreadId,
            itemId: row.sourceItemId,
            revision: turnItemDetailRevision(row.item),
          },
        })
      : null,
  );
  const fetchedItem = fetched.data?.item ?? null;
  const shownItem = fetchedItem ?? row.item;
  // A command or tool call reads as what was called, as on the thread screen; only an item with
  // no call to show falls back to its full detail.
  const call = !open
    ? null
    : shownItem.type === "command_execution"
      ? toolCallLines({ command: shownItem.input })
      : shownItem.type === "dynamic_tool"
        ? toolCallLines({ args: shownItem.input })
        : null;
  const callText = call
    ? (call.command ??
      call.args?.map(([key, value]) => `${key}: ${value}`).join("\n") ??
      call.argsText)
    : null;
  const body = !open
    ? null
    : call
      ? callText
      : fetchedItem
        ? formatItemFullDetail(row, fetchedItem)
        : (activity.getFullDetail() ?? activity.detail);
  const output = !open
    ? null
    : !activity.fetchesDetail
      ? turnItemOutputText(row.item)
      : fetchedItem
        ? (turnItemOutputText(fetchedItem) ?? gt("No output."))
        : fetched.error
          ? gt("Couldn't load output: {error}", { error: fetched.error })
          : fetched.data
            ? gt("Output is no longer available.")
            : gt("Loading output…");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      disabled={!activity.canExpand}
      onPress={() => setOpen(!open)}
      className="active:opacity-70"
    >
      <Text
        numberOfLines={open ? undefined : 1}
        className={`font-mono text-xs ${activity.status === "failure" ? "text-danger-foreground" : "text-foreground-muted"}`}
      >
        {activity.summary}
      </Text>
      {body ? (
        <View className="mt-1 rounded-lg bg-subtle p-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {body}
          </Text>
        </View>
      ) : null}
      {output ? (
        <View className="mt-1 rounded-lg bg-subtle p-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {output}
          </Text>
        </View>
      ) : null}
      {open && fetched.error ? (
        <View className="mt-1.5 self-start">
          <Button
            size="compact"
            tone="secondary"
            label={gt("Try again")}
            onPress={fetched.refresh}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One entry of the thread's feed, as the thread screen's own feed model has it. Only reading
 * rows are drawn: what needs the thread's environment (files, visuals, apps) is left out.
 */
function LinkedThreadEntry(props: {
  readonly entry: ThreadFeedEntry;
  readonly target: LinkedThreadTarget;
}) {
  const { entry } = props;
  const styles = useMarkdownPreviewStyles();
  if (entry.type === "activity-group") {
    return (
      <View className="gap-1.5">
        {entry.activities.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} target={props.target} />
        ))}
      </View>
    );
  }
  // A message the agent sent with a tool reads as its own words, as on the thread screen.
  if (entry.type === "sent-message") {
    return <SelectableMarkdownText markdown={entry.text} textStyle={styles.nativeTextStyle} />;
  }
  if (entry.type === "user-command") {
    const text = entry.markdown ?? entry.error ?? "";
    return text === "" ? null : (
      <SelectableMarkdownText markdown={text} textStyle={styles.nativeTextStyle} />
    );
  }
  if (entry.type !== "message" || entry.message.text.trim() === "") return null;
  return entry.message.role === "user" ? (
    <View className="max-w-[88%] self-end rounded-2xl bg-user-bubble px-3.5 py-2.5">
      <Text selectable className="text-sm text-user-bubble-foreground">
        {entry.message.text}
      </Text>
    </View>
  ) : (
    <SelectableMarkdownText markdown={entry.message.text} textStyle={styles.nativeTextStyle} />
  );
}

function FailureCard(props: {
  readonly failure: LinkedThreadFailure;
  readonly stale: boolean;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3"
    >
      <Text className="font-t3-medium text-sm text-danger-foreground">{props.failure.title}</Text>
      <Text className="text-sm text-danger-foreground">
        {props.failure.detail}
        {props.stale ? ` ${gt("Showing what was read before.")}` : ""}
      </Text>
      {props.failure.retryable ? (
        <View className="mt-2 self-start">
          <Button size="compact" tone="secondary" label={gt("Try again")} onPress={props.onRetry} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Stands where a composer would: the thread takes no messages from here. `action` is the one way
 * forward it offers, and `notice` what came of it.
 */
function LinkedThreadComposer(props: {
  /** The linked environment the thread is on. */
  readonly label: string;
  /** The environment that reads it. */
  readonly via: string;
  readonly working: boolean;
  readonly action?: React.ReactNode;
  readonly notice?: React.ReactNode;
}) {
  const { label, via } = props;
  const gt = useGT();
  return (
    <>
      {props.notice}
      <ReadOnlyComposerBar>
        <View accessible className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
            <T>Read-only</T>
          </Text>
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {props.working
              ? gt("On {label} via {via} · Working", { label, via })
              : gt("On {label} via {via}", { label, via })}
          </Text>
        </View>
        {props.action}
      </ReadOnlyComposerBar>
    </>
  );
}

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const appIsActive = () => AppState.currentState === "active";

/**
 * A linked environment's thread, read through the environment this app is connected to. The app
 * never connects to the linked one, so the view only reads. It shows in the inspector, where
 * `presentation` maximizes it, or as its own screen, where `presentation` closes it.
 */
export function LinkedThreadView(props: {
  readonly target: LinkedThreadTarget;
  /** Closes the screen by going back when absent. */
  readonly presentation?: ThreadInspectorPresentation;
}) {
  const { target } = props;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const navigation = useNavigation();
  const presentation = props.presentation ?? { onClose: () => navigation.goBack() };
  const inInspector = "onMaximize" in presentation;
  const insets = useSafeAreaInsets();
  const via =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === target.viaEnvironmentId,
    )?.label ?? gt("this environment");
  // The stream runs only while this screen is the one being looked at.
  const focused = useIsFocused();
  const appActive = useSyncExternalStore(subscribeAppState, appIsActive);
  const { view, error, retry } = useLinkedThreadView(target, focused && appActive);
  const projection = view?.thread.projection ?? null;
  const label = target.label;
  const failure = error === null ? null : linkedThreadFailure(error, { via, label }, m);
  const [feedCache] = useState(() => createThreadFeedCache());
  const feed =
    projection === null
      ? []
      : buildThreadFeed(projection.visibleTurnItems, {
          attempts: projection.attempts,
          nodes: projection.nodes,
          cache: feedCache,
          resolve: m,
          locale,
        });
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Follows new items only while the reader is already at the end.
  const atEnd = useRef(true);
  const showHistoryError =
    view !== null && view.thread.historyCursor !== null && view.history.failed;
  const lastLayoutHadHistoryError = useRef(false);
  const working = projection !== null && isLinkedThreadWorking(projection);
  const connection = useConnectLinkedEnvironment(target);
  const connectState = connection.state;
  const openThread = useOpenLinkedThread();
  const shown = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records unmount, so a connect that resolves after the view is gone navigates nowhere
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const connect = async () => {
    const outcome = await connection.connect();
    if (outcome.type === "unreachable" || !shown.current) return;
    // The read-only view gives way either way: the thread opens where the app is now connected,
    // or the add-environment screen takes its place. In the inspector the thread replaces it there.
    if (outcome.type === "connected") {
      if (!inInspector) navigation.goBack();
      openThread({ environmentId: target.environmentId, threadId: target.threadId });
      return;
    }
    if (inInspector) navigation.navigate("ConnectionsNew", { linked: target.environmentId });
    else {
      navigation.dispatch(StackActions.replace("ConnectionsNew", { linked: target.environmentId }));
    }
  };
  return (
    <View collapsable={false} className={inInspector ? "flex-1 bg-screen" : "flex-1 bg-sheet"}>
      <ThreadInspectorHeader
        {...presentation}
        title={projection?.thread.title || target.title || gt("Thread on {label}", { label })}
      />
      <ScreenContent>
        <ScrollView
          ref={scroll}
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-3 px-5 pb-3 pt-3"
          // An earlier page lands above what is being read without moving it.
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          scrollEventThrottle={64}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            atEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
          }}
          onContentSizeChange={() => {
            // A page error can resize the top of a short feed whose reader is also near the end.
            const historyErrorChanged = lastLayoutHadHistoryError.current !== showHistoryError;
            lastLayoutHadHistoryError.current = showHistoryError;
            if (atEnd.current && !historyErrorChanged) {
              scroll.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          {view === null || projection === null ? (
            failure === null ? (
              <View className="flex-row items-center gap-2 pt-6">
                <AppActivityIndicator size="small" />
                <Text className="text-sm text-foreground-muted">
                  {gt("Reading from {label}…", { label })}
                </Text>
              </View>
            ) : (
              <FailureCard failure={failure} stale={false} onRetry={retry} />
            )
          ) : (
            <>
              {view.thread.historyCursor !== null ? (
                <View className="flex-row flex-wrap justify-center">
                  <Button
                    size="compact"
                    tone="text"
                    label={gt("Load earlier")}
                    loading={view.history.loading}
                    disabled={view.history.loading}
                    onPress={view.loadEarlier}
                  />
                  {showHistoryError ? (
                    <Text
                      accessibilityLiveRegion="polite"
                      accessibilityRole="alert"
                      className="w-full text-center text-xs text-danger-foreground"
                    >
                      {gt("Could not load earlier turns. Try again.")}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {feed.length === 0 ? (
                <Text className="text-sm text-foreground-muted">
                  <T>Nothing in this thread yet.</T>
                </Text>
              ) : null}
              {feed.map((entry) => (
                <LinkedThreadEntry key={entry.id} entry={entry} target={target} />
              ))}
              {failure === null ? null : <FailureCard failure={failure} stale onRetry={retry} />}
            </>
          )}
        </ScrollView>
        <View
          className="gap-2 px-3 pt-1.5"
          style={{ paddingBottom: Math.max(insets.bottom, 10) + 6 }}
        >
          <LinkedThreadComposer
            label={label}
            via={via}
            working={working}
            action={
              <Button
                tone="secondary"
                label={gt("Connect to interact")}
                loading={connectState.phase === "connecting"}
                onPress={() => void connect()}
              />
            }
            notice={
              connectState.phase === "connecting" ? (
                <Text
                  accessibilityLiveRegion="polite"
                  className="px-2 text-xs text-foreground-muted"
                >
                  {gt("Connecting to {environment}...", { environment: label })}
                </Text>
              ) : connectState.phase === "unreachable" ? (
                <View
                  accessibilityLiveRegion="polite"
                  className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3"
                >
                  <Text className="font-t3-medium text-sm text-danger-foreground">
                    {gt("{label} is not reachable from this device", {
                      label: connectState.label,
                    })}
                  </Text>
                  <Text className="text-sm text-danger-foreground">
                    <T>
                      Join a network it is on, such as its Tailscale network, and try again. You can
                      keep reading here.
                    </T>
                  </Text>
                </View>
              ) : null
            }
          />
        </View>
      </ScreenContent>
    </View>
  );
}

/** The read-only view as its own screen: a sheet, or the whole screen when maximized from the inspector. */
export function LinkedThreadSheet({ route }: StaticScreenProps<LinkedThreadRouteParams>) {
  const { viaEnvironmentId, environmentId, threadId, label, title } = route.params;
  return (
    <LinkedThreadView
      key={`${viaEnvironmentId}:${environmentId}:${threadId}`}
      target={{
        viaEnvironmentId: EnvironmentId.make(viaEnvironmentId),
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make(threadId),
        label,
        title: title ?? null,
      }}
    />
  );
}
