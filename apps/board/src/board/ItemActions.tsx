import { Send } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { ForYouAnswer, ForYouItem } from "../domain/forYou";
import { ActionButton } from "./CardActions";

const field =
  "w-full resize-none rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-muted";

/** The buttons of a `foryou.jsonl` item, which send the user's choice to the orchestrator. */
export function ItemActions({
  item,
  sent,
  send,
}: {
  item: ForYouItem;
  sent: boolean;
  send: (answer: ForYouAnswer) => void;
}) {
  const [text, setText] = useState("");
  if (item.kind === "question") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (text.trim() !== "") send({ type: "text", text: text.trim() });
    };
    return (
      <div className="flex flex-col gap-2">
        {(item.options ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(item.options ?? []).map((option) => (
              <ActionButton
                key={option}
                disabled={sent}
                onClick={() => send({ type: "text", text: option })}
              >
                {option}
              </ActionButton>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="flex items-end gap-1.5">
          <textarea
            rows={2}
            value={text}
            disabled={sent}
            aria-label="Your answer"
            placeholder="Type your own answer"
            onChange={(event) => setText(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
            className={field}
          />
          <button
            type="submit"
            aria-label="Send answer"
            disabled={sent || text.trim() === ""}
            onPointerDown={(event) => event.stopPropagation()}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg disabled:opacity-40"
          >
            <Send className="size-3.5" />
          </button>
        </form>
      </div>
    );
  }
  if (item.kind === "read") {
    return (
      <div className="flex gap-1.5">
        <ActionButton
          tone="primary"
          disabled={sent}
          onClick={() => send({ type: "choice", choice: "read" })}
        >
          Mark read
        </ActionButton>
      </div>
    );
  }
  const yes = item.kind === "resume" ? "resume" : "approve";
  return (
    <div className="flex gap-1.5">
      <ActionButton
        tone="primary"
        disabled={sent}
        onClick={() => send({ type: "choice", choice: yes })}
      >
        {yes === "resume" ? "Resume" : "Approve"}
      </ActionButton>
      {item.status !== "held" && (
        <ActionButton disabled={sent} onClick={() => send({ type: "choice", choice: "hold" })}>
          Hold
        </ActionButton>
      )}
    </div>
  );
}
