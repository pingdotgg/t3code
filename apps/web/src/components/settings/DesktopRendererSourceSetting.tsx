import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

export function DesktopRendererSourceSetting() {
  const bridge = window.desktopBridge;
  const setLocalRendererUrl = bridge?.setLocalRendererUrl;
  const [currentUrl] = useState(() => bridge?.getLocalRendererUrl?.() ?? null);
  const [draftUrl, setDraftUrl] = useState(currentUrl ?? "http://localhost:5733");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!bridge?.getLocalRendererUrl || !setLocalRendererUrl) return null;

  const apply = async (url: string | null) => {
    setPending(true);
    setError(null);
    try {
      await setLocalRendererUrl(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the desktop UI source.");
      setPending(false);
    }
  };

  return (
    <SettingsRow
      title="Desktop UI source"
      description="Load this window from a local Vite server while keeping this app's connections and backend. Changing the source restarts the app."
      status={currentUrl === null ? "Built-in UI" : `Local UI: ${currentUrl}`}
    >
      <div className="flex flex-wrap items-center gap-2 py-3">
        <div className="w-full min-w-48 flex-1 sm:max-w-72">
          <Input
            aria-label="Local Vite URL"
            nativeInput
            size="sm"
            type="url"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            placeholder="http://localhost:5733"
            disabled={pending}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || draftUrl.trim().length === 0 || draftUrl === currentUrl}
          onClick={() => void apply(draftUrl)}
        >
          Use local UI
        </Button>
        {currentUrl !== null ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void apply(null)}>
            Use built-in UI
          </Button>
        ) : null}
      </div>
      {error ? <p className="pb-2 text-xs text-destructive">{error}</p> : null}
    </SettingsRow>
  );
}
