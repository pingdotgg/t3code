import * as Dialog from "../../components/ui/Dialog";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppBar, type AppBarMenu } from "../../components/ui/AppBar";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { useAttachmentDocument } from "../../lib/attachmentDocument";
import { nativeViewerErrorMessage } from "../../lib/attachmentDownload";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { removeComposerDraftAttachment, useComposerDraft } from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useRefreshAssetUrl } from "../../state/assets";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { isZipFile, ZipArchiveView } from "./ZipArchiveView";
import { AttachmentDocumentBody, nativeViewerKind } from "./AttachmentDocumentBody";

export type AttachmentFileRouteParams = {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly draftKey?: string;
  readonly htmlRender?: "1";
};

type AttachmentFileScreenProps = StaticScreenProps<AttachmentFileRouteParams>;

export function AttachmentFileScreen(props: AttachmentFileScreenProps) {
  const navigation = useNavigation();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const params = props.route.params;
  const environmentId = params.environmentId?.trim()
    ? EnvironmentId.make(params.environmentId)
    : null;
  const sizeBytes = Number.parseInt(params.sizeBytes, 10) || 0;
  const draftKey = params.draftKey ?? null;
  const draft = useComposerDraft(draftKey);
  const draftAttachment = draftKey
    ? draft.attachments.find((entry) => entry.id === params.attachmentId)
    : undefined;
  const localAttachment =
    draftAttachment && isFileBackedComposerAttachment(draftAttachment) ? draftAttachment : null;
  const document = useAttachmentDocument({
    name: params.name,
    mimeType: params.mimeType,
    sizeBytes,
    attachmentId: params.attachmentId,
    environmentId,
    attachment: localAttachment,
  });
  const [nativeOpen, setNativeOpen] = useState(false);
  const nativeKind = nativeViewerKind(document.kind);
  const [nativeViewer, setNativeViewer] = useState<"pending" | "open" | "unavailable" | null>(
    nativeKind ? "pending" : null,
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const pendingNativeError = useRef<string | null>(null);
  const handleBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };
  const { uri, resource } = document;
  // A file only the native viewer can show opens it as soon as the file resolves.
  if (nativeViewer === "pending" && uri) {
    setNativeViewer("open");
    setNativeOpen(true);
  }
  // Mint a fresh URL: cached URLs may expire in the background before Quick Look or ACTION_VIEW opens.
  const nativeSource = ((): FilePreviewSource | null => {
    const kind = nativeKind ?? "document";
    const base = { kind, name: params.name, mimeType: params.mimeType };
    if (localAttachment) return { ...base, attachment: localAttachment };
    if (environmentId) return { ...base, environmentId, resource };
    return uri ? { ...base, uri } : null;
  })();
  const handleNativeOpenError = (error: unknown) => {
    pendingNativeError.current = nativeViewerErrorMessage(error);
  };
  const handleNativeClose = () => {
    setNativeOpen(false);
    const message = pendingNativeError.current;
    pendingNativeError.current = null;
    if (nativeViewer === null) {
      if (message) Dialog.alert("Could not open document", message);
      return;
    }
    if (message) {
      setNativeError(message);
      setNativeViewer("unavailable");
      return;
    }
    handleBack();
  };
  const removeFromDraft = () => {
    if (!draftKey) return;
    removeComposerDraftAttachment(draftKey, params.attachmentId);
    handleBack();
  };

  const { content, renderedMode, activeMode, setRendered, share, sharing } = document;
  const menuActions = [
    renderedMode
      ? ({
          id: "preview",
          title: renderedMode === "table" ? "Table" : "Preview",
          icon: renderedMode === "table" ? "tablecells" : "eye",
          inline: true,
          onPress: () => setRendered(true),
        } as const)
      : null,
    renderedMode
      ? ({
          id: "source",
          title: "Source",
          icon: "doc.text",
          inline: true,
          onPress: () => setRendered(false),
        } as const)
      : null,
    content && activeMode === "source"
      ? ({
          id: "word-wrap",
          title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
          icon: "text.alignleft",
          inline: false,
          onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
        } as const)
      : null,
    content
      ? ({
          id: "copy",
          title: content.truncated ? "Copy preview" : "Copy contents",
          icon: "doc.on.doc",
          inline: false,
          onPress: () => copyTextWithHaptic(content.text),
        } as const)
      : null,
    uri
      ? ({
          id: "share",
          title: sharing ? "Opening share sheet…" : "Save or share",
          icon: "square.and.arrow.up",
          inline: false,
          onPress: () => void share(),
        } as const)
      : null,
    uri
      ? ({
          id: "open-viewer",
          title: "Open in file viewer",
          icon: "arrow.up.left.and.arrow.down.right",
          inline: false,
          onPress: () => {
            setNativeViewer((current) => (current === null ? null : "open"));
            setNativeOpen(true);
          },
        } as const)
      : null,
    draftKey
      ? ({
          id: "remove",
          title: "Remove from draft",
          icon: "trash",
          inline: false,
          destructive: true,
          onPress: removeFromDraft,
        } as const)
      : null,
  ].filter((action) => action !== null);
  const selectedAction = activeMode === "source" ? "source" : "preview";
  const fileMenu: AppBarMenu = {
    title: "File actions",
    icon: "ellipsis",
    items: [
      ...(renderedMode
        ? [
            {
              id: "modes",
              inline: true,
              items: menuActions
                .filter(({ inline }) => inline)
                .map((action) => ({
                  id: action.id,
                  title: action.title,
                  icon: action.icon,
                  selected: action.id === selectedAction,
                  onPress: action.onPress,
                })),
            },
          ]
        : []),
      ...menuActions
        .filter(({ inline }) => !inline)
        .map((action) => ({
          id: action.id,
          title: action.title,
          icon: action.icon,
          destructive: "destructive" in action,
          onPress: action.onPress,
        })),
    ],
  };
  const subtitle = `${draftKey ? "Draft attachment" : "Attachment"}${sizeBytes > 0 ? ` · ${formatAttachmentSize(sizeBytes)}` : ""}`;
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const capabilities = useEnvironmentServerConfig(environmentId)?.environment.capabilities;

  if (document.kind === "archive" && isZipFile(params) && !document.error) {
    const threadDraftKey =
      environmentId && params.threadId
        ? scopedThreadKey(environmentId, ThreadId.make(params.threadId))
        : null;
    return (
      <ZipArchiveView
        name={params.name}
        subtitle={subtitle}
        sizeBytes={sizeBytes}
        uri={uri}
        isLocal={localAttachment !== null}
        refresh={refresh}
        environmentId={environmentId}
        // Entries go to the thread's chat composer, also from a question-answer draft.
        draftKey={threadDraftKey ?? draftKey}
        maxAttachmentBytes={
          capabilities?.attachmentUploads && capabilities.fileAttachments
            ? clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)
            : undefined
        }
        onSave={() => void share()}
        onRemove={draftKey ? removeFromDraft : null}
      />
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <AppBar title={params.name} subtitle={subtitle} onBack={handleBack} menus={[fileMenu]} />
      <AttachmentDocumentBody
        document={document}
        name={params.name}
        environmentId={environmentId}
        htmlRender={params.htmlRender === "1"}
        nativeViewer={nativeViewer}
        nativeError={nativeError}
        onOpenNative={() => {
          setNativeViewer((current) => (current === null ? null : "open"));
          setNativeOpen(true);
        }}
      />
      {nativeOpen && nativeSource ? (
        <FilePreviewModal
          source={nativeSource}
          onRequestClose={handleNativeClose}
          onOpenError={handleNativeOpenError}
        />
      ) : null}
    </View>
  );
}
