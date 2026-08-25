import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useI18n } from "~/i18n";

export function AssistantReasoningBlock({
  text,
  streaming,
  markdownCwd,
  threadRef,
  skills,
  initialOpen,
  onOpenChange,
}: {
  text: string;
  streaming: boolean;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  initialOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen ?? streaming);
  const previousStreamingRef = useRef(streaming);

  useEffect(() => {
    if (previousStreamingRef.current === streaming) return;
    previousStreamingRef.current = streaming;
    setOpen(streaming);
    onOpenChange?.(streaming);
  }, [onOpenChange, streaming]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="assistant-reasoning-block mb-2 rounded-md border border-border/50 bg-muted/30"
      data-reasoning-streaming={streaming ? "true" : "false"}
      data-reasoning-open={open ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50 data-panel-open:[&_svg:first-child]:rotate-90"
        data-scroll-anchor-ignore
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform" aria-hidden />
        <BotIcon className="size-3.5 shrink-0" aria-hidden />
        <span>{t(streaming ? "chat.reasoning.thinking" : "chat.reasoning.completed")}</span>
        {streaming ? <span className="animate-pulse text-muted-foreground/70">...</span> : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div
          className="ms-2.5 border-s-2 border-border/50 pb-2.5 pe-2.5 ps-2.5 text-sm text-muted-foreground/90"
          data-reasoning-content=""
        >
          <ChatMarkdown
            text={text}
            cwd={markdownCwd}
            threadRef={threadRef}
            isStreaming={streaming}
            skills={skills}
          />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
