import { useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentFileSyncBundle, AgentFileSyncPreview } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentFileSync } from "../../state/agentFileSync";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";

import {
  locationLabel,
  type AgentFileLocation as Location,
  type AgentLibraryResource,
} from "./agentFileLibrary";
interface ReviewedTarget {
  target: Location;
  changes: AgentFileSyncPreview;
  error: string | null;
  done: boolean;
}
interface Review {
  bundle: AgentFileSyncBundle;
  targets: ReviewedTarget[];
}
const permissionsAtom = environmentAtomList(
  "agent-file-sync:permissions",
  agentFileSync.apply.permissionAtom,
);
const message = (failure: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "The environment request failed.";
};
function readSelection(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}
function persist(key: string, values: readonly string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* A private browser can keep the current selection in memory. */
  }
}
const sectionKey = (path: string, id: string) => `${path}\0${id}`;

export function AgentFileSharing({
  resource,
  destinations,
  compatible,
  connected,
}: {
  resource: AgentLibraryResource;
  destinations: Location[];
  compatible: (target: Location) => boolean;
  connected: (target: Location) => boolean;
}) {
  const source = resource.location;
  const input = source.cwd ? { cwd: source.cwd } : {};
  const selectionKey = `t3:agent-file-sync:${source.environmentId}:${source.cwd ?? "home"}`;
  const [selected, setSelected] = useState(
    () => new Set(resource.sections.map((section) => sectionKey(resource.path, section.id))),
  );
  const [targets, setTargets] = useState(() => new Set(readSelection(`${selectionKey}:targets`)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const grants = useAtomValue(
    permissionsAtom(environmentIdsKey(destinations.map((target) => target.environmentId))),
  );
  const writable = (target: Location) =>
    compatible(target) && connected(target) && grants[destinations.indexOf(target)] === true;
  const selectedTargets = destinations.filter((target) => targets.has(target.id));
  const toggle = (key: string, on: boolean, destination = false) => {
    const next = new Set(destination ? targets : selected);
    if (on) next.add(key);
    else next.delete(key);
    if (destination) setTargets(next);
    else setSelected(next);
    if (destination) persist(`${selectionKey}:targets`, [...next]);
  };
  const pickedSkills = resource.kind === "skill" ? [resource] : [];
  const instructions = resource.kind === "instructions" ? [resource] : [];
  const pickedInstructions = instructions
    .map((file) => ({
      path: file.path,
      sectionIds: file.sections
        .filter((section) => selected.has(sectionKey(file.path, section.id)))
        .map((section) => section.id),
    }))
    .filter((file) => file.sectionIds.length > 0);
  const pickedCount =
    pickedSkills.length +
    pickedInstructions.reduce((count, file) => count + file.sectionIds.length, 0);
  const preview = async () => {
    if (busy || !pickedCount || !selectedTargets.length) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const exported = await executeAtomQuery(
        appAtomRegistry,
        agentFileSync.export({
          environmentId: source.environmentId,
          input: {
            ...input,
            skills: pickedSkills.map((skill) => skill.path),
            instructions: pickedInstructions,
          },
        }),
        { label: "Read selected skills and instructions", reportFailure: false, refresh: true },
      );
      if (exported._tag === "Failure") {
        setError(message(exported));
        setBusy(false);
        return;
      }
      const reviewed: ReviewedTarget[] = [];
      for (const target of selectedTargets) {
        const result = await executeAtomQuery(
          appAtomRegistry,
          agentFileSync.preview({
            environmentId: target.environmentId,
            input: { ...(target.cwd ? { cwd: target.cwd } : {}), bundle: exported.value },
          }),
          { label: "Preview sync", reportFailure: false, refresh: true },
        );
        reviewed.push({
          target,
          changes: result._tag === "Success" ? result.value : [],
          error: result._tag === "Failure" ? message(result) : null,
          done: false,
        });
      }
      setReview({ bundle: exported.value, targets: reviewed });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview sync.");
    }
    setBusy(false);
  };
  const apply = async () => {
    if (!review || busy) return;
    setBusy(true);
    setError(null);
    let count = 0;
    const results: ReviewedTarget[] = [];
    try {
      for (const item of review.targets) {
        if (item.done || !item.changes.length) {
          results.push(item);
          continue;
        }
        const result = await runAtomCommand(
          appAtomRegistry,
          agentFileSync.subscribe,
          {
            environmentId: item.target.environmentId,
            input: {
              sourceEnvironmentId: source.environmentId,
              selection: {
                ...input,
                skills: pickedSkills.map((skill) => skill.path),
                instructions: pickedInstructions,
              },
              label: source.label,
              ...(item.target.cwd ? { cwd: item.target.cwd } : {}),
              bundle: review.bundle,
              expected: item.changes.map(({ path, revision }) => ({ path, revision })),
            },
          },
          { label: "Sync skills and instructions", reportFailure: false },
        );
        if (result._tag === "Failure") results.push({ ...item, error: message(result) });
        else {
          appAtomRegistry.refresh(
            agentFileSync.links({ environmentId: item.target.environmentId, input: {} }),
          );
          count += item.changes.length;
          results.push({ ...item, done: true, error: null });
        }
      }
      const failed = results.some((item) => item.error);
      if (failed) setReview({ ...review, targets: results });
      else setReview(null);
      setStatus(
        `${count} ${count === 1 ? "item syncing" : "items syncing"}.${failed ? " Some changes failed; review the details." : ""}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable sync.");
    }
    setBusy(false);
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        {resource.kind === "instructions" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Choose sections to share. The rest of each destination’s instructions stay in place.
            </p>
            {resource.sections.map((section) => (
              <label key={section.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.has(sectionKey(resource.path, section.id))}
                  onCheckedChange={(checked) =>
                    toggle(sectionKey(resource.path, section.id), checked)
                  }
                />
                {section.title}
              </label>
            ))}
            {!resource.sections.length ? (
              <p className="text-xs text-muted-foreground">
                This file has no local sections to share. Sections received from another environment
                stay with their original source.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Share this skill together with its scripts and supporting files.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">Share with</h3>
          {destinations.map((target) => (
            <label
              key={target.id}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm has-disabled:opacity-60"
            >
              <Checkbox
                checked={targets.has(target.id)}
                disabled={!writable(target) && !targets.has(target.id)}
                onCheckedChange={(checked) => toggle(target.id, checked, true)}
              />
              <span className="min-w-0 break-words">
                {locationLabel(target)}
                {!connected(target)
                  ? " · Offline"
                  : !compatible(target)
                    ? " · Update required"
                    : !writable(target)
                      ? " · File write access required"
                      : ""}
              </span>
            </label>
          ))}
          {!destinations.length ? (
            <p className="text-xs text-muted-foreground">
              {source.cwd
                ? "Add this project to another machine to sync its files."
                : "Connect another machine to sync personal files."}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {pickedCount} selected · Automatic while a T3 client is open.
          </p>
          <Button
            disabled={
              !pickedCount ||
              !selectedTargets.length ||
              selectedTargets.some((target) => !writable(target))
            }
            onClick={() => void preview()}
          >
            Review automatic sync <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </fieldset>
      {status ? (
        <p role="status" className="text-sm">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}

      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogPopup className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review sharing</DialogTitle>
            <DialogDescription>
              Selected files update automatically while a T3 client is open and both machines are
              connected. Host-specific text stays in place. Local edits to synced sections or skills
              pause sync for review.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {review?.targets.map((item) => (
              <div key={item.target.id} className="flex min-w-0 flex-col gap-3">
                <h3 className="font-medium text-sm">
                  {locationLabel(item.target)}
                  {item.done ? " · Synced" : ""}
                </h3>
                {item.error ? (
                  <p
                    role="alert"
                    className="whitespace-pre-wrap text-sm text-destructive-foreground"
                  >
                    {item.error}
                  </p>
                ) : null}
                {item.changes.map((change) => (
                  <details key={change.path} className="rounded-md border">
                    <summary className="cursor-pointer px-3 py-2 font-mono text-xs">
                      {change.path} ·{" "}
                      {change.changed ? (change.revision ? "Update" : "Create") : "Up to date"}
                    </summary>
                    <div className="grid min-w-0 gap-3 border-t p-3 sm:grid-cols-2">
                      {[
                        { label: "Before", contents: change.before },
                        { label: "After", contents: change.after },
                      ].map((side) => (
                        <div key={side.label} className="min-w-0">
                          <p className="mb-2 text-xs font-medium">{side.label}</p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            {side.contents.slice(0, 20_000) || "No file"}
                            {side.contents.length > 20_000 ? "\n… Preview shortened" : ""}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>
              Close
            </Button>
            <Button
              disabled={
                busy || !review?.targets.some((item) => !item.done && item.changes.length > 0)
              }
              onClick={() => void apply()}
            >
              {busy ? "Enabling…" : "Enable automatic sync"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
