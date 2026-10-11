import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectWriteFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";
import {
  canEditWorkspaceFile,
  fromEditorText,
  MAX_EDITABLE_FILE_BYTES,
  toEditorText,
  type EditorLineEnding,
} from "./fileEditing";
import { basename } from "./filePath";

type FileEditorRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  /** Absent for a project draft, which has no thread yet. */
  readonly threadId?: string;
  readonly cwd: string;
  readonly path: string[];
}>;

/**
 * The loaded file, plus the text a save would write. `loadedText` and
 * `revision` stay pinned to the read the user started from, so a background
 * refresh can neither hide their changes nor weaken the guarded write.
 */
interface FileEditorDraft {
  readonly text: string;
  readonly loadedText: string;
  readonly lineEnding: EditorLineEnding;
  readonly hasUtf8Bom: boolean;
  readonly revision: string;
}

const NOT_EDITABLE_DETAIL = `Only complete UTF-8 workspace text files under ${
  MAX_EDITABLE_FILE_BYTES / 1024
} KB can be edited on mobile.`;

const isProjectWriteFileError = Schema.is(ProjectWriteFileError);

/** The typed write failure behind an RPC error, whatever else the cause wraps. */
function writeFileFailure(result: {
  readonly cause: Cause.Cause<unknown>;
}): ProjectWriteFileError | null {
  const error = squashAtomCommandFailure(result);
  return isProjectWriteFileError(error) ? error : null;
}

function loadedDraft(input: {
  readonly relativePath: string;
  readonly file: ProjectReadFileResult | null;
}): FileEditorDraft | null {
  const { file } = input;
  if (file === null || file.revision === undefined || !canEditWorkspaceFile(input)) {
    return null;
  }
  const converted = toEditorText(file.contents);
  return {
    text: converted.text,
    loadedText: converted.text,
    lineEnding: converted.lineEnding,
    hasUtf8Bom: converted.hasUtf8Bom,
    revision: file.revision,
  };
}

export function FileEditorRouteScreen(props: FileEditorRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { codeSurface } = useAppearanceCodeSurface();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const cwd = props.route.params.cwd;
  const relativePath = props.route.params.path.join("/");
  const canWriteFiles = useAtomValue(projectEnvironment.writeFile.permissionAtom(environmentId));
  const fileQuery = useEnvironmentQuery(
    projectEnvironment.readFile({ environmentId, input: { cwd, relativePath } }),
  );
  const readResult = fileQuery.data as ProjectReadFileResult | null;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, {
    label: "workspace file save",
    reportFailure: false,
  });
  // The viewer already cached this read, so the editor opens with the text in hand.
  const loaded = useMemo(
    () => loadedDraft({ relativePath, file: readResult }),
    [readResult, relativePath],
  );
  // The editor owns a draft only once the user types; until then the read is the
  // draft, and "Discard and reload" simply hands it back to the read.
  const [edited, setEdited] = useState<FileEditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The input is uncontrolled so typing never round-trips the whole file through React;
  // bumping this remounts it with the reloaded text.
  const [reloadCount, setReloadCount] = useState(0);
  const draft = edited ?? loaded;
  const dirty = edited !== null && edited.text !== edited.loadedText;

  const save = async (options?: { readonly overwrite?: boolean }) => {
    if (edited === null || saving) return;
    setSaving(true);
    const result = await writeFile({
      environmentId,
      input: {
        cwd,
        relativePath,
        contents: fromEditorText(edited.text, edited.lineEnding, edited.hasUtf8Bom),
        ...(options?.overwrite === true ? {} : { expectedRevision: edited.revision }),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      // The viewer shares this query, so refreshing it shows the saved bytes.
      fileQuery.refresh();
      setSaved(true);
      return;
    }
    const failure = writeFileFailure(result);
    if (failure?.failure === "file_changed") {
      Alert.alert(
        "File changed",
        `${relativePath} changed on the server since you started editing.`,
        [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard and reload",
            style: "destructive",
            onPress: () => {
              setEdited(null);
              setReloadCount((count) => count + 1);
              fileQuery.refresh();
            },
          },
          { text: "Overwrite", onPress: () => void save({ overwrite: true }) },
        ],
      );
      return;
    }
    // Any other failure keeps the draft, so Save can be retried.
    Alert.alert("Couldn't save", String(squashAtomCommandFailure(result)));
  };

  const preventRemove = !saved && (dirty || saving);
  usePreventRemove(preventRemove, ({ data }) => {
    if (saving) {
      Alert.alert("Saving file", "Wait for the file to finish saving before leaving.");
      return;
    }
    Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  useEffect(() => {
    if (!saved) return;
    // Let the native removal guard turn off before popping the saved file.
    const frame = requestAnimationFrame(() => {
      if (navigation.isFocused()) navigation.goBack();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation, saved]);

  const close = useCallback(() => navigation.goBack(), [navigation]);
  const handleTextChange = useCallback(
    (text: string) => {
      setEdited((current) =>
        current !== null ? { ...current, text } : loaded === null ? null : { ...loaded, text },
      );
    },
    [loaded],
  );
  // Save is meaningful only for a changed draft on a connection that may write.
  const canSave = dirty && !saving && canWriteFiles;

  return (
    <View className="flex-1 bg-sheet">
      <ScreenHeader
        title={basename(relativePath)}
        subtitle={relativePath}
        sidebar={false}
        onBack={close}
        hideBottomBorder
        actions={[
          {
            accessibilityLabel: "Save",
            icon: "checkmark",
            disabled: !canSave,
            onPress: () => void save(),
          },
        ]}
        options={{
          headerBackVisible: false,
          gestureEnabled: !preventRemove,
          // The system back button begins its native pop before the removal
          // guard runs. Dispatch from a bar action so the guard runs first.
          // Android's in-flow header carries its own close control.
          ...(Platform.OS === "ios"
            ? {
                unstable_headerLeftItems: () => [
                  withNativeGlassHeaderItem({
                    type: "button",
                    label: "",
                    accessibilityLabel: "Cancel",
                    icon: { type: "sfSymbol", name: "xmark" },
                    onPress: close,
                  }),
                ],
              }
            : undefined),
        }}
      />
      {canWriteFiles ? null : (
        <FilePreviewNotice>This connection can&apos;t edit files.</FilePreviewNotice>
      )}
      {draft !== null ? (
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
          <TextInput
            key={`${draft.revision}:${reloadCount}`}
            multiline
            editable={!saving && !saved && canWriteFiles}
            scrollEnabled
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            smartInsertDelete={false}
            textAlignVertical="top"
            accessibilityLabel={`Edit ${basename(relativePath)}`}
            defaultValue={draft.text}
            onChangeText={handleTextChange}
            cursorColorClassName="accent-focus"
            selectionColorClassName="accent-focus/32"
            className="flex-1 bg-sheet px-3 pt-2 text-foreground"
            style={{
              paddingBottom: Math.max(insets.bottom, 8),
              fontFamily: REVIEW_MONO_FONT_FAMILY,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          />
        </KeyboardAvoidingView>
      ) : readResult === null && fileQuery.error === null ? (
        <FilePreviewLoading message="Loading file..." />
      ) : (
        <View className="flex-1 items-center justify-center bg-sheet px-6">
          <EmptyState
            title="Cannot edit this file"
            detail={fileQuery.error ?? NOT_EDITABLE_DETAIL}
          />
        </View>
      )}
    </View>
  );
}
