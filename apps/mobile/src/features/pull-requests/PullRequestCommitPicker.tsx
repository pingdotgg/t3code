import type { PullRequestCommit } from "@t3tools/contracts";
import {
  reviewCommitScope,
  reviewCommitSelection,
  toggleReviewCommit,
} from "@t3tools/client-runtime/review-workspace";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { relativeTime } from "../../lib/time";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";

/** A compact range picker keeps native menus from wrapping every commit into a tall card. */
export function PullRequestCommitPicker({
  open,
  onClose,
  commits,
  scope,
  lastReviewed,
  canSelectRange,
  onChange,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Oldest first, matching the shared contiguous-range selection helpers. */
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly scope: string | null;
  readonly lastReviewed: string | null;
  readonly canSelectRange: boolean;
  readonly onChange: (scope: string | null) => void;
}) {
  const { height } = useWindowDimensions();
  const [shown, setShown] = useState(10);
  const oids = commits.map((commit) => commit.oid);
  const selected = reviewCommitSelection(oids, scope);
  const first = selected[0];
  const last = selected.at(-1);
  const reviewedIndex = lastReviewed === null ? -1 : oids.indexOf(lastReviewed);
  const sinceDisabled = reviewedIndex < 0 || reviewedIndex === commits.length - 1;
  // eslint-disable-next-line unicorn/no-array-reverse -- Hermes does not implement toReversed; reverse a fresh copy.
  const recentCommits = [...commits].reverse().slice(0, shown);
  const chooseQuick = (next: string | null) => {
    onChange(next);
    onClose();
  };
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 items-center justify-center px-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close commit picker"
          className="absolute inset-0 bg-backdrop"
          onPress={onClose}
        />
        <View
          className="w-full max-w-[440px] overflow-hidden rounded-[24px] border border-border-subtle bg-card"
          style={{ maxHeight: Math.max(200, height - 64) }}
        >
          <View className="flex-row items-center gap-2 px-3 py-2">
            <Text className="min-w-0 flex-1 text-sm font-t3-semibold">Commit range</Text>
            <ControlPill icon="xmark" accessibilityLabel="Close commit picker" onPress={onClose} />
          </View>
          <View className="gap-1 border-b border-border-subtle px-4 pb-3">
            <Text className="text-xs text-foreground-muted">
              {scope === null
                ? "All"
                : `${selected.length} ${selected.length === 1 ? "commit" : "commits"} selected`}
            </Text>
            {scope !== null && first ? (
              <Text className="text-xs" style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}>
                {first.slice(0, 7)}
                {last && first !== last ? ` → ${last.slice(0, 7)}` : ""}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: scope === null }}
            className="min-h-11 flex-row items-center gap-2 px-4 active:bg-secondary"
            onPress={() => chooseQuick(null)}
          >
            <View className="w-4">
              {scope === null ? (
                <SymbolView name="checkmark" size={13} tintColorClassName="accent-icon" />
              ) : null}
            </View>
            <Text className="text-sm">All</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: sinceDisabled }}
            disabled={sinceDisabled}
            className="min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-4 active:bg-secondary disabled:opacity-40"
            onPress={() => chooseQuick(reviewCommitScope(oids.slice(reviewedIndex + 1)))}
          >
            <View className="w-4" />
            <Text className="text-sm">Since last reviewed</Text>
          </Pressable>
          <ScrollView
            style={{ flexShrink: 1, maxHeight: Math.max(84, Math.min(360, height * 0.55)) }}
            keyboardShouldPersistTaps="handled"
          >
            {recentCommits.map((entry) => {
              const checked = selected.includes(entry.oid);
              const authors = entry.authors
                ?.map((author) => author.name ?? author.login)
                .join(", ");
              return (
                <Pressable
                  key={entry.oid}
                  accessibilityRole={canSelectRange ? "checkbox" : "button"}
                  accessibilityLabel={`${entry.messageHeadline}, ${entry.oid.slice(0, 7)}${authors ? `, ${authors}` : ""}`}
                  accessibilityState={canSelectRange ? { checked } : { selected: checked }}
                  className="min-h-[42px] flex-row items-center gap-2 px-4 py-1 active:bg-secondary"
                  onPress={() => {
                    onChange(
                      canSelectRange
                        ? reviewCommitScope(
                            toggleReviewCommit(oids, scope === null ? [] : selected, entry.oid),
                          )
                        : entry.oid,
                    );
                    if (!canSelectRange) onClose();
                  }}
                >
                  <View className="size-4 items-center justify-center rounded border border-border">
                    {checked ? (
                      <SymbolView name="checkmark" size={11} tintColorClassName="accent-icon" />
                    ) : null}
                  </View>
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text numberOfLines={1} ellipsizeMode="tail" className="text-sm">
                      {entry.messageHeadline || "Untitled commit"}
                    </Text>
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      className="text-2xs text-foreground-muted"
                    >
                      {authors ? `${authors} · ` : ""}
                      {relativeTime(entry.committedDate)}
                    </Text>
                  </View>
                  <Text
                    className="shrink-0 text-2xs text-foreground-muted"
                    style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
                  >
                    {entry.oid.slice(0, 7)}
                  </Text>
                </Pressable>
              );
            })}
            {commits.length > shown ? (
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center px-4 active:bg-secondary"
                onPress={() => setShown((current) => current + 10)}
              >
                <Text className="text-xs text-foreground-muted">
                  Show more ({commits.length - shown} left)
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
