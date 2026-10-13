import { CornerDownRightIcon } from "lucide-react";

import { Button } from "../ui/button";

/** In the side panel while the main thread has the composer. */
export function SideChatReplyBar(props: { needsAnswer: boolean; onReply: () => void }) {
  return (
    <div className="pointer-events-auto px-3 pb-3">
      <Button
        className="w-full"
        size="sm"
        variant={props.needsAnswer ? "default" : "outline"}
        onClick={props.onReply}
      >
        <CornerDownRightIcon className="size-3.5" />
        {props.needsAnswer ? "Side chat is waiting on you" : "Reply in side chat"}
      </Button>
    </div>
  );
}
