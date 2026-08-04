import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { normalizeIntegratedBrowserUrlPattern } from "../../browser/integratedBrowserLinkPatterns";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface IntegratedBrowserLinksSettingProps {
  readonly patterns: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}

/**
 * Add/remove editor for the URL patterns that make chat links open in the
 * integrated browser panel. Entries are stored and shown in canonical form
 * via `normalizeIntegratedBrowserUrlPattern` (bare domains → `*.domain.com`).
 */
export function IntegratedBrowserLinksSetting({
  patterns,
  onChange,
}: IntegratedBrowserLinksSettingProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      setError("Enter a URL pattern.");
      return;
    }
    const normalized = normalizeIntegratedBrowserUrlPattern(trimmed);
    if (normalized === null) {
      setError(
        "Use a host with an optional path, like github.com or docs.example.com/api — no scheme or port.",
      );
      return;
    }
    if (patterns.includes(normalized)) {
      setError("That pattern is already in the list.");
      return;
    }
    onChange([...patterns, normalized]);
    setInput("");
    setError(null);
  };

  const handleRemove = (pattern: string) => {
    onChange(patterns.filter((entry) => entry !== pattern));
    setError(null);
  };

  return (
    <div className="pb-2">
      {patterns.length > 0 ? (
        <div className="max-h-40 overflow-y-auto pb-1">
          {patterns.map((pattern) => (
            <div
              key={pattern}
              className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1"
            >
              <code className="min-w-0 truncate text-xs text-foreground/90">{pattern}</code>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${pattern}`}
                onClick={() => handleRemove(pattern)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          id="integrated-browser-link-pattern"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder="github.com or *.vercel.app"
          spellCheck={false}
          aria-label="Integrated browser URL pattern"
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
