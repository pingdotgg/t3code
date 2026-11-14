
export * from "./chat/chatMarkdownComponentHelpers";
import { normalizeMarkdownLinkDestination, inlineCodeFilePathCandidate } from "@t3tools/shared/markdownLinks";
import { CHAT_MARKDOWN_COMPONENTS_LEADING } from "./chat/chatMarkdownComponentsLeading";

import { SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { InlineAudioPreview } from "./files/InlineAudioPreview";
import { HostImageUrlContext } from "./chat/hostImageUrl";

import { Suspense, use } from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";

import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";

import { mathKind } from "@t3tools/shared/markdownMath";

import { MarkdownMath } from "./chat/MarkdownMath";

import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";

import { resolveExternalWebLinkHost } from "./chat/externalLinkContextMenu";

import { RenderErrorBoundary } from "./RenderErrorBoundary";

import { resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta } from "../markdown-links";

import { useRightPanelStore } from "../rightPanelStore";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";

import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./chat/ChatMarkdownMedia";

import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";

import { ChatMarkdownRendererContext, ChatMarkdownTextContext, selectInlineCode } from "./chat/chatMarkdownComponentHelpers";

export const CHAT_MARKDOWN_COMPONENTS: NonNullable<ReactMarkdownOptions["components"]> = {
  ...CHAT_MARKDOWN_COMPONENTS_LEADING,
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip, mathEnabled, inline } =
      use(ChatMarkdownRendererContext);
    const math = mathEnabled ? mathKind(className) : null;
    if (math) {
      return (
        <MarkdownMath
          tex={nodeToPlainText(children)}
          display={math === "display"}
          focusable={!inline}
        />
      );
    }
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }
      return (
        <code {...props} className={className} onDoubleClick={selectInlineCode}>
          {children}
        </code>
      );
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      sourceControlMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
      fileLinkChip,
      resolvedTheme,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    // A `<picture>`'s source for this theme, resolved like any other image.
    const themeSrc = node?.properties?.[resolvedTheme === "dark" ? "dataDarkSrc" : "dataLightSrc"];
    const localSrc = typeof themeSrc === "string" ? undefined : node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc =
      typeof themeSrc === "string" ? themeSrc : typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const mediaKind = mediaKindFromPath(classifiedSrc);
    if (mediaKind === "audio") {
      const filePath = imageSource._tag === "WorkspaceFile" ? imageSource.path : null;
      const name =
        (filePath ?? classifiedSrc.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).at(-1) ||
        altText ||
        "Audio";
      if (imageSource._tag !== "Direct" && !(filePath && threadRef)) {
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="audio" />;
      }
      return (
        <InlineAudioPreview
          key={classifiedSrc}
          name={name}
          copyMarkdown={copyMarkdown}
          {...(filePath && threadRef
            ? {
                environmentId: threadRef.environmentId,
                resource: {
                  _tag: "media-file" as const,
                  threadId: threadRef.threadId,
                  path: filePath,
                },
                onOpen: () => useRightPanelStore.getState().openFile(threadRef, filePath),
              }
            : imageSource._tag === "Direct"
              ? { src: resolveProtocolRelativeMediaUrl(imageSource.uri) }
              : {})}
        />
      );
    }
    if (mediaKind === null && imageSource._tag === "WorkspaceFile") {
      const fileLinkMeta = resolveMarkdownFileLinkMeta(srcString, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) return fileLinkChip(fileLinkMeta, copyMarkdown, srcString);
    }
    const kind = mediaKind ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const hostMediaUrl =
      directUri === null
        ? null
        : (sourceControlClients.mediaUrl(resolveProtocolRelativeMediaUrl(directUri))?.fetchUrl ??
          null);
    if (
      sourceControlMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      hostMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: hostMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          fallbackSrc={hostMediaUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    const hostImageUrl = use(HostImageUrlContext);
    if (imageSource._tag === "WorkspaceFile" && kind === "image" && hostImageUrl !== null) {
      const hostSrc = hostImageUrl(imageSource.path);
      return (
        <ChatMarkdownImage
          key={hostSrc}
          src={hostSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={{ kind, name: altText || kind, src: hostSrc }}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: imageSource.path,
          }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const {
      resolvedTheme,
      diffThemeName,
      expandMedia,
      isStreaming,
      onRunShellCommand,
      inline,
      mathEnabled,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);
    if (
      mathEnabled &&
      language === "math" &&
      (!isStreaming ||
        mathKind(codeBlock.className) === "display" ||
        isClosedCodeFence(node, text, codeBlock.code))
    ) {
      return <MarkdownMath tex={codeBlock.code} display focusable={!inline} />;
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const highlightedCode = (
      <RenderErrorBoundary
        resetKeys={[codeBlock.code, language, diffThemeName, isStreaming]}
        fallback={<pre {...props}>{children}</pre>}
      >
        <Suspense
          fallback={
            <pre {...props} className="invisible" aria-hidden>
              {children}
            </pre>
          }
        >
          <SuspenseShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            isStreaming={isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    );
    if (language === "mermaid") {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
          isStreaming={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
          onExpand={(src) =>
            expandMedia({
              images: [{ src, name: "Mermaid diagram", mimeType: "image/svg+xml" }],
              index: 0,
            })
          }
        >
          {highlightedCode}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand && !isStreaming && isClosedCodeFence(node, text, codeBlock.code)
            ? onRunShellCommand
            : undefined
        }
        isStreaming={isStreaming}
      >
        {highlightedCode}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;
