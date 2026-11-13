import { useAtomValue } from "@effect/atom-react";
import { threadTagKey, type EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { checkTagRename } from "./ThreadTagsSettings.logic";

type Pending = { readonly kind: "rename" | "delete"; readonly tag: string; readonly count: number };

const COLLAPSED_TAG_COUNT = 5;

const threadLabel = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

/** Rename and delete reach every thread on the environment, archived ones included. */
export function ThreadTagsSection() {
  const { environment } = useSettingsScope();
  const configs = useServerConfigs();
  const environmentId = environment?.environmentId ?? null;
  if (
    environmentId === null ||
    configs.get(environmentId)?.environment.capabilities.threadTags !== true
  ) {
    return null;
  }
  return <ThreadTagsList key={environmentId} environmentId={environmentId} />;
}

function ThreadTagsList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadTagUsage({ environmentId, input: {} }),
  );
  const renameTag = useAtomCommand(orchestrationEnvironment.renameThreadTag, {
    reportFailure: false,
  });
  const deleteTag = useAtomCommand(orchestrationEnvironment.deleteThreadTag, {
    reportFailure: false,
  });
  const canRename = useAtomValue(
    orchestrationEnvironment.renameThreadTag.permissionAtom(environmentId),
  );
  const canDelete = useAtomValue(
    orchestrationEnvironment.deleteThreadTag.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const hiddenTags = useAtomValue(serverEnvironment.hiddenThreadTagsAtom(environmentId));
  const hiddenKeys = new Set((hiddenTags ?? []).map(threadTagKey));
  const tags = (query.data ?? []).filter((entry) => !hiddenKeys.has(threadTagKey(entry.tag)));
  const hiddenCount = Math.max(0, tags.length - COLLAPSED_TAG_COUNT);
  const shownTags = showAll ? tags : tags.slice(0, COLLAPSED_TAG_COUNT);
  // Hidden tags still count: renaming onto one merges, and the dialog should say so.
  const names = (query.data ?? []).map((entry) => entry.tag);
  const rename = pending?.kind === "rename" ? checkTagRename(pending.tag, draft, names) : null;

  const submit = async () => {
    if (pending === null || busy) return;
    if (pending.kind === "rename" && rename?.kind !== "ok") return;
    setBusy(true);
    const result =
      pending.kind === "rename" && rename?.kind === "ok"
        ? await renameTag({ environmentId, input: { tag: pending.tag, to: rename.to } })
        : await deleteTag({ environmentId, input: { tag: pending.tag } });
    setBusy(false);
    setPending(null);
    query.refresh();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: pending.kind === "rename" ? "Could not rename tag" : "Could not delete tag",
        description: formatEnvironmentQueryError(result.cause),
      });
    }
  };

  return (
    <SettingsSection {...searchableSetting("thread-tags")}>
      {query.error !== null && query.data === null ? (
        <SettingsRow
          title="Could not load tags"
          description={query.error}
          control={
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      ) : query.data === null ? (
        <SettingsRow title="Loading tags…" />
      ) : tags.length === 0 ? (
        <SettingsRow title="No tags yet." />
      ) : (
        shownTags.map((entry) => (
          <SettingsRow
            key={entry.tag}
            title={entry.tag}
            description={threadLabel(entry.threadCount)}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canRename}
                  onClick={() => {
                    setDraft(entry.tag);
                    setPending({ kind: "rename", tag: entry.tag, count: entry.threadCount });
                  }}
                >
                  Rename
                </Button>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!canDelete}
                  onClick={() =>
                    setPending({ kind: "delete", tag: entry.tag, count: entry.threadCount })
                  }
                >
                  Delete
                </Button>
              </div>
            }
          />
        ))
      )}
      {hiddenCount > 0 ? (
        <div className="flex px-3 py-2 sm:px-4">
          <Button variant="ghost-muted" size="xs" onClick={() => setShowAll((open) => !open)}>
            {showAll ? "Show less" : `Show ${hiddenCount} more`}
            <ChevronDownIcon
              aria-hidden
              className={cn("transition-transform", showAll && "rotate-180")}
            />
          </Button>
        </div>
      ) : null}

      <Dialog open={pending?.kind === "rename"} onOpenChange={(open) => !open && setPending(null)}>
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename “{pending?.tag}”</DialogTitle>
              <DialogDescription>
                Changes {threadLabel(pending?.count ?? 0)}, archived ones included.
                {rename?.kind === "ok" && rename.merges
                  ? ` “${rename.to}” already exists, so the two tags merge.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input
                aria-label="New tag name"
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
              />
              {rename?.kind === "error" ? (
                <p className="mt-2 text-sm text-destructive-foreground">{rename.message}</p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || rename?.kind !== "ok"}>
                {rename?.kind === "ok" && rename.merges ? "Merge" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pending?.tag}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove “{pending?.tag}” from {threadLabel(pending?.count ?? 0)}, archived ones
              included? This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void submit()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
