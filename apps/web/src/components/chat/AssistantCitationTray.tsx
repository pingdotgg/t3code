import type { AssistantCitation } from "@t3tools/contracts";
import { withAssistantCitationComment } from "@t3tools/shared/assistantCitations";
import { QuoteIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { AssistantCitationQuote } from "./AssistantCitationChip";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

export function AssistantCitationTray({
  citations,
  onChange,
  onInsertInline,
}: {
  citations: ReadonlyArray<AssistantCitation>;
  onChange: (citations: ReadonlyArray<AssistantCitation>) => void;
  onInsertInline?: ((citation: AssistantCitation) => boolean) | undefined;
}) {
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  if (!citations.length) return null;
  const remove = (index: number) => {
    onChange(citations.filter((_, i) => i !== index));
    setEditing(null);
  };
  return (
    <div className="mb-2 flex w-fit items-center overflow-hidden rounded-full border border-border">
      <Popover
        open={open && !voiceSetupOpen}
        onOpenChange={(next) => {
          if (voiceSetupOpen) return;
          setOpen(next);
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="xs" />}
          openOnHover
          delay={150}
          closeDelay={150}
        >
          <QuoteIcon />
          {citations.length} {citations.length === 1 ? "annotation" : "annotations"}
        </PopoverTrigger>
        <PopoverPopup
          keepMounted
          {...composerFloatingLayerProps}
          width="md"
          aria-label="Citation tray"
        >
          <div className="max-h-96 space-y-4 overflow-y-auto">
            {citations.map((citation, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- identical quotes may appear more than once and the tray preserves their order
              <div key={index} className="space-y-2">
                <p>{index + 1}. Selected text:</p>
                <AssistantCitationQuote citation={{ ...citation, comment: undefined }} />
                <p>User comment: {citation.comment || "None"}</p>
                {editing === index ? (
                  <AssistantCitationCommentEditor
                    citation={citation}
                    onVoiceSetupOpenChange={setVoiceSetupOpen}
                    onSubmit={(comment) => {
                      onChange(
                        citations.map((item, i) =>
                          i === index ? withAssistantCitationComment(item, comment) : item,
                        ),
                      );
                      setEditing(null);
                      return true;
                    }}
                    onCancel={() => setEditing(null)}
                    moveLabel="Insert inline"
                    onMove={
                      onInsertInline
                        ? (comment) => {
                            if (onInsertInline(withAssistantCitationComment(citation, comment)))
                              remove(index);
                          }
                        : undefined
                    }
                  />
                ) : (
                  <div className="flex gap-2">
                    <Button variant="outline" size="xs" onClick={() => setEditing(index)}>
                      Edit
                    </Button>
                    {onInsertInline ? (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          if (onInsertInline(citation)) remove(index);
                        }}
                      >
                        Insert inline
                      </Button>
                    ) : null}
                    <Button variant="outline" size="xs" onClick={() => remove(index)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Clear all annotations"
        onClick={() => {
          onChange([]);
          setEditing(null);
        }}
      >
        <XIcon />
      </Button>
    </div>
  );
}
