import { useEffect, useRef, useState } from "react";
import { type ClientSettings, type ClientSettingsPatch } from "@t3tools/contracts/settings";
import { CheckIcon, XIcon } from "lucide-react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectSeparator,
} from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSidebar } from "../ui/sidebar";
import { ThreadRowLayoutEditor } from "./ThreadRowLayoutEditor";
import {
  changeSavedThreadLayout,
  resolveSavedThreadLayouts,
  COMPACT_THREAD_LAYOUT,
} from "./savedThreadLayouts";
import { useThreadListPreview } from "./ThreadListPreviewContext";

export function ThreadRowLayoutSettings({
  settings,
  onChange,
}: {
  settings: ClientSettings;
  onChange: (patch: ClientSettingsPatch) => void;
}) {
  const { layouts, current, preset } = resolveSavedThreadLayouts(settings);
  const [rename, setRename] = useState<string | null>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (rename === null && wasRenaming.current) pickerRef.current?.focus();
    wasRenaming.current = rename !== null;
  }, [rename]);
  const { showing, setShowing } = useThreadListPreview();
  const { isMobile, setOpenMobile, setOpen } = useSidebar();
  useEffect(() => () => setShowing(false), [setShowing]);
  const change = (action: Parameters<typeof changeSavedThreadLayout>[1]) => {
    const patch = changeSavedThreadLayout(settings, action);
    if (patch) onChange(patch);
  };
  return (
    <ThreadRowLayoutEditor
      renderHeader={(preview) => (
        <SettingsRow
          {...searchableSetting("compact-thread-list")}
          title="Thread list layout"
          resetAction={
            preset === null ? (
              <SettingResetButton
                label="thread list layout"
                onClick={() => {
                  setRename(null);
                  change({ type: "select", id: "preset:standard" });
                }}
              />
            ) : null
          }
          className="px-0 pt-0 pb-0 sm:px-0"
        >
          <div className="flex flex-wrap items-start gap-4 pt-3">
            <div className="min-w-0 max-w-full shrink-0">{preview}</div>
            <div className="ml-auto flex w-48 max-w-full shrink-0 flex-col items-end gap-2">
              {rename !== null ? (
                <form
                  className="flex w-full min-w-0 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (rename.trim()) {
                      change({ type: "rename", id: randomUUID(), name: rename });
                      setRename(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setRename(null);
                    }
                  }}
                >
                  <Input
                    autoFocus
                    aria-label="Layout name"
                    className="min-w-0 flex-1"
                    onFocus={(event) => event.currentTarget.select()}
                    maxLength={80}
                    value={rename}
                    onChange={(event) => setRename(event.target.value)}
                  />
                  <Button
                    type="submit"
                    size="icon-sm"
                    aria-label="Accept layout name"
                    disabled={!rename.trim()}
                  >
                    <CheckIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Cancel rename"
                    onClick={() => setRename(null)}
                  >
                    <XIcon />
                  </Button>
                </form>
              ) : (
                <>
                  <Select
                    value={current.id}
                    onValueChange={(id) => {
                      if (id) {
                        setRename(null);
                        if (id === "action:new-layout") {
                          change({ type: "create", id: randomUUID(), duplicate: false });
                        } else {
                          change({ type: "select", id });
                        }
                      }
                    }}
                  >
                    <SelectTrigger
                      ref={pickerRef}
                      aria-label="Saved thread layout"
                      className="w-full"
                    >
                      <SelectValue>{current.name}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {layouts.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                      <SelectSeparator />
                      <SelectItem value="action:new-layout">New layout…</SelectItem>
                    </SelectPopup>
                  </Select>
                </>
              )}
              <div className="flex items-center gap-2">
                {rename === null && preset === null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-16 px-1"
                    onClick={() => setRename(current.name)}
                  >
                    Rename
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRename(null);
                    change({ type: "create", id: randomUUID(), duplicate: true });
                  }}
                >
                  Duplicate
                </Button>
              </div>
            </div>
          </div>
        </SettingsRow>
      )}
      layoutId={current.id}
      layout={current.layout}
      showAvailableDetails={preset === null}
      showResetLayout={preset === null}
      resetLayout={preset ? current.layout : COMPACT_THREAD_LAYOUT.layout}
      onChange={(layout) => change({ type: "edit", id: randomUUID(), layout })}
      footer={
        <>
          <Button
            size="sm"
            variant={showing ? "default" : "outline"}
            onClick={() => {
              setShowing(!showing);
              if (!showing) {
                if (isMobile) setOpenMobile(true);
                else setOpen(true);
              }
            }}
          >
            {showing ? "Close thread list preview" : "Preview my threads"}
          </Button>
          {preset === null ? (
            <Button
              size="sm"
              variant="destructive"
              className="sm:ml-auto"
              onClick={() => {
                setRename(null);
                change({ type: "delete" });
              }}
            >
              Delete layout
            </Button>
          ) : null}
        </>
      }
    />
  );
}
