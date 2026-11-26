// Fork: the theme studio's presets: built-ins, the user's own themes (save, update, rename,
// duplicate, delete) and sharing them as JSON.
import { useGT } from "gt-react";
import { CopyIcon, DownloadIcon, FileUpIcon, SaveIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useKaluwaLook } from "../../kaluwa/kaluwaLook";
import {
  parseStudioFile,
  serializeStudioFile,
  studioPreset,
  type KaluwaStudioSettingsRaw,
  type StudioFileParseResult,
} from "../../kaluwa/kaluwaStudio";
import {
  applyStudioSettings,
  applyStudioTheme,
  createAndApplyStudioTheme,
  deleteStudioTheme,
  recaptureStudioSettings,
  renameStudioTheme,
} from "../../kaluwa/kaluwaStudioActions";
import { useKaluwaStudioThemes } from "../../kaluwa/kaluwaStudioStore";
import { uploadArtId, uploadIdOfArt } from "../kaluwaBackdrop/backdropSettings";
import { addBackdropUpload, useBackdropUploads } from "../kaluwaBackdrop/backdropUploads";
import { KaluwaPresetPicker, KaluwaPresetThumbnail } from "../settings/KaluwaLookSettings";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { studioImageToFile, uploadToStudioImage } from "./studioImage";
import {
  notifyStudioSaveFailure,
  useStudioEditor,
  useStudioSidebarWriter,
} from "./useKaluwaStudio";

type Note = Readonly<{ tone: "info" | "error"; text: string; detail?: string }>;

function Subheading({ children }: { readonly children: string }) {
  return <h3 className="px-0.5 text-xs font-medium text-muted-foreground">{children}</h3>;
}

