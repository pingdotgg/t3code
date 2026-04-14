import {
  type GitReviewDiffSection,
  type OrchestrationCheckpointSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { getEnvironmentClient } from "../../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../../state/use-thread-detail";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { appendReviewCommentToDraft } from "../use-thread-composer-state";
import { parseUnifiedDiff, type ParsedDiffFile, type ParsedDiffLine } from "./diffParser";

type ReviewSource = "turn" | "git";

interface ReviewDiffSection {
  readonly id: string;
  readonly source: ReviewSource;
  readonly title: string;
  readonly subtitle: string | null;
  readonly diff: string;
}

interface ActiveCommentTarget {
  readonly section: ReviewDiffSection;
  readonly file: ParsedDiffFile;
  readonly line: ParsedDiffLine;
}

function checkpointTitle(checkpoint: OrchestrationCheckpointSummary): string {
  return `Turn ${checkpoint.checkpointTurnCount}`;
}

function checkpointSubtitle(checkpoint: OrchestrationCheckpointSummary): string {
  const fileCount = checkpoint.files.length;
  if (checkpoint.status !== "ready") {
    return `Diff ${checkpoint.status}`;
  }
  return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
}

function formatCommentContext(target: ActiveCommentTarget, comment: string): string {
  const filePath = target.file.newPath ?? target.file.oldPath ?? "unknown file";
  const lineLabel =
    target.line.newLine !== null
      ? `new line ${target.line.newLine}`
      : target.line.oldLine !== null
        ? `old line ${target.line.oldLine}`
        : "file";

  return [
    "Review comment:",
    `Source: ${target.section.title}`,
    `File: ${filePath}`,
    `Line: ${lineLabel}`,
    `Comment: ${comment.trim()}`,
  ].join("\n");
}

function lineTone(type: ParsedDiffLine["type"]): string {
  if (type === "add") return "bg-emerald-500/10";
  if (type === "delete") return "bg-red-500/10";
  if (type === "hunk") return "bg-blue-500/10";
  if (type === "meta") return "bg-subtle";
  return "bg-card";
}

function lineMarker(type: ParsedDiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "delete") return "-";
  return " ";
}

function DiffLineRow(props: { readonly line: ParsedDiffLine; readonly onComment: () => void }) {
  const canComment = props.line.type !== "meta" && props.line.type !== "hunk";
  const lineNumber = props.line.newLine ?? props.line.oldLine;

  return (
    <Pressable
      disabled={!canComment}
      className={`flex-row gap-2 border-b border-border/60 px-3 py-2 ${lineTone(props.line.type)}`}
      onPress={props.onComment}
    >
      <Text className="w-10 text-right text-[11px] font-t3-medium text-foreground-muted">
        {lineNumber ?? ""}
      </Text>
      <Text className="w-3 text-[12px] font-t3-bold text-foreground-muted">
        {lineMarker(props.line.type)}
      </Text>
      <Text
        selectable
        className="flex-1 font-mono text-[12px] leading-[17px] text-foreground"
        numberOfLines={4}
      >
        {props.line.content.length > 0 ? props.line.content : " "}
      </Text>
      {canComment ? (
        <SymbolView name="text.bubble" size={13} tintColor="#8a8a8a" type="monochrome" />
      ) : null}
    </Pressable>
  );
}

function DiffFileView(props: {
  readonly section: ReviewDiffSection;
  readonly file: ParsedDiffFile;
  readonly onSelectLine: (target: ActiveCommentTarget) => void;
}) {
  const title = props.file.newPath ?? props.file.oldPath ?? "Patch";

  return (
    <View className="overflow-hidden rounded-[18px] border border-border bg-card">
      <View className="border-b border-border bg-subtle px-3 py-2">
        <Text className="text-[13px] font-t3-bold text-foreground">{title}</Text>
      </View>
      {props.file.lines.map((line) => (
        <DiffLineRow
          key={line.id}
          line={line}
          onComment={() => props.onSelectLine({ section: props.section, file: props.file, line })}
        />
      ))}
    </View>
  );
}

