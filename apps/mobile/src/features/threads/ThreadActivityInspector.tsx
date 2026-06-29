import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, type ColorValue, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { buildThreadActivityInspector } from "../../lib/threadActivityInspector";
import { buildThreadFilesNavigation } from "../../lib/routes";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";

export function ThreadActivityInspector(props: {
  readonly activity: ThreadFeedActivity;
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly workspaceRoot?: string | null;
}) {
  const router = useRouter();
  const row = props.activity.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
  });
  const model = useMemo(
    () => buildThreadActivityInspector(props.activity, support),
    [props.activity, support],
  );
  const revertCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    label: "checkpoint rollback",
    reportFailure: true,
  });
  const [rollingBack, setRollingBack] = useState(false);

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-x-4 gap-y-2 rounded-lg border border-neutral-300/50 bg-black/[0.025] p-2.5 dark:border-white/[0.1] dark:bg-white/[0.025]">
        {model.fields.map((field) => (
          <View key={`${field.label}:${field.value}`} className="min-w-[42%] flex-1 gap-0.5">
            <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
              {field.label}
            </Text>
            <Text selectable className="text-2xs leading-4 text-foreground">
              {field.value}
            </Text>
          </View>
        ))}
      </View>

      {model.blocks.map((block) => (
        <View key={`${block.label}:${block.value}`} className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            {block.label}
          </Text>
          <ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: 240 }}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            <Text
              selectable
              className="text-2xs leading-[17px] text-foreground-muted"
              style={block.monospaced ? { fontFamily: "ui-monospace" } : undefined}
            >
              {block.value}
            </Text>
          </ScrollView>
        </View>
      ))}

      {model.fileLinks.length > 0 ? (
        <View className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            Files
          </Text>
          {model.fileLinks.map((link) => {
            const relativePath =
              resolveWorkspaceRelativeFilePath(props.workspaceRoot, link.path) ??
              (link.path.startsWith("/") ? null : link.path);
            return (
              <Pressable
                key={`${link.path}:${link.line ?? 0}:${link.label}`}
                accessibilityRole={relativePath ? "link" : undefined}
                disabled={relativePath === null}
                onPress={() => {
                  if (!relativePath) return;
                  void Haptics.selectionAsync();
                  router.push(
                    buildThreadFilesNavigation(
                      { environmentId: props.environmentId, threadId: row.sourceThreadId },
                      relativePath,
                      link.line,
                    ),
                  );
                }}
                className="min-h-9 flex-row items-center gap-2 rounded-md border border-neutral-300/50 px-2.5 py-1.5 dark:border-white/[0.1]"
              >
                <SymbolView
                  name="doc.text"
                  size={13}
                  tintColor={props.iconColor}
                  type="monochrome"
                />
                <Text className="min-w-0 flex-1 text-2xs leading-4 text-foreground">
                  {link.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {model.webLinks.length > 0 ? (
        <View className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            Sources
          </Text>
          {model.webLinks.map((link) => (
            <Pressable
              key={link.url}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(link.url)}
              className="min-h-9 flex-row items-center gap-2 rounded-md border border-neutral-300/50 px-2.5 py-1.5 dark:border-white/[0.1]"
            >
              <SymbolView
                name="arrow.up.right.square"
                size={13}
                tintColor={props.iconColor}
                type="monochrome"
              />
              <Text className="min-w-0 flex-1 text-2xs leading-4 text-foreground">
                {link.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {model.rollbackTarget ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Roll back to this checkpoint"
          disabled={rollingBack}
          onPress={() => {
            setRollingBack(true);
            void Haptics.selectionAsync();
            void revertCheckpoint({
              environmentId: props.environmentId,
              input: {
                threadId: model.rollbackTarget!.threadId,
                checkpointId: model.rollbackTarget!.checkpointId,
                scopeId: model.rollbackTarget!.scopeId,
              },
            }).finally(() => setRollingBack(false));
          }}
          className="min-h-10 flex-row items-center justify-center gap-2 rounded-lg border border-neutral-300/60 px-3 py-2 dark:border-white/[0.12]"
        >
          <SymbolView
            name={rollingBack ? "hourglass" : "arrow.counterclockwise"}
            size={14}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="font-t3-medium text-xs text-foreground">
            {rollingBack ? "Rolling back…" : "Roll back to checkpoint"}
          </Text>
        </Pressable>
      ) : null}

      <View className="gap-1 border-t border-neutral-300/50 pt-2 dark:border-white/[0.1]">
        <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
          Structured details
        </Text>
        <ScrollView
          nestedScrollEnabled
          directionalLockEnabled
          showsVerticalScrollIndicator
          style={{ maxHeight: 280 }}
          contentContainerStyle={{ paddingRight: 8 }}
        >
          <Text
            selectable
            className="text-2xs leading-[17px] text-foreground-muted"
            style={{ fontFamily: "ui-monospace" }}
          >
            {model.structuredDetails}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}
