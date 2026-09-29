import {
  createAgentSessionResumeAtoms,
  filterResumableSessions,
  resumableSessionLocation,
} from "@t3tools/client-runtime/state/agentSessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ResumableAgentSession,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import { connectionAtomRuntime } from "../../connection/runtime";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const { list: sessionList, attach: sessionAttach } =
  createAgentSessionResumeAtoms(connectionAtomRuntime);

/** Browse external sessions on the selected environment and return the attached thread to navigation. */
export function ResumeSessionPicker(props: {
  projectRef: ScopedProjectRef;
  disabled: boolean;
  onResume: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [search, setSearch] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const insets = useSafeAreaInsets();
  const queryAtom = useMemo(
    () =>
      open
        ? sessionList({
            environmentId: props.projectRef.environmentId,
            input: { projectId: props.projectRef.projectId },
          })
        : null,
    [open, props.projectRef.environmentId, props.projectRef.projectId],
  );
  const query = useEnvironmentQuery(queryAtom);
  const attach = useAtomCommand(sessionAttach, { reportFailure: false });
  const sessions = useMemo(
    () => filterResumableSessions(query.data?.sessions ?? [], search),
    [query.data, search],
  );
  /** Keep the picker mounted during attachment so its result or failure remains visible. */
  const close = () => {
    if (!busy.current) setOpen(false);
  };
  /** Attach once per selection and notify navigation only while this picker is still mounted. */
  const select = async (session: ResumableAgentSession) => {
    if (busy.current) return;
    busy.current = true;
    setAttaching(true);
    setError(null);
    const result = await attach({
      environmentId: props.projectRef.environmentId,
      input: {
        projectId: props.projectRef.projectId,
        providerInstanceId: session.providerInstanceId,
        sessionId: session.sessionId,
      },
    });
    busy.current = false;
    if (!mounted.current) return;
    setAttaching(false);
    if (result._tag !== "Success") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not resume this session.");
      return;
    }
    setOpen(false);
    props.onResume(result.value.threadId);
  };
  return (
    <>
      <ComposerInlineControl
        icon="clock"
        label="Resume"
        accessibilityLabel="Resume a session"
        disabled={props.disabled}
        onPress={() => {
          setSearch("");
          setError(null);
          setOpen(true);
        }}
      />
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={close}
      >
        <View
          className="flex-1 bg-background px-4"
          style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between py-3">
            <Text className="text-xl font-t3-semibold text-foreground">Resume a session</Text>
            <Pressable
              accessibilityRole="button"
              disabled={attaching}
              onPress={close}
              className="p-3"
            >
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Search sessions"
            placeholder="Search or paste a resume command…"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-lg border border-border px-3 py-3 text-foreground"
          />
          <View className="flex-row items-center justify-between py-2">
            <Text className="text-xs text-foreground-muted">
              Codex and Claude · All project worktrees
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={query.isPending || attaching}
              onPress={query.refresh}
              className="p-3"
            >
              <Text className="text-foreground">Refresh</Text>
            </Pressable>
          </View>
          {error || query.error ? (
            <Text accessibilityRole="alert" className="py-3 text-foreground">
              {error ?? query.error}
            </Text>
          ) : null}
          {attaching ? <Text className="py-3 text-foreground-muted">Opening session…</Text> : null}
          <FlatList
            data={sessions}
            keyExtractor={(session) => `${session.providerInstanceId}:${session.sessionId}`}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text className="py-4 text-foreground-muted">
                {query.isPending
                  ? "Finding sessions…"
                  : query.error
                    ? ""
                    : "No external sessions found."}
              </Text>
            }
            ListFooterComponent={
              query.data?.truncated ? (
                <Text className="py-3 text-foreground-muted">
                  Showing the most recent sessions.
                </Text>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                disabled={attaching}
                onPress={() => void select(item)}
                className="flex-row items-center gap-3 border-b border-border py-4"
              >
                <ProviderIcon provider={item.provider} size={20} />
                <View className="min-w-0 flex-1 gap-1">
                  <Text numberOfLines={1} className="text-foreground">
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} className="text-xs text-foreground-muted">
                    {PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(item.provider)] ??
                      item.provider}{" "}
                    · {resumableSessionLocation(item)}
                  </Text>
                </View>
                <Text className="text-xs text-foreground-muted">
                  {relativeTime(item.updatedAt)}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </Modal>
    </>
  );
}
