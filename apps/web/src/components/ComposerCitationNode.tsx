import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  DecoratorNode,
  HISTORY_PUSH_TAG,
  SKIP_DOM_SELECTION_TAG,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { createContext, use, type ReactElement } from "react";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME } from "./composerInlineChip";

type SerializedComposerCitationNode = Spread<
  {
    citation: AssistantCitation;
    source: string;
    type: "composer-citation";
    version: 1;
  },
  SerializedLexicalNode
>;

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
};

export type ComposerCitationCommentTarget = {
  nodeKey: NodeKey;
  sourceAnchor?: AssistantCitationSourceAnchor;
};

export const ComposerCitationCommentContext = createContext<{
  openComment: ComposerCitationCommentTarget | null;
  onOpenChange: (nodeKey: NodeKey, open: boolean) => void;
}>({ openComment: null, onOpenChange: () => {} });

/** Consume a cite action once its controlled prompt has been committed to the editor. */
export function $consumeComposerCitationCommentRequest(requestRef: {
  current: ComposerCitationCommentRequest | null;
}): ComposerCitationCommentTarget | null {
  const request = requestRef.current;
  if (!request) return null;
  const root = $getRoot();
  const value = root.getTextContent();
  if (value === request.previousValue) return null;
  requestRef.current = null;
  if (value !== request.value) return null;

  // Controlled prompts use one paragraph with inline nodes and explicit line breaks.
  const paragraph = root.getFirstChild();
  if (!$isElementNode(paragraph)) return null;
  let offset = 0;
  for (const node of paragraph.getChildren()) {
    if (offset === request.citationStart && node instanceof ComposerCitationNode) {
      return { nodeKey: node.getKey(), sourceAnchor: request.sourceAnchor };
    }
    offset += node.getTextContentSize();
  }
  return null;
}

function ComposerCitationDecorator(props: { citation: AssistantCitation; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const commentContext = use(ComposerCitationCommentContext);
  const onSaveComment = (comment: string): boolean => {
    if (!editor.isEditable()) return false;
    let accepted = false;
    editor.update(
      () => {
        const node = $getNodeByKey(props.nodeKey);
        if (node instanceof ComposerCitationNode && node.isAttached()) {
          node.setComment(comment);
          accepted = true;
        }
      },
      { discrete: true, tag: [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG] },
    );
    return accepted;
  };
  const onRemove = () => {
    if (!editor.isEditable()) return;
    editor.update(
      () => {
        const node = $getNodeByKey(props.nodeKey);
        if (node instanceof ComposerCitationNode) {
          node.selectPrevious();
          node.remove();
        }
      },
      { tag: HISTORY_PUSH_TAG },
    );
    editor.getRootElement()?.focus({ preventScroll: true });
  };

  return (
    <span
      className="inline-flex min-w-0 max-w-full"
      contentEditable={false}
      spellCheck={false}
      data-composer-citation-chip="true"
    >
      <AssistantCitationChip
        citation={props.citation}
        commentEditor={{
          open: commentContext.openComment?.nodeKey === props.nodeKey,
          sourceAnchor:
            commentContext.openComment?.nodeKey === props.nodeKey
              ? commentContext.openComment.sourceAnchor
              : undefined,
          onOpenChange: (open) => {
            if (open && !editor.isEditable()) return;
            commentContext.onOpenChange(props.nodeKey, open);
          },
          onSave: onSaveComment,
        }}
        onRemove={onRemove}
      />
    </span>
  );
}

export class ComposerCitationNode extends DecoratorNode<ReactElement> {
  __citation: AssistantCitation;
  __source: string;

  static override getType(): string {
    return "composer-citation";
  }

  static override clone(node: ComposerCitationNode): ComposerCitationNode {
    return new ComposerCitationNode(node.__citation, node.__source, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerCitationNode): ComposerCitationNode {
    return $createComposerCitationNode(
      serializedNode.citation,
      serializedNode.source,
    ).updateFromJSON(serializedNode);
  }

  constructor(citation: AssistantCitation, source: string, key?: NodeKey) {
    super(key);
    this.__citation = citation;
    this.__source = source;
  }

  override exportJSON(): SerializedComposerCitationNode {
    const node = this.getLatest();
    return {
      ...super.exportJSON(),
      citation: node.__citation,
      source: node.__source,
      type: "composer-citation",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `${COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME} max-w-full`;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return this.getLatest().__source;
  }

  setComment(comment: string): this {
    const latest = this.getLatest();
    const citation = withAssistantCitationComment(latest.__citation, comment);
    if (citation.comment === latest.__citation.comment) return latest;
    const source = serializeAssistantCitation(citation);
    const writable = this.getWritable();
    writable.__citation = citation;
    writable.__source = source;
    return writable;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerCitationDecorator citation={this.__citation} nodeKey={this.__key} />;
  }
}

export function $createComposerCitationNode(
  citation: AssistantCitation,
  source: string,
): ComposerCitationNode {
  return $applyNodeReplacement(new ComposerCitationNode(citation, source));
}
