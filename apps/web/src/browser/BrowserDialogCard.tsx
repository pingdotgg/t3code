import { useState } from "react";
import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export function BrowserDialogCard({
  dialog,
  canAnswer,
  onAnswer,
  className,
}: {
  readonly dialog: {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
  readonly canAnswer: boolean;
  readonly onAnswer: (accept: boolean, promptText?: string) => void;
  readonly className?: string;
}) {
  const gt = useGT();
  const [promptText, setPromptText] = useState(dialog.defaultValue);
  return (
    <div
      className={cn(
        "absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg",
        className,
      )}
      role="dialog"
      aria-label={gt("Browser dialog")}
    >
      <p className="break-words text-sm">{dialog.message}</p>
      {canAnswer ? (
        <>
          {dialog.type === "prompt" ? (
            <Input
              aria-label={gt("Dialog response")}
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onAnswer(false)}>
              <T>Dismiss</T>
            </Button>
            <Button
              size="sm"
              onClick={() => onAnswer(true, dialog.type === "prompt" ? promptText : undefined)}
            >
              <T>Accept</T>
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          <T>Take control to respond.</T>
        </p>
      )}
    </div>
  );
}
