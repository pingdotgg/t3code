import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ArrowRightIcon, ImageIcon, ImagePlusIcon, LinkIcon, XIcon } from "lucide-react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { compressImageForStash, MAX_COMPRESSIBLE_SOURCE_BYTES } from "../../lib/imageCompression";
import {
  TimelineBackgroundImage,
  CHAT_BACKGROUND_TEXT_SHADOW_CLASSES,
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
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function TimelineBackgroundSettings() {
  const [open, setOpen] = useState(false);
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);

  return (
    <SettingsSection id="timeline-background" title="Wallpaper">
      <SettingsRow
        title="Wallpaper"
        description="Personalize your chat background with an image, opacity, and blur."
        control={
          <Popover open={open} onOpenChange={setOpen}>
            <div className="flex items-center gap-3">
              <div
                className="relative isolate flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background"
                aria-hidden="true"
              >
                {image ? (
                  <TimelineBackgroundImage image={image} opacity={opacity} blur={blur} />
                ) : (
                  <ImageIcon className="size-4 text-muted-foreground" />
                )}
              </div>
              <PopoverTrigger render={<Button variant="outline" size="sm" />}>
                Customize
              </PopoverTrigger>
            </div>
            <PopoverPopup
              align="end"
              className="w-[min(30rem,calc(100vw-2rem))]"
              viewportClassName="p-0 [--viewport-inline-padding:0px]"
            >
              {open && <TimelineBackgroundEditor />}
            </PopoverPopup>
          </Popover>
        }
      />
    </SettingsSection>
  );
}

function TimelineBackgroundEditor() {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState({ image, url: image.startsWith("http") ? image : "" });
  const url = draft.image === image ? draft.url : image.startsWith("http") ? image : "";
  const setUrl = (value: string) => setDraft({ image, url: value });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewStartedAt] = useState(() => new Date().toISOString());
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  const previewOpacity = opacityDraft ?? opacity;
  const previewBlur = blurDraft ?? blur;
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
        if (!source.type.startsWith("image/") || source.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
          throw new Error("Choose an image smaller than 50 MB.");
        }
        const result = await compressImageForStash(source);
        if (!result.ok) throw new Error("This image could not be saved. Try a smaller image.");
        nextImage = result.image.dataUrl;
      }
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

  return (
    <div
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
      <div className="flex items-center gap-2 px-4 py-3">
        <PopoverTitle className="mr-auto text-sm">Wallpaper</PopoverTitle>
        <Button
          variant="ghost"
          size="xs"
          disabled={!image && !busy}
          onClick={() => {
            request.current++;
            setBusy(false);
            setError("");
            setUrl("");
            updateSettings({
              timelineBackgroundImage: "",
              timelineBackgroundOpacity: DEFAULT_CLIENT_SETTINGS.timelineBackgroundOpacity,
              timelineBackgroundBlur: DEFAULT_CLIENT_SETTINGS.timelineBackgroundBlur,
            });
          }}
        >
          Remove image
        </Button>
        <PopoverClose
          render={<Button variant="ghost" size="icon-xs" aria-label="Close background settings" />}
        >
          <XIcon />
        </PopoverClose>
      </div>
      <div className="overflow-hidden rounded-b-lg">
        <div
          className="relative isolate overflow-hidden bg-background p-5 sm:p-6"
          aria-label="Wallpaper preview"
        >
          <TimelineBackgroundImage image={image} opacity={previewOpacity} blur={previewBlur} />
          <div
            className={cn(
              "mx-auto max-w-xl space-y-5 text-sm leading-relaxed",
              image && CHAT_BACKGROUND_TEXT_SHADOW_CLASSES,
            )}
          >
            <div className="flex justify-end">
              <UserMessageBubble>Can you give this page a softer look?</UserMessageBubble>
            </div>
            <WorkingIndicator createdAt={previewStartedAt} />
            <AssistantMessageSurface>
              <ChatMarkdown
                cwd={undefined}
                text="I'll adjust the spacing and colors, then check how it looks."
              />
            </AssistantMessageSurface>
            <LiveActivityRow label="Reading styles.css" iconName="eye" active />
          </div>
        </div>
        <div className="space-y-4 border-t border-border/60 p-4">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void applyImage(url);
            }}
          >
            <InputGroup className="min-w-48 flex-1">
              <InputGroupAddon>
                <LinkIcon className="size-3.5 text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Background image URL"
                placeholder="Paste an image or image URL"
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
              accept="image/*"
              className="hidden"
              aria-label="Choose background image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void applyImage(file);
              }}
            />
          </form>
          {busy && (
            <p role="status" className="text-xs text-muted-foreground">
              Loading image…
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-5 sm:gap-8">
            <div className="min-w-0">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <label htmlFor="timeline-background-opacity" className="text-muted-foreground">
                  Opacity
                </label>
                <output htmlFor="timeline-background-opacity" className="font-mono tabular-nums">
                  {previewOpacity}%
                </output>
              </div>
              <input
                id="timeline-background-opacity"
                aria-label="Background opacity"
                type="range"
                min={0}
                max={100}
                step={1}
                value={previewOpacity}
                style={
                  {
                    "--settings-slider-progress": `${previewOpacity}%`,
                    "--settings-slider-fill-offset": `${0.5 - previewOpacity / 100}rem`,
                  } as CSSProperties
                }
                disabled={!image}
                className="settings-slider w-full"
                onChange={(event) => setOpacityDraft(Number(event.target.value))}
                onPointerUp={(event) => saveOpacity(Number(event.currentTarget.value))}
                onPointerCancel={() => setOpacityDraft(null)}
                onKeyUp={(event) => saveOpacity(Number(event.currentTarget.value))}
                onBlur={(event) => saveOpacity(Number(event.currentTarget.value))}
              />
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <label htmlFor="timeline-background-blur" className="text-muted-foreground">
                  Blur
                </label>
                <output htmlFor="timeline-background-blur" className="font-mono tabular-nums">
                  {previewBlur}px
                </output>
              </div>
              <input
                id="timeline-background-blur"
                aria-label="Background blur"
                type="range"
                min={0}
                max={30}
                step={1}
                value={previewBlur}
                style={
                  {
                    "--settings-slider-progress": `${(previewBlur / 30) * 100}%`,
                    "--settings-slider-fill-offset": `${0.5 - previewBlur / 30}rem`,
                  } as CSSProperties
                }
                disabled={!image}
                className="settings-slider w-full"
                onChange={(event) => setBlurDraft(Number(event.target.value))}
                onPointerUp={(event) => saveBlur(Number(event.currentTarget.value))}
                onPointerCancel={() => setBlurDraft(null)}
                onKeyUp={(event) => saveBlur(Number(event.currentTarget.value))}
                onBlur={(event) => saveBlur(Number(event.currentTarget.value))}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
