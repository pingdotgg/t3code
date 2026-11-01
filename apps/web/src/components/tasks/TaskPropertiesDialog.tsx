import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { patchTaskFrontmatter, readTaskFrontmatter } from "@t3tools/shared/markdownFrontmatter";

export function TaskPropertiesDialog(props: {
  readonly contents: string;
  readonly title: string;
  readonly state: string | null;
  readonly pinned: boolean;
  readonly onApply: (contents: string) => void;
  readonly onClose: () => void;
}) {
  const metadata = readTaskFrontmatter(props.contents);
  const [title, setTitle] = useState(metadata?.title ?? props.title);
  const [state, setState] = useState(metadata?.state ?? props.state ?? "");
  const [pinned, setPinned] = useState(metadata?.pinned ?? props.pinned);
  const [error, setError] = useState(false);

  const apply = () => {
    const contents = patchTaskFrontmatter(props.contents, { title, state, pinned });
    if (contents === null) {
      setError(true);
      return;
    }
    props.onApply(contents);
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <DialogHeader>
            <DialogTitle>Task properties</DialogTitle>
            <DialogDescription>
              Changes stay in your draft until you save the task file.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Title
                <Input
                  autoFocus
                  maxLength={512}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                State
                <Input
                  maxLength={512}
                  placeholder="No state"
                  value={state}
                  onChange={(event) => setState(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={pinned}
                  onCheckedChange={(checked) => setPinned(checked === true)}
                />
                Pin this task
              </label>
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  The frontmatter could not be patched safely. Edit it in the source and try again.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={title.trim() === ""}>
              Apply changes
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
