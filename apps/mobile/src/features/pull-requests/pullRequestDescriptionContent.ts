import type { PullRequestBodySegment } from "@t3tools/client-runtime/pull-request-markdown";
import { msg } from "gt-react-native";
import { parseMarkdownDocument, type MarkdownNode } from "../../lib/markdownDocument";
import { m, type MessageResolver } from "../../i18n/messages";
import { imagePreviewName } from "../../lib/filePreviewGallery";
import { markdownDocumentImages } from "../../lib/markdownImageSources";
import { isPullRequestVideoUrl, isPullRequestWebUrl } from "./pullRequestMediaSource";

interface PullRequestAttachment {
  readonly uri: string;
  readonly caption: string;
  readonly kind: "image" | "video" | "unknown";
}

export function pullRequestDescriptionContent(
  document: MarkdownNode,
  media: readonly PullRequestBodySegment[] = [],
  resolve: MessageResolver = m,
) {
  const recordImages = (target: Map<string, PullRequestAttachment>, root: MarkdownNode) => {
    for (const { url, alt, title } of markdownDocumentImages(root, document)) {
      if (!url || !isPullRequestWebUrl(url) || target.has(url)) continue;
      const isVideo = isPullRequestVideoUrl(url);
      target.set(url, {
        uri: url,
        caption: alt || title || resolve(isVideo ? msg("Video") : msg("Image")),
        kind: isVideo ? "video" : "image",
      });
    }
  };
  const documentImages = new Map<string, PullRequestAttachment>();
  const text: string[] = [];
  recordImages(documentImages, document);
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" || node.type === "imageReference" || node.type === "html") return;
    if ("value" in node) text.push(node.value);
    if ("children" in node) node.children.forEach(visit);
    if (["paragraph", "heading", "listItem", "code"].includes(node.type)) text.push("\n");
    if (node.type === "break") text.push(" ");
  };
  visit(document);

  if (media.length === 0) {
    return { preview: text.join("").trim(), attachments: [...documentImages.values()] };
  }

  const attachments = new Map<string, PullRequestAttachment>();
  const collect = (segment: PullRequestBodySegment) => {
    if (segment.kind === "table") {
      segment.rows.flat().forEach((cell) => cell.segments.forEach(collect));
      return;
    }
    if (segment.kind === "markdown") {
      if (segment.text.includes("![") || /<img[\s>]/i.test(segment.text)) {
        recordImages(attachments, parseMarkdownDocument(segment.text));
      }
      return;
    }
    if (segment.kind === "attachment" && !attachments.has(segment.url)) {
      const fromDocument = documentImages.get(segment.url);
      attachments.set(
        segment.url,
        fromDocument ?? {
          uri: segment.url,
          caption:
            segment.media === "video"
              ? resolve(msg("Video"))
              : imagePreviewName(segment.url, null, resolve(msg("Image"))),
          kind: segment.media,
        },
      );
    }
  };
  media.forEach(collect);
  for (const [uri, item] of documentImages) {
    if (!attachments.has(uri)) attachments.set(uri, item);
  }
  return { preview: text.join("").trim(), attachments: [...attachments.values()] };
}
