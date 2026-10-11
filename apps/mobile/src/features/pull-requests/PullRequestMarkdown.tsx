import { videoMimeType } from "@t3tools/shared/video";
import { createContext, useContext, useCallback, useMemo, useState } from "react";
import { githubMarkdownLinks } from "@t3tools/shared/githubMarkdownLinks";
import { Text as NativeText } from "react-native";
import {
  Markdown,
  type CustomRenderers,
  type CustomRendererProps,
} from "react-native-nitro-markdown";
import { markdownHtmlContent } from "@t3tools/mobile-markdown-text/markdown";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/FilePreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";

export const PullRequestMarkdownRepository = createContext<string | null>(null);

function renderLink(
  { href, children }: CustomRendererProps,
  styles: ReturnType<typeof useMarkdownPreviewStyles>,
  open: (href: string) => void,
) {
  return (
    <NativeText
      className="font-t3-medium"
      onPress={() => href && open(href)}
      style={{ color: styles.theme.colors?.link }}
    >
      {children}
    </NativeText>
  );
}

function renderHtmlBlock(
  { node }: CustomRendererProps,
  styles: ReturnType<typeof useMarkdownPreviewStyles>,
  renderers: CustomRenderers,
) {
  const content = markdownHtmlContent(node.content ?? "").trim();
  return content ? (
    <Markdown
      options={{ gfm: true, html: false }}
      renderers={renderers}
      styles={styles.styles}
      theme={styles.theme}
    >
      {content}
    </Markdown>
  ) : null;
}

export function PullRequestMarkdown(props: {
  readonly markdown: string;
  readonly imageGroupMarkdown?: string;
}) {
  const repositoryUrl = useContext(PullRequestMarkdownRepository);
  const markdown = useMemo(
    () => githubMarkdownLinks(props.markdown, repositoryUrl),
    [props.markdown, repositoryUrl],
  );
  const openPullRequest = useOpenPullRequest();
  const openLink = useCallback(
    (href: string) => {
      void openPullRequest(href);
    },
    [openPullRequest],
  );
  const gallery = useMemo<FilePreviewItem[]>(
    () =>
      markdownImageSources(props.imageGroupMarkdown ?? props.markdown)
        .filter(
          (uri) =>
            /^https?:\/\//i.test(uri) &&
            videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
        )
        .map((uri) => ({ kind: "image", uri })),
    [props.markdown, props.imageGroupMarkdown],
  );
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => (
      <ThreadMarkdownImageView
        uri={/^https?:\/\//i.test(image.href) ? image.href : null}
        sourceKey={image.href}
        unavailable={!/^https?:\/\//i.test(image.href)}
        alt={image.alt}
        onPressPreview={setPreview}
      />
    ),
    [],
  );
  const styles = useMarkdownPreviewStyles(renderImage);
  const renderers = useMemo<CustomRenderers>(() => {
    const renderers: CustomRenderers = {
      ...styles.renderers,
      link: (props) => renderLink(props, styles, openLink),
    };
    renderers.html_block = (props) => renderHtmlBlock(props, styles, renderers);
    return renderers;
  }, [styles, openLink]);
  return (
    <FilePreviewGallery value={gallery}>
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={markdown}
          textStyle={styles.nativeTextStyle}
          onLinkPress={openLink}
          renderImage={renderImage}
        />
      ) : (
        <Markdown
          options={{ gfm: true, html: true }}
          renderers={renderers}
          styles={styles.styles}
          theme={styles.theme}
        >
          {markdown}
        </Markdown>
      )}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
}
