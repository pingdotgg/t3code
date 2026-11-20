import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { openInPanel } from "./panel";
import { normalizeUrl } from "./tabs";

/** Web dev mode has no native tabs, so a typed address goes to the system browser. */
export function SystemBrowserBar() {
  const [draft, setDraft] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        openInPanel(draft);
      }}
      className="flex flex-col gap-1.5 border-t border-line p-2"
    >
      <p className="text-[11px] text-muted">
        Tabs need the desktop app. Links open in your system browser here.
      </p>
      <div className="flex flex-col gap-1.5">
        <input
          type="text"
          aria-label="Address"
          spellCheck={false}
          placeholder="Type a URL"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-focus"
        />
        <button
          type="submit"
          disabled={normalizeUrl(draft) === null}
          className="flex items-center justify-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-fg enabled:hover:bg-hover disabled:opacity-40"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Open in system browser
        </button>
      </div>
    </form>
  );
}
