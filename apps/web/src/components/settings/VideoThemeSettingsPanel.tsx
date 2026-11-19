import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import {
  DEFAULT_VIDEO_SURFACE_OPACITY,
  MAX_VIDEO_SURFACE_OPACITY,
  MIN_VIDEO_SURFACE_OPACITY,
  type VideoBackgroundSource,
} from "@t3tools/contracts/settings";
import { FolderOpenIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const SOURCE_LABELS: Record<VideoBackgroundSource, string> = {
  off: "Off",
  galaxy: "Animated galaxy",
  file: "Video from a folder",
};

/** Settings → Video theme: a moving background behind the app. */
export function VideoThemeSettingsPanel() {
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings((current) => ({
    source: current.videoBackground,
    folder: current.videoBackgroundFolder,
    file: current.videoBackgroundFile,
    surfaceOpacity: current.videoSurfaceOpacity,
  }));
  const updateSettings = updateClientSettings;
  const listFolder =
    typeof window === "undefined" ? undefined : window.desktopBridge?.listVideoFolder;
  const [files, setFiles] = useState<ReadonlyArray<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the chosen folder's video list from the desktop app when the page opens
  useEffect(() => {
    if (!listFolder || settings.folder === "") return;
    let cancelled = false;
    void listFolder(settings.folder).then((result) => {
      if (cancelled) return;
      setError(result.error);
      setFiles(result.error === null ? result.files : null);
    });
    return () => {
      cancelled = true;
    };
  }, [listFolder, settings.folder]);

  const chooseFolder = async () => {
    const folder = await readLocalApi()?.dialogs.pickFolder();
    if (!folder) return;
    updateSettings({
      videoBackgroundFolder: folder,
      videoBackgroundFile: "",
      videoBackground: "file",
    });
  };

  const ratio =
    (settings.surfaceOpacity - MIN_VIDEO_SURFACE_OPACITY) /
    (MAX_VIDEO_SURFACE_OPACITY - MIN_VIDEO_SURFACE_OPACITY);
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  const sources = (Object.keys(SOURCE_LABELS) as Array<VideoBackgroundSource>).filter(
    (source) => source !== "file" || listFolder !== undefined,
  );

  return (
    <SettingsPageContainer>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection id="video-theme" title="Video theme">
        <SettingsRow
          {...searchableSetting("setting-video-background")}
          description="Plays behind the whole app. It pauses while the window is hidden and stays still if your system asks for reduced motion."
          control={
            <Select
              value={settings.source}
              onValueChange={(source) =>
                updateSettings({ videoBackground: source as VideoBackgroundSource })
              }
            >
              <SelectTrigger aria-label="Video background" className="w-full sm:w-52">
                <SelectValue>{SOURCE_LABELS[settings.source]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {sources.map((source) => (
                  <SelectItem key={source} value={source}>
                    {SOURCE_LABELS[source]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("setting-video-surface-opacity")}
          description="How solid panels stay over the background. Text and controls are never faded. Low values read best with a dark theme."
          resetAction={
            settings.surfaceOpacity !== DEFAULT_VIDEO_SURFACE_OPACITY ? (
              <SettingResetButton
                ariaLabel="Reset surface opacity"
                onClick={() =>
                  updateSettings({ videoSurfaceOpacity: DEFAULT_VIDEO_SURFACE_OPACITY })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="video-surface-opacity"
              >
                {settings.surfaceOpacity}%
              </output>
              <input
                aria-label="Surface opacity over video"
                className="settings-slider min-w-0 flex-1"
                id="video-surface-opacity"
                max={MAX_VIDEO_SURFACE_OPACITY}
                min={MIN_VIDEO_SURFACE_OPACITY}
                step={5}
                style={sliderStyle}
                type="range"
                value={settings.surfaceOpacity}
                onChange={(event) =>
                  updateSettings({ videoSurfaceOpacity: Number(event.currentTarget.value) })
                }
              />
            </div>
          }
        />
      </SettingsSection>

      {listFolder ? (
        <SettingsSection
          id="video-theme-folder"
          title="Your videos"
          headerAction={
            <Button size="xs" variant="ghost" onClick={() => void chooseFolder()}>
              <FolderOpenIcon />
              {settings.folder ? "Change folder" : "Choose folder"}
            </Button>
          }
        >
          {settings.folder === "" ? (
            <SettingsRow
              title="No folder chosen"
              description="Pick a folder with .mp4, .webm, .mov, .m4v, .mkv, or .ogv files. Videos play muted and loop."
            />
          ) : files !== null && files.length === 0 ? (
            <SettingsRow title={settings.folder} description="No video files in this folder." />
          ) : (
            (files ?? []).map((file) => {
              const selected = settings.source === "file" && settings.file === file;
              return (
                <SettingsRow
                  key={file}
                  title={file}
                  description={selected ? "Playing as the background" : settings.folder}
                  control={
                    <Button
                      size="sm"
                      variant={selected ? "secondary" : "outline"}
                      disabled={selected}
                      onClick={() =>
                        updateSettings({ videoBackground: "file", videoBackgroundFile: file })
                      }
                    >
                      {selected ? "In use" : "Use"}
                    </Button>
                  }
                />
              );
            })
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
