import { type CSSProperties, type KeyboardEvent, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  ALERT_DIALOG_DESCRIPTION_CLASS,
  ALERT_DIALOG_FOOTER_CLASS,
  ALERT_DIALOG_FOOTER_DEFAULT_CLASS,
  ALERT_DIALOG_HEADER_CLASS,
  ALERT_DIALOG_TITLE_CLASS,
  DIALOG_BACKDROP_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// The app's alert dialog, scoped to the browser panel: it never takes focus and the rest of the app stays usable.
// Panels under 20rem tall (the mini player) get tighter padding, and the header scrolls as a whole.
export function BrowserDialogCard({
  dialog,
  url,
  canAnswer,
  onAnswer,
}: {
  readonly dialog: {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
  readonly url?: string | undefined;
  readonly canAnswer: boolean;
  readonly onAnswer: (accept: boolean, promptText?: string) => void;
}) {
  const [promptText, setPromptText] = useState(dialog.defaultValue);
  const titleId = useId();
  const descriptionId = useId();
  const host = hostOf(url);
  const isPrompt = dialog.type === "prompt";
  const accept = () => onAnswer(true, isPrompt ? promptText : undefined);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canAnswer || event.repeat || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(false);
    } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      event.stopPropagation();
      accept();
    }
  };
  return (
    <div className="@container-[size] absolute inset-0 z-40 flex items-center justify-center p-4">
      <div className={cn(DIALOG_BACKDROP_CLASS, "absolute z-auto")} />
      <div
        className={cn(DIALOG_POPUP_CLASS, "max-h-full max-w-lg text-popover-foreground")}
        style={{ "--nested-dialogs": 0 } as CSSProperties}
        role="dialog"
        aria-label={host ? undefined : "Browser dialog"}
        aria-labelledby={host ? titleId : undefined}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div
          className={cn(
            ALERT_DIALOG_HEADER_CLASS,
            "[@container_(height<20rem)]:gap-1 [@container_(height<20rem)]:overflow-y-auto [@container_(height<20rem)]:p-3",
            isPrompt && canAnswer && "pb-3",
          )}
        >
          {host ? (
            <h2
              id={titleId}
              className={cn(ALERT_DIALOG_TITLE_CLASS, "[@container_(height<20rem)]:text-sm")}
            >
              {host}
            </h2>
          ) : null}
          <p
            id={descriptionId}
            className={cn(
              ALERT_DIALOG_DESCRIPTION_CLASS,
              "whitespace-pre-line [@container_(height<20rem)]:max-h-none [@container_(height<20rem)]:shrink-0 [@container_(height<20rem)]:overflow-visible",
            )}
          >
            {dialog.message}
          </p>
        </div>
        {isPrompt && canAnswer ? (
          <div className="shrink-0 px-6 pt-1 pb-6 [@container_(height<20rem)]:px-3 [@container_(height<20rem)]:pb-3">
            <Input
              aria-label="Dialog response"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
            />
          </div>
        ) : null}
        <div
          className={cn(
            ALERT_DIALOG_FOOTER_CLASS,
            ALERT_DIALOG_FOOTER_DEFAULT_CLASS,
            "shrink-0 [@container_(height<20rem)]:px-3 [@container_(height<20rem)]:py-2",
          )}
        >
          {canAnswer ? (
            <>
              {dialog.type === "alert" ? null : (
                <Button variant="outline" onClick={() => onAnswer(false)}>
                  Cancel
                </Button>
              )}
              <Button onClick={accept}>OK</Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Take control to respond.</p>
          )}
        </div>
      </div>
    </div>
  );
}
