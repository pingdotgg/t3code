import { useRef, useState } from "react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { compressImageForStash } from "../../lib/imageCompression";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function TimelineBackgroundSettings() {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  const updateSettings = useUpdatePrimarySettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const result = await compressImageForStash(file);
      if (!result.ok) throw new Error("Choose a readable image no larger than 50 MB.");
      await persistClientSettingsUpdate((settings) => ({
        ...settings,
        timelineBackgroundImage: result.image.dataUrl,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save wallpaper.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection id="appearance-wallpaper" title="Wallpaper">
      <SettingsRow
        title="Chat wallpaper"
        description="Choose an image for the conversation background."
        control={
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? "Saving…" : "Choose image"}
            </Button>
            {image ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  updateSettings({
                    timelineBackgroundImage: "",
                    timelineBackgroundOpacity: DEFAULT_CLIENT_SETTINGS.timelineBackgroundOpacity,
                    timelineBackgroundBlur: 0,
                  })
                }
              >
                Remove
              </Button>
            ) : null}
          </div>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
      {image ? (
        <>
          <img
            src={image}
            alt="Current wallpaper"
            className="max-h-48 w-full rounded-lg object-cover"
          />
          <SettingsRow
            title="Opacity"
            control={
              <input
                aria-label="Wallpaper opacity"
                className="settings-slider"
                type="range"
                min={0}
                max={100}
                value={opacity}
                onChange={(event) =>
                  updateSettings({ timelineBackgroundOpacity: Number(event.currentTarget.value) })
                }
              />
            }
          />
          <SettingsRow
            title="Blur"
            control={
              <input
                aria-label="Wallpaper blur"
                className="settings-slider"
                type="range"
                min={0}
                max={30}
                value={blur}
                onChange={(event) =>
                  updateSettings({ timelineBackgroundBlur: Number(event.currentTarget.value) })
                }
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