function downloadJson(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked later so the browser can start the download first.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function StudioPresetsSection() {
  const gt = useGT();
  const { look, scheme } = useKaluwaLook();
  const studioThemes = useKaluwaStudioThemes();
  const { activeId, studio, design, capture, sourceName } = useStudioEditor();
  const writeSidebar = useStudioSidebarWriter();
  const { uploads } = useBackdropUploads();
  const { copyToClipboard } = useCopyToClipboard();
  const [saveName, setSaveName] = useState("");
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [withImage, setWithImage] = useState(false);
  const [importText, setImportText] = useState("");
  const [note, setNote] = useState<Note | null>(null);

  const currentName = studio?.name ?? sourceName;
  const backdropUploadId = uploadIdOfArt(capture.backdrop.art);
  const backdropUpload = uploads.find((upload) => upload.id === backdropUploadId) ?? null;
  const settingsChanged =
    studio !== null && JSON.stringify(capture) !== JSON.stringify(studio.settings);

  const guarded = (run: () => void) => {
    try {
      run();
    } catch (error) {
      console.error("[kaluwa-studio] Could not save the theme library.", error);
      notifyStudioSaveFailure();
    }
  };

  const saveAs = () => {
    const name = saveName.trim();
    if (!name) return;
    guarded(() => {
      const theme = createAndApplyStudioTheme({ name, design, settings: capture });
      setSaveName("");
      setNote({ tone: "info", text: gt("Saved {name} to My themes.", { name: theme.name }) });
    });
  };

  const commitRename = () => {
    if (!studio || renameDraft === null) return;
    const name = renameDraft.trim();
    setRenameDraft(null);
    if (!name || name === studio.name) return;
    guarded(() => renameStudioTheme(studio.id, name));
  };

  const exportText = async (): Promise<string> => {
    const image =
      withImage && backdropUpload ? await uploadToStudioImage(backdropUpload) : undefined;
    return serializeStudioFile({ name: currentName, design, settings: capture }, image);
  };

  const parseMessage = (result: Extract<StudioFileParseResult, { ok: false }>): Note => {
    const text = {
      empty: gt("Paste a theme's JSON first."),
      json: gt("That isn't valid JSON."),
      kind: gt("That JSON isn't a Kaluwa theme."),
      version: gt("That theme was made by a newer version of Kaluwa."),
      invalid: gt("Some values in that theme are missing or out of range."),
    }[result.reason];
    return { tone: "error", text, ...(result.detail ? { detail: result.detail } : {}) };
  };

  const importTheme = async () => {
    const result = parseStudioFile(importText);
    if (!result.ok) {
      setNote(parseMessage(result));
      return;
    }
    const { file } = result;
    let settings: KaluwaStudioSettingsRaw = file.settings ?? {};
    let imageDropped = false;
    const backdrop =
      typeof settings.backdrop === "object" && settings.backdrop !== null
        ? (settings.backdrop as Record<string, unknown>)
        : null;
    const art = typeof backdrop?.art === "string" ? backdrop.art : null;
    const uploadId = art === null ? null : uploadIdOfArt(art);
    if (backdrop && uploadId !== null) {
      if (file.image) {
        try {
          const upload = await addBackdropUpload(studioImageToFile(file.image));
          settings = { ...settings, backdrop: { ...backdrop, art: uploadArtId(upload.id) } };
        } catch (error) {
          console.error("[kaluwa-studio] Could not add the theme's image.", error);
          settings = { ...settings, backdrop: { ...backdrop, art: "none" } };
          imageDropped = true;
        }
      } else if (!uploads.some((upload) => upload.id === uploadId)) {
        settings = { ...settings, backdrop: { ...backdrop, art: "none" } };
        imageDropped = true;
      }
    }
    guarded(() => {
      const theme = createAndApplyStudioTheme({ name: file.name, design: file.design, settings });
      applyStudioSettings(theme.settings, writeSidebar);
      setImportText("");
      setNote({
        tone: "info",
        text: imageDropped
          ? gt("Imported {name}. Its image was not included, so the backdrop is off.", {
              name: theme.name,
            })
          : gt("Imported {name}.", { name: theme.name }),
      });
    });
  };

  return (
    <SettingsSection id="kaluwa-studio-presets" title={gt("Presets")}>
      <div className="grid gap-4 p-4">
        <div className="grid gap-2">
          <Subheading>{gt("Built-in")}</Subheading>
          <KaluwaPresetPicker />
        </div>

        <div className="grid gap-2">
          <Subheading>{gt("My themes")}</Subheading>
          {studioThemes.length === 0 ? (
            <p className="px-0.5 text-xs text-muted-foreground">
              {gt("Nothing saved yet. Change a color below, or save the current look.")}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={gt("My themes")}
              className="@container grid grid-cols-2 gap-2"
            >
              {studioThemes.map((theme) => {
                const active = theme.id === activeId;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      setConfirmingDelete(null);
                      if (!applyStudioTheme(theme.id, writeSidebar)) notifyStudioSaveFailure();
                    }}
                    className={cn(
                      "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active ? "border-primary" : "border-border",
                    )}
                  >
                    <KaluwaPresetThumbnail
                      preset={studioPreset(theme)}
                      scheme={scheme}
                      look={look}
                    />
                    <span className="truncate px-0.5 text-xs font-medium text-foreground">
                      {theme.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {studio ? (
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <Subheading>{gt("This theme")}</Subheading>
            <Input
              nativeInput
              size="compact"
              aria-label={gt("Theme name")}
              maxLength={48}
              value={renameDraft ?? studio.name}
              onChange={(event) => setRenameDraft(event.currentTarget.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenameDraft(null);
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={!settingsChanged}
                onClick={() =>
                  guarded(() => {
                    recaptureStudioSettings(studio.id, capture);
                    setNote({
                      tone: "info",
                      text: gt("Saved the current look, backdrop, tabs and sidebar into {name}.", {
                        name: studio.name,
                      }),
                    });
                  })
                }
              >
                {gt("Update", { $context: "save current settings into this theme" })}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  guarded(() => {
                    createAndApplyStudioTheme({
                      name: gt("{name} copy", { name: studio.name }),
                      design: studio.design,
                      settings: studio.settings,
                    });
                  })
                }
              >
                {gt("Duplicate")}
              </Button>
              {confirmingDelete === studio.id ? (
                <>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() =>
                      guarded(() => {
                        setConfirmingDelete(null);
                        deleteStudioTheme(studio.id);
                        setNote({
                          tone: "info",
                          text: gt("Deleted {name}.", { name: studio.name }),
                        });
                      })
                    }
                  >
                    {gt("Delete {name}", { name: studio.name })}
                  </Button>
                  <Button size="xs" variant="ghost-muted" onClick={() => setConfirmingDelete(null)}>
                    {gt("Cancel")}
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => setConfirmingDelete(studio.id)}
                >
                  {gt("Delete")}
                </Button>
              )}
            </div>
            {settingsChanged ? (
              <p className="text-xs text-muted-foreground">
                {gt("Look, backdrop, tabs or sidebar changed since this theme was saved.")}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <Input
            nativeInput
            size="compact"
            maxLength={48}
            aria-label={gt("Name for the new theme")}
            placeholder={gt("Name this look")}
            value={saveName}
            onChange={(event) => setSaveName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveAs();
            }}
          />
          <Button size="sm" disabled={saveName.trim() === ""} onClick={saveAs}>
            <SaveIcon aria-hidden />
            {gt("Save as theme")}
          </Button>
        </div>

        <div className="grid gap-2">
          <Subheading>{gt("Share")}</Subheading>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void exportText().then((text) => {
                  copyToClipboard(text, undefined);
                  setNote({
                    tone: "info",
                    text: gt("Copied {name} as JSON.", { name: currentName }),
                  });
                });
              }}
            >
              <CopyIcon aria-hidden />
              {gt("Copy JSON")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void exportText().then((text) =>
                  downloadJson(
                    `${currentName.trim().replace(/[^\w-]+/g, "-") || "theme"}.kaluwa-theme.json`,
                    text,
                  ),
                );
              }}
            >
              <DownloadIcon aria-hidden />
              {gt("Download")}
            </Button>
            {backdropUpload ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={withImage}
                  onCheckedChange={(checked) => setWithImage(Boolean(checked))}
                />
                {gt("With image")}
              </label>
            ) : null}
          </div>
          <Textarea
            aria-label={gt("Theme JSON to import")}
            placeholder={gt("Paste a theme's JSON here, then Import.")}
            spellCheck={false}
            rows={3}
            value={importText}
            onChange={(event) => setImportText(event.currentTarget.value)}
          />
          <div className="flex items-start gap-2">
            <Button size="xs" variant="outline" onClick={() => void importTheme()}>
              <FileUpIcon aria-hidden />
              {gt("Import")}
            </Button>
          </div>
        </div>

        {note ? (
          <div
            role="status"
            className={cn(
              "grid gap-1 text-xs",
              note.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            <p>{note.text}</p>
            {note.detail ? (
              <pre className="overflow-x-auto font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
                {note.detail}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
