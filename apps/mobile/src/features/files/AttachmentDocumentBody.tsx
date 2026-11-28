import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { useContentTopInset } from "../../components/ui/useBarInset";
import type { useAttachmentDocument } from "../../lib/attachmentDocument";
import { HtmlRenderWebView } from "../threads/HtmlRenderWebView";
import { AudioFilePreview } from "./AudioFilePreview";
import { DelimitedFilePreview } from "./DelimitedFilePreview";
import { EpubFilePreview } from "./EpubFilePreview";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";
import { SourceFileSurface } from "./SourceFileSurface";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";

export function nativeViewerKind(kind: ReturnType<typeof useAttachmentDocument>["kind"]) {
  if (kind === "image") return "image" as const;
  if (kind === "pdf") return "pdf" as const;
  if (kind === "video" || kind === "unsupported") return "document" as const;
  return null;
}

export function AttachmentDocumentBody(props: {
  readonly document: Pick<
    ReturnType<typeof useAttachmentDocument>,
    | "kind"
    | "activeMode"
    | "uri"
    | "content"
    | "table"
    | "error"
    | "needsText"
    | "retry"
    | "revision"
  >;
  readonly name: string;
  readonly environmentId: EnvironmentId | null;
  readonly htmlRender: boolean;
  readonly nativeViewer: "pending" | "open" | "unavailable" | null;
  readonly nativeError: string | null;
  readonly onOpenNative: () => void;
}) {
  const { document } = props;
  const gt = useGT();
  const headerInset = useContentTopInset();
  if (document.error) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title={gt("File unavailable")}
          detail={document.error}
          actionLabel={gt("Try again")}
          onAction={document.retry}
        />
      </View>
    );
  }
  if (props.nativeViewer !== null && props.nativeViewer !== "unavailable") {
    return <FilePreviewLoading message={gt("Opening in file viewer...")} />;
  }
  // ZIP text entries are read into memory and have no file URI.
  if (document.needsText ? !document.content : !document.uri) {
    return <FilePreviewLoading message={gt("Loading file...")} />;
  }
  if (document.needsText && document.content) {
    const { content, table } = document;
    return (
      <View className="flex-1 bg-sheet" style={{ paddingTop: content.truncated ? headerInset : 0 }}>
        {content.truncated ? (
          <FilePreviewNotice title={gt("Partial file")}>
            {gt("Preview limited to the first 1 MB. Save or share the file to read it in full.")}
          </FilePreviewNotice>
        ) : null}
        {table && document.activeMode === "table" ? (
          <DelimitedFilePreview table={table} />
        ) : document.activeMode === "markdown" && props.environmentId ? (
          <FileMarkdownPreview
            cwd=""
            relativePath=""
            environmentId={props.environmentId}
            threadId={null}
            markdown={content.text}
            captured
          />
        ) : (
          <SourceFileSurface contents={content.text} path={props.name} selectable />
        )}
      </View>
    );
  }
  if (!document.uri) return null;
  if (document.kind === "epub")
    return <EpubFilePreview key={document.uri} uri={document.uri} name={props.name} />;
  if (document.kind === "audio") {
    return <AudioFilePreview key={document.revision} uri={document.uri} onRetry={document.retry} />;
  }
  if (document.kind === "html") {
    return props.htmlRender ? (
      <HtmlRenderWebView key={document.uri} uri={document.uri} title={props.name} nested={false} />
    ) : (
      <WorkspaceFileWebPreview uri={document.uri} />
    );
  }
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title={gt("No preview for this file")}
        detail={
          props.nativeError ??
          gt("No app on this device can show this format. Save or share it to open it elsewhere.")
        }
        actionLabel={gt("Try again")}
        onAction={props.onOpenNative}
      />
    </View>
  );
}
