import { RegistryContext } from "@effect/atom-react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { type FormEvent, useContext, useState } from "react";

import { Tooltip } from "../ui/Tooltip";
import { browserHost } from "./host";
import { dispatchTabs, openTab, showAgents } from "./browserTabs";
import { iconButton } from "./styles";
import { normalizeUrl, type Tab } from "./tabs";

/** Back, forward, reload, and the address of the active tab. Enter on a typed address opens it, in a new tab when none is open, and Agents lists the tabs the board's agents hold. */
export function AddressBar({ tab }: { tab: Tab | null }) {
  const registry = useContext(RegistryContext);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeUrl(draft ?? tab?.url ?? "");
    setInvalid(url === null);
    if (url === null) return;
    setDraft(null);
    if (tab === null) {
      openTab(registry, url);
      return;
    }
    browserHost?.navigate(tab.id, url);
    dispatchTabs(registry, { type: "update", id: tab.id, patch: { url, loading: true } });
  };
  return (
    <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
      <Tooltip text="Back" side="bottom">
        <button
          type="button"
          aria-label="Back"
          disabled={tab === null || !tab.canGoBack}
          onClick={() => tab && browserHost?.history(tab.id, -1)}
          className={iconButton}
        >
          <ArrowLeft className="size-4" />
        </button>
      </Tooltip>
      <Tooltip text="Forward" side="bottom">
        <button
          type="button"
          aria-label="Forward"
          disabled={tab === null || !tab.canGoForward}
          onClick={() => tab && browserHost?.history(tab.id, 1)}
          className={iconButton}
        >
          <ArrowRight className="size-4" />
        </button>
      </Tooltip>
      <Tooltip text="Reload" side="bottom">
        <button
          type="button"
          aria-label="Reload"
          disabled={tab === null || tab.url === ""}
          onClick={() => tab && browserHost?.reload(tab.id)}
          className={iconButton}
        >
          <RotateCw className={`size-3.5 ${tab?.loading ? "animate-spin" : ""}`} />
        </button>
      </Tooltip>
      <form onSubmit={submit} className="min-w-0 flex-1">
        <input
          // A blank tab is new, and its address is the next thing typed.
          autoFocus={tab?.url === ""}
          type="text"
          aria-label="Address"
          aria-invalid={invalid}
          spellCheck={false}
          autoComplete="off"
          placeholder="Type a URL"
          value={draft ?? tab?.url ?? ""}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setInvalid(false);
          }}
          onBlur={() => setDraft(null)}
          className={`w-full rounded-md border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-focus ${invalid ? "border-red-400" : "border-line"}`}
        />
      </form>
      <button
        type="button"
        onClick={() => showAgents(registry)}
        className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
      >
        Agents
      </button>
    </div>
  );
}
