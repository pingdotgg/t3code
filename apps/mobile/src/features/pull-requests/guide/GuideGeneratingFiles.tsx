import { reviewFileChapters } from "@t3tools/shared/reviewFileClassification";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { GuideFiles, type GuideFileMetadata } from "./GuideFiles";

/** The provisional chapter groups remain useful while the agent writes the reading sequence. */
export function GuideGeneratingFiles({
  files,
  loading,
  error,
  canLoadMore,
  onLoadMore,
  isViewed,
  onToggleViewed,
  onOpenFile,
}: {
  readonly files: ReadonlyArray<GuideFileMetadata>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canLoadMore: boolean;
  readonly onLoadMore: () => void;
  readonly isViewed: (path: string) => boolean;
  readonly onToggleViewed?: ((path: string) => void) | undefined;
  readonly onOpenFile: (path: string) => void;
}) {
  return (
    <View className="gap-3">
      {reviewFileChapters(files, (file) => file.path).map((group) => (
        <View key={group.id} className="gap-1">
          <View className="min-h-9 flex-row items-center justify-between gap-2">
            <Text className="text-sm font-t3-semibold">{group.title}</Text>
            <Text className="text-xs text-foreground-muted">
              {group.files.filter((file) => isViewed(file.path)).length} of {group.files.length}{" "}
              files reviewed
            </Text>
          </View>
          <GuideFiles
            paths={group.files.map((file) => file.path)}
            files={group.files}
            isViewed={isViewed}
            onToggleViewed={onToggleViewed}
            onOpenFile={onOpenFile}
          />
        </View>
      ))}
      {!files.length ? (
        <Text className="py-3 text-sm text-foreground-muted">
          {error ?? (loading ? "Loading files…" : "No changed files.")}
        </Text>
      ) : error ? (
        <Text className="text-xs text-danger-foreground">{error}</Text>
      ) : null}
      {canLoadMore ? (
        <Pressable
          accessibilityRole="button"
          onPress={onLoadMore}
          className="min-h-11 items-center justify-center"
        >
          <Text className="text-sm font-t3-medium">Load more files</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
