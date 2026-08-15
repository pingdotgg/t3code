import { useEffect, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SettingIconAction } from "./settingsLayout";

function normalizeEntry(value: string): string {
  return value.trim();
}

function PrivacyExclusionList({
  title,
  addLabel,
  placeholder,
  items,
  onChange,
  disabled,
}: {
  title: string;
  addLabel: string;
  placeholder: string;
  items: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const commit = () => {
    const next = normalizeEntry(draft);
    if (!next) {
      setAdding(false);
      setDraft("");
      return;
    }
    const lowered = next.toLowerCase();
    if (items.some((item) => item.toLowerCase() === lowered)) {
      setDraft("");
      setAdding(false);
      return;
    }
    onChange([...items, next]);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="bg-muted/40 flex min-h-48 flex-col gap-2 rounded-xl border border-border/60 p-3">
        {adding ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commit();
            }}
          >
            <Input
              autoFocus
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              onValueChange={(value) => setDraft(value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAdding(false);
                  setDraft("");
                }
              }}
            />
            <Button type="submit" size="sm" disabled={disabled || !normalizeEntry(draft)}>
              Add
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start gap-1.5"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3.5" />
            {addLabel}
          </Button>
        )}

        {items.length === 0 ? (
          <p className="text-muted-foreground px-0.5 text-xs">None excluded</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => (
              <li key={item}>
                <Badge
                  variant="outline"
                  className="h-auto max-w-full justify-between gap-2 px-2 py-1 text-left font-normal"
                >
                  <span className="min-w-0 truncate">{item}</span>
                  <SettingIconAction
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${item}`}
                    onClick={() => onChange(items.filter((entry) => entry !== item))}
                  >
                    <XIcon className="size-3" />
                  </SettingIconAction>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ComputerHistoryPrivacyDialog({
  open,
  onOpenChange,
  apps,
  websites,
  disabled,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: ReadonlyArray<string>;
  websites: ReadonlyArray<string>;
  disabled?: boolean;
  onSave: (next: { apps: string[]; websites: string[] }) => void;
}) {
  const [draftApps, setDraftApps] = useState<string[]>([...apps]);
  const [draftWebsites, setDraftWebsites] = useState<string[]>([...websites]);

  useEffect(() => {
    if (!open) return;
    setDraftApps([...apps]);
    setDraftWebsites([...websites]);
  }, [open, apps, websites]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Computer History privacy</DialogTitle>
          <DialogDescription>
            Choose apps and websites that should never be recorded. Everything else is included when
            Computer History is on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <PrivacyExclusionList
              title="Exclude these apps"
              addLabel="Add app"
              placeholder="App name or bundle id"
              items={draftApps}
              onChange={setDraftApps}
              disabled={disabled}
            />
            <PrivacyExclusionList
              title="Exclude these websites"
              addLabel="Add website"
              placeholder="Hostname or URL fragment"
              items={draftWebsites}
              onChange={setDraftWebsites}
              disabled={disabled}
            />
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Private-mode web browsing activity is never included in computer history.
          </p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSave({ apps: draftApps, websites: draftWebsites });
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
