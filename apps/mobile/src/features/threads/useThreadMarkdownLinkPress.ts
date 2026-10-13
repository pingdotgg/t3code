import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import type { VideoPreviewSource } from "../../components/VideoPreviewModal";
import { isPdfFile } from "../../lib/filePreview";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import {
  fileRoutePathSegments,
  isAbsolutePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";

export function useThreadMarkdownLinkPress(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly setExpandedFile: Dispatch<SetStateAction<FilePreviewSource | null>>;
  readonly setExpandedVideo: Dispatch<SetStateAction<VideoPreviewSource | null>>;
}) {
  const { environmentId, threadId, workspaceRoot, setExpandedFile, setExpandedVideo } = props;
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  return useCallback(
    (href: string, imageEmbed = false) => {
      // A thread link names a thread in this feed's environment.
      const linkedThreadId = parseThreadLinkHref(href);
      if (linkedThreadId) {
        navigation.navigate("Thread", {
          environmentId: String(environmentId),
          threadId: String(linkedThreadId),
        });
        return;
      }
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: environmentId,
        threadId: threadId,
        workspaceRoot: workspaceRoot,
        imageEmbed,
      });
      if (media) {
        void Haptics.selectionAsync();
        if (media.kind === "video") {
          setExpandedVideo((current) => current ?? media.source);
        } else {
          setExpandedFile((current) => current ?? media.source);
        }
        return;
      }

      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path);
        if (relativePath) {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadFile", {
            environmentId: String(environmentId),
            threadId: String(threadId),
            path: fileRoutePathSegments(relativePath),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
          return;
        }
      }

      // A host file outside the workspace, such as a report an agent wrote to
      // a temp directory, opens read-only in the file screen.
      if (presentation.kind === "file" && isAbsolutePath(presentation.path)) {
        void Haptics.selectionAsync();
        navigation.navigate("ThreadFile", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          path: fileRoutePathSegments(presentation.path),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
        return;
      }

      if (presentation.kind !== "file" && presentation.href) {
        const href = presentation.href;
        if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
          setExpandedFile((current) => current ?? { kind: "pdf", uri: href, name: "Document.pdf" });
          return;
        }
        void openPullRequest(presentation.href);
      }
    },
    [
      environmentId,
      threadId,
      workspaceRoot,
      setExpandedVideo,
      setExpandedFile,
      navigation,
      openPullRequest,
    ],
  );
}
