import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { ReviewSectionItem } from "./reviewModel";
import { useReviewHeaderPresentation } from "./useReviewHeaderPresentation";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { type Ref, type ReactElement, useImperativeHandle, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotionEnabled } from "../../lib/appState";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useReviewCacheForThread } from "./reviewState";
import {
  isNativeReviewDiffDrawEvent,
  type NativeReviewDiffViewHandle,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useReviewDiffData } from "./useReviewDiffData";
import { useReviewDiffPrewarming } from "./useReviewDiffPrewarming";
import { useReviewFileVisibility } from "./reviewFileVisibility";
import { useReviewSections } from "./useReviewSections";
import { useNativeReviewDiffBridge } from "./useNativeReviewDiffBridge";
import { useReviewCommentSelectionController } from "./useReviewCommentSelectionController";
import { resolveReviewAvailability } from "./reviewAvailability";
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";
import { buildReviewSectionMenu } from "./review-section-menu";
import { reportShowcaseSceneRendered } from "../showcase/showcaseRenderSignal";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { ReviewFileNavigatorRow } from "./ReviewSheet.tsx";
import type { ReviewFileNavigatorProps, ReviewNavigatorFile } from "./ReviewSheet.tsx";

export function ReviewFileNavigator({
  files,
  headerInset,
  sectionId,
  onSelectFile,
  ref,
}: ReviewFileNavigatorProps) {
  const theme = useUniwindTheme();
  const sheetColor = theme["--color-sheet"];
  const foregroundColor = theme["--color-foreground"];
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
  const [fileSelection, setFileSelection] = useState<{
    readonly sectionId: string | null;
    readonly fileId: string | null;
  }>({ sectionId: null, fileId: null });
  const availableFileIds = files.map((file) => file.id);
  const selectedFileId = resolveSelectedReviewFileId({
    selection: fileSelection,
    sectionId,
    availableFileIds,
  });

  useImperativeHandle(
    ref,
    () => ({
      setVisibleFile: (fileId) => {
        if (fileId !== null && !availableFileIds.includes(fileId)) {
          return;
        }
        setFileSelection((current) => {
          if (current.sectionId === sectionId && current.fileId === fileId) {
            return current;
          }
          return { sectionId, fileId };
        });
      },
    }),
    [availableFileIds, sectionId],
  );

  const handleSelectFile = (fileId: string | null) => {
    setFileSelection({ sectionId, fileId });
    onSelectFile(fileId);
  };

  const renderFile = ({ item }: { readonly item: ReviewNavigatorFile }) => (
    <ReviewFileNavigatorRow
      file={item}
      selected={selectedFileId === item.id}
      onSelectFile={handleSelectFile}
    />
  );

  const fileList = (
    <FlatList
      data={files}
      extraData={selectedFileId}
      keyExtractor={(file) => file.id}
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}
      renderItem={renderFile}
    />
  );

  if (Platform.OS === "ios") {
    return (
      <View className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="review-file-navigator-native"
            scrollEdgeEffects={headerScrollEdgeEffects}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            <NativeInspectorContent>{fileList}</NativeInspectorContent>
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
              title="Changed files"
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-l border-border bg-sheet"
      }
    >
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Changed files"
          subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
          hideBottomBorder
        />
      ) : (
        <View className="border-b border-border" style={{ paddingTop: headerInset }}>
          <View className="px-4 py-3">
            <Text className="text-sm font-t3-bold text-foreground">Changed files</Text>
            <Text className="text-xs text-foreground-muted">
              {files.length} {files.length === 1 ? "file" : "files"}
            </Text>
          </View>
        </View>
      )}
      <ScreenContent insetHorizontal>{fileList}</ScreenContent>
    </View>
  );
}

