import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ArrowRightIcon, ImagePlusIcon, LinkIcon, XIcon } from "lucide-react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { compressImageForWallpaper } from "../../lib/imageCompression";
import {
  TimelineBackgroundImage,
  CHAT_BACKGROUND_TEXT_SHADOW_CLASSES,
  timelineTextShadowStyle,
  useTimelineBackgroundFailed,
} from "../chat/ChatTimelineBackground";
import ChatMarkdown from "../ChatMarkdown";
import {
  AssistantMessageSurface,
  UserMessageBubble,
  WorkingIndicator,
  LiveActivityRow,
} from "../chat/MessagesTimeline";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX_BLUR = 30;

export function TimelineBackgroundSettings() {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  const shadowOpacity = useClientSettings((settings) => settings.timelineTextShadowOpacity);
  const shadowBlur = useClientSettings((settings) => settings.timelineTextShadowBlur);
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState({ image, url: image.startsWith("http") ? image : "" });
  const url = draft.image === image ? draft.url : image.startsWith("http") ? image : "";
  const setUrl = (value: string) => setDraft({ image, url: value });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewStartedAt] = useState(() => new Date().toISOString());
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  const [shadowOpacityDraft, setShadowOpacityDraft] = useState<number | null>(null);
  const [shadowBlurDraft, setShadowBlurDraft] = useState<number | null>(null);
  const previewOpacity = opacityDraft ?? opacity;
  const previewBlur = blurDraft ?? blur;
  const previewShadowOpacity = shadowOpacityDraft ?? shadowOpacity;
  const previewShadowBlur = shadowBlurDraft ?? shadowBlur;
  const imageFailed = useTimelineBackgroundFailed(image);
  const hasPreviewBackground = Boolean(image) && previewOpacity > 0 && !imageFailed;
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  function saveOpacity(value: number) {
    setOpacityDraft(null);
    if (value !== opacity) updateSettings({ timelineBackgroundOpacity: value });
  }

  function saveBlur(value: number) {
    setBlurDraft(null);
    if (value !== blur) updateSettings({ timelineBackgroundBlur: value });
  }

  function saveShadowOpacity(value: number) {
    setShadowOpacityDraft(null);
    if (value !== shadowOpacity) updateSettings({ timelineTextShadowOpacity: value });
  }

  function saveShadowBlur(value: number) {
    setShadowBlurDraft(null);
    if (value !== shadowBlur) updateSettings({ timelineTextShadowBlur: value });
  }

  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );

  async function applyImage(source: string | File) {
    const generation = ++request.current;
    setBusy(true);
    setError("");
    try {
      let nextImage: string;
      if (typeof source === "string") {
        const parsed = new URL(source.trim());
        if (!["https:", "http:"].includes(parsed.protocol)) {
          throw new Error("Use an http or https image URL, or choose a local file.");
        }
        nextImage = parsed.href;
      } else {
        const result = await compressImageForWallpaper(source);
        if (!result.ok) {
          throw new Error(
            result.reason === "too-large"
              ? "Choose an image no larger than 50 MB and 64 megapixels."
              : "Could not read this image. Choose a PNG, JPEG, GIF, or WebP file.",
          );
        }
        nextImage = result.image.dataUrl;
      }
      if (generation !== request.current) return;
      await new Promise<void>((resolve, reject) => {
        const probe = new Image();
        const timeout = window.setTimeout(() => finish(false), 15000);
        function finish(loaded: boolean) {
          window.clearTimeout(timeout);
          probe.removeEventListener("load", onLoad);
          probe.removeEventListener("error", onError);
          if (loaded) resolve();
          else
            reject(new Error("Could not load this image. Check the URL or choose another file."));
        }
        const onLoad = () => finish(true);
        const onError = () => finish(false);
        probe.addEventListener("load", onLoad);
        probe.addEventListener("error", onError);
        probe.src = nextImage;
      });
      if (generation !== request.current) return;
      try {
        await persistClientSettingsUpdate((current) =>
          generation === request.current
            ? { ...current, timelineBackgroundImage: nextImage }
            : current,
        );
      } catch {
        throw new Error(
          "Could not save this image. Client storage may be full. Try a smaller image.",
        );
      }
    } catch (cause) {
      if (generation === request.current) {
        setError(
          cause instanceof TypeError
            ? "Enter a full image URL, or choose a local file."
            : cause instanceof Error
              ? cause.message
              : "Could not load this image.",
        );
      }
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }

  function removeImage() {
    request.current++;
    setBusy(false);
    setError("");
    setUrl("");
    updateSettings({
      timelineBackgroundImage: "",
      timelineBackgroundOpacity: DEFAULT_CLIENT_SETTINGS.timelineBackgroundOpacity,
      timelineBackgroundBlur: DEFAULT_CLIENT_SETTINGS.timelineBackgroundBlur,
    });
  }

  return (
    <SettingsSection
      id="timeline-background"
      title="Wallpaper"
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((item) =>
          item.type.startsWith("image/"),
        );
        if (!file) return;
        event.preventDefault();
        if (busy) return;
        void applyImage(file);
      }}
    >
      <div
        className="relative isolate overflow-hidden rounded-t-xl bg-background px-5 py-5"
        aria-label="Wallpaper preview"
        style={timelineTextShadowStyle(previewShadowOpacity, previewShadowBlur)}
      >
        <TimelineBackgroundImage image={image} opacity={previewOpacity} blur={previewBlur} />
        <div className="mx-auto max-w-lg space-y-4 text-sm leading-relaxed">
          <div className="flex justify-end">
            <UserMessageBubble>Can you give this page a softer look?</UserMessageBubble>
          </div>
          <WorkingIndicator createdAt={previewStartedAt} />
          <AssistantMessageSurface>
            <ChatMarkdown
              glassSurfaces={hasPreviewBackground}
              className={cn(hasPreviewBackground && CHAT_BACKGROUND_TEXT_SHADOW_CLASSES)}
              cwd={undefined}
              text="I'll adjust the spacing and colors, then check how it looks."
            />
          </AssistantMessageSurface>
          <LiveActivityRow label="Reading styles.css" iconName="eye" active />
        </div>
      </div>
      <SettingsRow
        title="Image"
        description="Enter an image URL, paste an image into the field, or choose a file."
        resetAction={
          image || busy ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={image ? "Remove image" : "Cancel import"}
                    onClick={removeImage}
                  >
                    <XIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{image ? "Remove image" : "Cancel import"}</TooltipPopup>
            </Tooltip>
          ) : null
        }
        status={
          busy ? (
            <span role="status">Loading image…</span>
          ) : error || imageFailed ? (
            <span role="alert" className="text-destructive">
              {error || "This image is unavailable. Choose another image or remove it."}
            </span>
          ) : null
        }
        control={
          <form
            className="flex w-full items-center gap-2 sm:w-96"
            onSubmit={(event) => {
              event.preventDefault();
              void applyImage(url);
            }}
          >
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <LinkIcon className="size-3.5 text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Background image URL"
                placeholder="Paste an image or URL"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                size="sm"
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Apply image URL"
                  title="Apply image URL"
                  disabled={busy || !url.trim()}
                >
                  <ArrowRightIcon />
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlusIcon />
              Choose image
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              aria-label="Choose background image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void applyImage(file);
              }}
            />
          </form>
        }
      />
      <WallpaperSlider
        title="Opacity"
        description="How strongly the image shows through the chat."
        setting="timelineBackgroundOpacity"
        resetLabel="wallpaper opacity"
        id="timeline-background-opacity"
        label="Background opacity"
        value={previewOpacity}
        savedValue={opacity}
        max={100}
        unit="%"
        disabled={!image}
        onDraft={setOpacityDraft}
        onCommit={saveOpacity}
      />
      <WallpaperSlider
        title="Blur"
        description="Softens the image behind messages."
        setting="timelineBackgroundBlur"
        resetLabel="wallpaper blur"
        id="timeline-background-blur"
        label="Background blur"
        value={previewBlur}
        savedValue={blur}
        max={MAX_BLUR}
        unit="px"
        disabled={!image}
        onDraft={setBlurDraft}
        onCommit={saveBlur}
      />
      <WallpaperSlider
        title="Text shadow"
        description="Strength behind message text and the new-thread heading. Set to 0% to turn it off."
        setting="timelineTextShadowOpacity"
        resetLabel="text shadow strength"
        id="timeline-text-shadow-opacity"
        label="Text shadow strength"
        value={previewShadowOpacity}
        savedValue={shadowOpacity}
        max={100}
        unit="%"
        disabled={!image}
        onDraft={setShadowOpacityDraft}
        onCommit={saveShadowOpacity}
      />
      <WallpaperSlider
        title="Shadow blur"
        description="Softens the text shadow."
        setting="timelineTextShadowBlur"
        resetLabel="text shadow blur"
        id="timeline-text-shadow-blur"
        label="Text shadow blur"
        value={previewShadowBlur}
        savedValue={shadowBlur}
        max={8}
        unit="px"
        disabled={!image}
        onDraft={setShadowBlurDraft}
        onCommit={saveShadowBlur}
      />
    </SettingsSection>
  );
}

