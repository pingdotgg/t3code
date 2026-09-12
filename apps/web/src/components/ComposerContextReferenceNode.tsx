import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { ComposerContextId } from "@t3tools/contracts";
import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactElement } from "react";

import { randomUUID } from "~/lib/utils";
import { COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME } from "./composerInlineChip";
import { ComposerContextReferenceChip } from "./composerContextPresentation";

export interface ComposerContextReference {
  kind: string;
  contextId: string;
  label: string;
}

export type SerializedComposerContextReferenceNode = Spread<
  ComposerContextReference & {
    referenceId: string;
    type: "composer-context-reference";
    version: 1;
  },
  SerializedLexicalNode
>;

/**
 * One inline occurrence of a context payload. The node's text is the canonical link, so the
 * prompt string carries kind and id and rebuilding the editor from it restores the same chip.
 * `referenceId` identifies this occurrence; duplicating the node mints a new one.
 */
export class ComposerContextReferenceNode extends DecoratorNode<ReactElement> {
  __kind: string;
  __contextId: string;
  __label: string;
  __referenceId: string;

  static override getType(): "composer-context-reference" {
    return "composer-context-reference";
  }

  static override clone(node: ComposerContextReferenceNode): ComposerContextReferenceNode {
    return new ComposerContextReferenceNode(
      { kind: node.__kind, contextId: node.__contextId, label: node.__label },
      node.__referenceId,
      node.__key,
    );
  }

  static override importJSON(
    serializedNode: SerializedComposerContextReferenceNode,
  ): ComposerContextReferenceNode {
    return $createComposerContextReferenceNode(
      {
        kind: serializedNode.kind,
        contextId: serializedNode.contextId,
        label: serializedNode.label,
      },
      serializedNode.referenceId,
    ).updateFromJSON(serializedNode);
  }

  constructor(reference: ComposerContextReference, referenceId: string, key?: NodeKey) {
    super(key);
    this.__kind = reference.kind;
    this.__contextId = reference.contextId;
    this.__label = reference.label;
    this.__referenceId = referenceId;
  }

  override exportJSON(): SerializedComposerContextReferenceNode {
    const latest = this.getLatest();
    return {
      ...super.exportJSON(),
      kind: latest.__kind,
      contextId: latest.__contextId,
      label: latest.__label,
      referenceId: latest.__referenceId,
      type: "composer-context-reference",
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
    const latest = this.getLatest();
    return formatComposerContextReference({
      kind: latest.__kind,
      contextId: latest.__contextId as ComposerContextId,
      label: latest.__label,
    });
  }

  override isInline(): true {
    return true;
  }

  getReference(): ComposerContextReference {
    const latest = this.getLatest();
    return { kind: latest.__kind, contextId: latest.__contextId, label: latest.__label };
  }

  override decorate(): ReactElement {
    const latest = this.getLatest();
    return (
      <ComposerContextReferenceChip
        kind={latest.__kind}
        contextId={latest.__contextId}
        label={latest.__label}
      />
    );
  }
}

export function $createComposerContextReferenceNode(
  reference: ComposerContextReference,
  referenceId: string = randomUUID(),
): ComposerContextReferenceNode {
  return $applyNodeReplacement(new ComposerContextReferenceNode(reference, referenceId));
}
