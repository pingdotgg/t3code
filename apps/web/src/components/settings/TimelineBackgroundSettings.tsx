import { type CSSProperties, useRef, useState } from "react";
import { IMAGE_ATTACHMENT_MAX_EDGE } from "@t3tools/client-runtime/image-attachment-size";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import {
  compressImageToByteLimit,
  MAX_STASH_IMAGE_DATA_URL_CHARS,
  readFileAsDataUrl,
} from "../../lib/imageCompression";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Reserve the longest prefix the accepted types produce; base64 stores 3 bytes in every 4 characters.
const WALLPAPER_DATA_URL_PREFIX_CHARS = "data:image/jpeg;base64,".length;
const MAX_WALLPAPER_BYTES =
  Math.floor((MAX_STASH_IMAGE_DATA_URL_CHARS - WALLPAPER_DATA_URL_PREFIX_CHARS) / 4) * 3;

/** Fits the image to the attachment edge and budget, and rejects data that cannot render. */
async function prepareWallpaper(file: File): Promise<string> {
  const result = await compressImageToByteLimit(file, MAX_WALLPAPER_BYTES);
  if (!result.ok) throw new Error("Choose a readable image no larger than 50 MB.");
  const dataUrl = await readFileAsDataUrl(result.file);
  const decoded = new Image();
  decoded.src = dataUrl;
  await decoded.decode().catch(() => {
    throw new Error("Choose a readable image no larger than 50 MB.");
  });
  if (Math.max(decoded.naturalWidth, decoded.naturalHeight) > IMAGE_ATTACHMENT_MAX_EDGE) {
    throw new Error(
      `Choose an image no larger than ${IMAGE_ATTACHMENT_MAX_EDGE} pixels on each side.`,
    );
  }
  return dataUrl;
}

/** Saves the image as the wallpaper; returns an error message, or "" on success. */
async function saveWallpaper(file: File): Promise<string> {
  try {
    const timelineBackgroundImage = await prepareWallpaper(file);
    await persistClientSettingsUpdate((settings) => ({
      ...settings,
      timelineBackgroundImage,
    }));
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Could not save wallpaper.";
  }
}

export function TimelineBackgroundSettings() {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  const updateSettings = useUpdatePrimarySettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Settings writes serialize the whole image, so a drag only persists once it settles.
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  const shownOpacity = opacityDraft ?? opacity;
  const shownBlur = blurDraft ?? blur;
  function settleOpacity() {
    if (opacityDraft === null) return;
    updateSettings({ timelineBackgroundOpacity: opacityDraft });
    setOpacityDraft(null);
  }
  function settleBlur() {
    if (blurDraft === null) return;
    updateSettings({ timelineBackgroundBlur: blurDraft });
    setBlurDraft(null);
  }
  async function upload(file: File) {
    setBusy(true);
    setError("");
    setError(await saveWallpaper(file));
    setBusy(false);
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
            style={{
              opacity: shownOpacity / 100,
              filter: shownBlur > 0 ? `blur(${shownBlur}px)` : undefined,
            }}
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
                value={shownOpacity}
                style={
                  {
                    "--settings-slider-progress": `${shownOpacity}%`,
                    "--settings-slider-fill-offset": `${0.5 - shownOpacity / 100}rem`,
                  } as CSSProperties
                }
                onChange={(event) => setOpacityDraft(Number(event.currentTarget.value))}
                onPointerUp={settleOpacity}
                onKeyUp={settleOpacity}
                onBlur={settleOpacity}
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
                value={shownBlur}
                style={
                  {
                    "--settings-slider-progress": `${(shownBlur / 30) * 100}%`,
                    "--settings-slider-fill-offset": `${0.5 - shownBlur / 30}rem`,
                  } as CSSProperties
                }
                onChange={(event) => setBlurDraft(Number(event.currentTarget.value))}
                onPointerUp={settleBlur}
                onKeyUp={settleBlur}
                onBlur={settleBlur}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
