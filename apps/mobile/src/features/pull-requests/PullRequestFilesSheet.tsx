import { Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ReviewFileTree, type ReviewFileTreeItem } from "../review/ReviewFileTree";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Shows exactly the file set in the reader, including its chapter and filters. */
export function PullRequestFilesSheet({
  open,
  onClose,
  files,
  title,
  onSelectFile,
  onSetViewed,
  onLoadMore,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly files: ReadonlyArray<ReviewFileTreeItem>;
  readonly title: string;
  readonly onSelectFile: (path: string) => void;
  readonly onSetViewed?: (paths: ReadonlyArray<string>, viewed: boolean) => void;
  readonly onLoadMore?: () => void;
}) {
  const { themeVariables: colors } = useAppearancePreferences();
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors["--color-screen"] }}>
        <View className="flex-row items-center gap-2 border-b border-border-subtle px-4 py-1">
          <SymbolView name="folder" size={18} tintColorClassName="accent-icon-muted" />
          <Text className="min-w-0 flex-1 text-base font-t3-semibold">{title}</Text>
          <Text className="text-xs text-foreground-muted">{files.length}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close files"
            className="min-h-11 min-w-11 items-center justify-center"
            onPress={onClose}
          >
            <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </View>
        {files.length ? (
          <ReviewFileTree
            showViewedCheckbox
            files={files}
            onSelectFile={(path) => {
              onSelectFile(path);
              onClose();
            }}
            onSetViewed={onSetViewed}
          />
        ) : (
          <Text className="px-4 py-6 text-sm text-foreground-muted">No files match this view.</Text>
        )}
        {onLoadMore ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-11 items-center justify-center border-t border-border-subtle"
            onPress={onLoadMore}
          >
            <Text className="text-xs text-foreground-muted">Load more files</Text>
          </Pressable>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}