function WallpaperSlider({
  title,
  description,
  setting,
  resetLabel,
  savedValue,
  id,
  label,
  value,
  max,
  unit,
  disabled,
  onDraft,
  onCommit,
}: {
  title: string;
  description: string;
  setting:
    | "timelineBackgroundOpacity"
    | "timelineBackgroundBlur"
    | "timelineTextShadowOpacity"
    | "timelineTextShadowBlur";
  resetLabel: string;
  savedValue: number;
  id: string;
  label: string;
  value: number;
  max: number;
  unit: string;
  disabled: boolean;
  onDraft: (value: number | null) => void;
  onCommit: (value: number) => void;
}) {
  const progress = value / max;
  const updateSettings = useUpdatePrimarySettings();
  const defaultValue = DEFAULT_CLIENT_SETTINGS[setting];
  return (
    <SettingsRow
      title={title}
      description={description}
      aria-disabled={disabled || undefined}
      resetAction={
        savedValue !== defaultValue ? (
          <SettingResetButton
            label={resetLabel}
            onClick={() => updateSettings({ [setting]: defaultValue })}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            htmlFor={id}
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
          >
            {value}
            {unit}
          </output>
          <input
            id={id}
            aria-label={label}
            type="range"
            min={0}
            max={max}
            step={1}
            value={value}
            disabled={disabled}
            className="settings-slider min-w-0 flex-1"
            style={
              {
                "--settings-slider-progress": `${progress * 100}%`,
                "--settings-slider-fill-offset": `${0.5 - progress}rem`,
              } as CSSProperties
            }
            onChange={(event) => onDraft(Number(event.target.value))}
            onPointerUp={(event) => onCommit(Number(event.currentTarget.value))}
            onPointerCancel={() => onDraft(null)}
            onKeyUp={(event) => onCommit(Number(event.currentTarget.value))}
            onBlur={(event) => onCommit(Number(event.currentTarget.value))}
          />
        </div>
      }
    />
  );
}
