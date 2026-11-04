import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { use } from "react";

import { ModelMentionChip } from "./chat/ModelMentionChip";
import {
  CHIP_NODE_SELECTION_CLASS_NAME,
  ComposerContextActionsContext,
} from "./composerContextPresentation";

function ComposerModelNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <ModelMentionChip
        environmentId={actions.environmentId}
        instanceId={(node.attrs.instanceId as string) ?? ""}
        model={(node.attrs.model as string) ?? ""}
        source={(node.attrs.source as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}

/** `model:<instance>/<model>` from the `@` menu; `source` is the exact prompt text. */
export const ComposerModelExtension = Node.create({
  name: "composer-model",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      instanceId: { default: "" },
      model: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-model]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-model": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerModelNodeView);
  },
});
