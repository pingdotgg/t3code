import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

/**
 * A comment composer field with a Write/Preview toggle. The Write tab is a
 * plain `Textarea`; the Preview tab renders the current draft through
 * `ChatMarkdown` (chat-style line breaks) so authors can verify Markdown before
 * submitting. Shared by the reply composer and the inline edit form.
 *
 * `label` renders a visible caption wrapping the textarea (matching the
 * surrounding form fields). When omitted, pass `ariaLabel` so the textarea
 * still has an accessible name.
 */
export function MarkdownComposerField({
  value,
  onChange,
  disabled = false,
  label,
  ariaLabel,
  cwd,
  placeholder,
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly label?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly cwd?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly className?: string | undefined;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");

  const toggle = (
    <span className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background p-0.5">
      <button
        type="button"
        className={cn(
          "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
          mode === "write"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={mode === "write"}
        onClick={() => setMode("write")}
      >
        Write
      </button>
      <button
        type="button"
        className={cn(
          "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
          mode === "preview"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={mode === "preview"}
        onClick={() => setMode("preview")}
      >
        Preview
      </button>
    </span>
  );

  const control =
    mode === "preview" ? (
      <div
        className="min-h-16.5 rounded-lg border border-input bg-background px-3 py-2"
        data-testid="markdown-composer-preview"
      >
        {value.trim() ? (
          <ChatMarkdown text={value} cwd={cwd} lineBreaks className="text-sm leading-5" />
        ) : (
          <p className="text-xs text-muted-foreground">Nothing to preview yet.</p>
        )}
      </div>
    ) : (
      <Textarea
        size="sm"
        value={value}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between gap-2">
        {label ? (
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
        ) : (
          <span />
        )}
        {toggle}
      </div>
      {label ? (
        // Wrap the control in the captioned label so the textarea inherits the
        // visible caption as its accessible name (`getByLabelText`-friendly).
        <label className="block">
          <span className="sr-only">{label}</span>
          {control}
        </label>
      ) : (
        control
      )}
    </div>
  );
}
