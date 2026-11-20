import { ChevronRight } from "lucide-react";

import { MessageActions } from "./MessageActions";
import { SkillText } from "./SkillText";

/** The user's message as T3 draws it: a bubble on the right. The first message is the brief, which folds away. */
export function UserRow({ text, brief, at }: { text: string; brief: boolean; at: number | null }) {
  if (brief) {
    return (
      <details className="group text-muted">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 hover:text-fg">
          <ChevronRight
            className="size-3.5 transition-transform group-open:rotate-90"
            aria-hidden
          />
          Brief sent to the orchestrator
        </summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded-lg border border-line bg-bg p-2.5 text-[11px] leading-5 break-words whitespace-pre-wrap">
          {text}
        </pre>
      </details>
    );
  }
  return (
    <div className="group/message flex flex-col items-end">
      <div className="max-w-[80%] rounded-2xl bg-message px-3 py-2 break-words whitespace-pre-wrap text-fg">
        <SkillText text={text} />
      </div>
      <MessageActions text={text} at={at} runningSince={null} />
    </div>
  );
}