function DiffSectionView(props: {
  readonly section: ReviewDiffSection;
  readonly onSelectLine: (target: ActiveCommentTarget) => void;
}) {
  const files = useMemo(() => parseUnifiedDiff(props.section.diff), [props.section.diff]);

  if (props.section.diff.trim().length === 0) {
    return (
      <View className="rounded-[18px] border border-border bg-card px-4 py-5">
        <Text className="text-[14px] font-t3-bold text-foreground">No changes</Text>
        <Text className="text-[12px] leading-[18px] text-foreground-muted">
          {props.section.subtitle ?? "This diff is empty."}
        </Text>
      </View>
    );
  }

  if (files.length === 0) {
    return (
      <View className="rounded-[18px] border border-border bg-card px-4 py-4">
        <Text selectable className="font-mono text-[12px] leading-[17px] text-foreground">
          {props.section.diff}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      {files.map((file) => (
        <DiffFileView
          key={file.id}
          section={props.section}
          file={file}
          onSelectLine={props.onSelectLine}
        />
      ))}
    </View>
  );
}

export function ReviewSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const { selectedThreadProject } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const [gitSections, setGitSections] = useState<ReadonlyArray<GitReviewDiffSection>>([]);
  const [turnSections, setTurnSections] = useState<ReadonlyArray<ReviewDiffSection>>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [loadingTurnDiff, setLoadingTurnDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCommentTarget, setActiveCommentTarget] = useState<ActiveCommentTarget | null>(null);
  const [commentText, setCommentText] = useState("");

  const cwd = selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null;
  const readyCheckpoints = useMemo(
    () =>
      [...(selectedThread?.checkpoints ?? [])]
        .filter((checkpoint) => checkpoint.status === "ready")
        .sort((a, b) => b.checkpointTurnCount - a.checkpointTurnCount),
    [selectedThread?.checkpoints],
  );

  const reviewSections = useMemo<ReadonlyArray<ReviewDiffSection>>(
    () => [
      ...turnSections,
      ...gitSections.map((section) => ({
        id: `git:${section.kind}`,
        source: "git" as const,
        title: section.title,
        subtitle:
          section.kind === "dirty"
            ? "Tracked, staged, and untracked worktree changes"
            : section.baseRef
              ? `${section.baseRef} ... ${section.headRef ?? "HEAD"}`
              : "Base branch unavailable",
        diff: section.diff,
      })),
    ],
    [gitSections, turnSections],
  );

  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? reviewSections[0] ?? null;

  useEffect(() => {
    if (!selectedSectionId && reviewSections.length > 0) {
      setSelectedSectionId(reviewSections[0]?.id ?? null);
    }
  }, [reviewSections, selectedSectionId]);

  useEffect(() => {
    if (!environmentId || !cwd) {
      return;
    }

    const client = getEnvironmentClient(environmentId);
    if (!client) {
      setError("Remote connection is not ready.");
      return;
    }

    let cancelled = false;
    setLoadingGitDiffs(true);
    client.git
      .getReviewDiffs({ cwd })
      .then((result) => {
        if (!cancelled) {
          setGitSections(result.sections);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load review diffs.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingGitDiffs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId]);

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary) => {
      if (!environmentId || !threadId) {
        return;
      }
      const client = getEnvironmentClient(environmentId);
      if (!client) {
        setError("Remote connection is not ready.");
        return;
      }

      setLoadingTurnDiff(true);
      setError(null);
      try {
        const result = await client.orchestration.getTurnDiff({
          threadId: ThreadId.make(threadId),
          fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
          toTurnCount: checkpoint.checkpointTurnCount,
        });
        const section: ReviewDiffSection = {
          id: `turn:${checkpoint.checkpointTurnCount}`,
          source: "turn",
          title: checkpointTitle(checkpoint),
          subtitle: checkpointSubtitle(checkpoint),
          diff: result.diff,
        };
        setTurnSections((current) => [
          section,
          ...current.filter((candidate) => candidate.id !== section.id),
        ]);
        setSelectedSectionId(section.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load turn diff.");
      } finally {
        setLoadingTurnDiff(false);
      }
    },
    [environmentId, threadId],
  );

  useEffect(() => {
    const latest = readyCheckpoints[0];
    if (
      !latest ||
      turnSections.some((section) => section.id === `turn:${latest.checkpointTurnCount}`)
    ) {
      return;
    }
    void loadTurnDiff(latest);
  }, [loadTurnDiff, readyCheckpoints, turnSections]);

  const submitComment = useCallback(() => {
    if (!activeCommentTarget || commentText.trim().length === 0 || !environmentId || !threadId) {
      return;
    }
    appendReviewCommentToDraft({
      environmentId,
      threadId,
      text: formatCommentContext(activeCommentTarget, commentText),
    });
    setActiveCommentTarget(null);
    setCommentText("");
    router.back();
  }, [activeCommentTarget, commentText, environmentId, router, threadId]);

  return (
    <View className="flex-1 bg-sheet">
      <View className="flex-row items-center justify-between px-5 pb-3 pt-5">
        <View className="flex-1">
          <Text
            className="text-[12px] font-t3-bold uppercase text-foreground-muted"
            style={{ letterSpacing: 1 }}
          >
            Review
          </Text>
          <Text className="text-[28px] font-t3-bold text-foreground">Changes</Text>
        </View>
        <Pressable
          className="h-9 w-9 items-center justify-center rounded-full bg-subtle"
          disabled={!cwd || loadingGitDiffs}
          onPress={() => {
            if (cwd && environmentId) {
              setGitSections([]);
              const client = getEnvironmentClient(environmentId);
              if (client) {
                setLoadingGitDiffs(true);
                void client.git
                  .getReviewDiffs({ cwd })
                  .then((result) => setGitSections(result.sections))
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Failed to refresh diffs."),
                  )
                  .finally(() => setLoadingGitDiffs(false));
              }
            }
          }}
        >
          {loadingGitDiffs ? (
            <ActivityIndicator size="small" />
          ) : (
            <SymbolView name="arrow.clockwise" size={16} tintColor={iconColor} type="monochrome" />
          )}
        </Pressable>
      </View>

      {error ? (
        <View className="mx-5 mb-3 rounded-[18px] border border-border bg-card px-4 py-3">
          <Text className="text-[13px] font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">{error}</Text>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="max-h-[54px]"
        contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingBottom: 10 }}
      >
        {readyCheckpoints.map((checkpoint) => (
          <Pressable
            key={checkpoint.turnId}
            className="rounded-full border border-border bg-card px-4 py-2"
            disabled={loadingTurnDiff}
            onPress={() => void loadTurnDiff(checkpoint)}
          >
            <Text className="text-[12px] font-t3-bold text-foreground">
              {checkpointTitle(checkpoint)}
            </Text>
          </Pressable>
        ))}
        {reviewSections.map((section) => (
          <Pressable
            key={section.id}
            className={`rounded-full border px-4 py-2 ${
              selectedSection?.id === section.id
                ? "border-foreground bg-foreground"
                : "border-border bg-card"
            }`}
            onPress={() => setSelectedSectionId(section.id)}
          >
            <Text
              className={`text-[12px] font-t3-bold ${
                selectedSection?.id === section.id ? "text-background" : "text-foreground"
              }`}
            >
              {section.title}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: 14,
        }}
      >
        {selectedSection ? (
          <>
            <View>
              <Text className="text-[18px] font-t3-bold text-foreground">
                {selectedSection.title}
              </Text>
              {selectedSection.subtitle ? (
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {selectedSection.subtitle}
                </Text>
              ) : null}
            </View>
            <DiffSectionView section={selectedSection} onSelectLine={setActiveCommentTarget} />
          </>
        ) : (
          <View className="rounded-[18px] border border-border bg-card px-4 py-5">
            <Text className="text-[14px] font-t3-bold text-foreground">No review diffs</Text>
            <Text className="text-[12px] leading-[18px] text-foreground-muted">
              This thread has no ready turn diffs and the worktree diff is empty.
            </Text>
          </View>
        )}
      </ScrollView>

      {activeCommentTarget ? (
        <View
          className="border-t border-border bg-sheet px-5 py-4"
          style={{ paddingBottom: Math.max(insets.bottom, 14) }}
        >
          <Text className="text-[13px] font-t3-bold text-foreground">
            Comment on {activeCommentTarget.file.newPath ?? activeCommentTarget.file.oldPath}
          </Text>
          <TextInput
            multiline
            className="mt-2 min-h-[72px] rounded-[18px] border border-border bg-card px-3 py-3 text-[14px] text-foreground"
            placeholder="What should the agent know?"
            placeholderTextColor="#8a8a8a"
            value={commentText}
            onChangeText={setCommentText}
          />
          <View className="mt-3 flex-row gap-3">
            <Pressable
              className="min-h-[44px] flex-1 items-center justify-center rounded-[18px] border border-border bg-card"
              onPress={() => {
                setActiveCommentTarget(null);
                setCommentText("");
              }}
            >
              <Text className="text-[12px] font-t3-bold uppercase text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              className="min-h-[44px] flex-1 items-center justify-center rounded-[18px] bg-foreground"
              onPress={submitComment}
            >
              <Text className="text-[12px] font-t3-bold uppercase text-background">
                Add to next turn
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
