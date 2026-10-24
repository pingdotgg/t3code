import { useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentFileSyncBundle, AgentFileSyncPreview, EnvironmentId } from "@t3tools/contracts";
import { ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentFileSync } from "../../state/agentFileSync";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface Location {
  id: string;
  environmentId: EnvironmentId;
  label: string;
  cwd?: string;
}
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

export function AgentFileSyncSettings() {
  const { scope } = useSettingsScope();
  return <AgentFileSyncSettingsContent key={`${scope.kind}:${scope.label}`} />;
}

function AgentFileSyncSettingsContent() {
  const { scope, environment } = useSettingsScope();
  const { environments } = useEnvironments();
  const project = scope.kind === "project" || scope.kind === "checkout" ? scope.group : null;
  const locations: Location[] = project
    ? project.memberProjects.flatMap((member) => {
        const env = environments.find(
          (candidate) => candidate.environmentId === member.environmentId,
        );
        return env
          ? [
              {
                id: member.physicalProjectKey,
                environmentId: env.environmentId,
                label: `${env.label} · ${member.workspaceRoot}`,
                cwd: member.workspaceRoot,
              },
            ]
          : [];
      })
    : environments.map((env) => ({
        id: env.environmentId,
        environmentId: env.environmentId,
        label: env.label,
      }));
  const [sourceOverride, setSource] = useState<string | null>(null);
  const source =
    locations.find((item) => item.id === sourceOverride) ??
    locations.find(
      (item) => scope.kind === "checkout" && item.id === scope.checkout.physicalProjectKey,
    ) ??
    locations.find((item) => item.environmentId === environment?.environmentId) ??
    locations[0];
  if (source && source.id !== sourceOverride) setSource(source.id);
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p>{scope.message}</p>
      </SettingsPageContainer>
    );
  const compatible = (target: Location) =>
    environments.find((env) => env.environmentId === target.environmentId)?.serverConfig
      ?.environment.capabilities.agentFileSync === true;
  const connected = (target: Location) =>
    environments.find((env) => env.environmentId === target.environmentId)?.connection.phase ===
    "connected";
  return (
    <SettingsPageContainer>
      <SettingsSection id="agent-file-sync" title="Skills & instructions" variant="plain">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Keep selected skills and instructions in sync across your machines. Choose a source and
            review the first change.
          </p>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="agent-sync-source">
              Source machine
            </label>
            <Select
              value={source?.id ?? null}
              onValueChange={(id) => {
                if (id) setSource(id);
              }}
              items={locations.map((item) => ({ value: item.id, label: item.label }))}
            >
              <SelectTrigger id="agent-sync-source" aria-label="Source machine">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {locations.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {project
                ? "Project files. Choose All projects in the scope above for personal files."
                : "Personal files in this machine’s home folder. Choose a project above for its files."}
            </p>
          </div>
          {source && compatible(source) && connected(source) ? (
            <SyncSelection
              key={`${source.id}:${source.cwd ?? "home"}`}
              source={source}
              destinations={locations.filter((item) => item.id !== source.id)}
              compatible={compatible}
              connected={connected}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {source && !connected(source)
                ? "Connect the source machine to view its files."
                : "Update the source environment to manage skills and instructions."}
            </p>
          )}
          {source && connected(source) && compatible(source) ? (
            <SyncSubscriptions location={source} />
          ) : null}
          {source
            ? locations
                .filter(
                  (target) => target.id !== source.id && connected(target) && compatible(target),
                )
                .map((target) => (
                  <SyncSubscriptions key={target.id} location={target} source={source} />
                ))
            : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function SyncSelection({
  source,
  destinations,
  compatible,
  connected,
}: {
  source: Location;
  destinations: Location[];
  compatible: (target: Location) => boolean;
  connected: (target: Location) => boolean;
}) {
  const input = source.cwd ? { cwd: source.cwd } : {};
  const catalog = useEnvironmentQuery(
    agentFileSync.list({ environmentId: source.environmentId, input }),
  );
  const selectionKey = `t3:agent-file-sync:${source.environmentId}:${source.cwd ?? "home"}`;
  const [selected, setSelected] = useState(() => new Set(readSelection(selectionKey)));
  const [targets, setTargets] = useState(() => new Set(readSelection(`${selectionKey}:targets`)));
  const [filter, setFilter] = useState("");
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
    persist(destination ? `${selectionKey}:targets` : selectionKey, [...next]);
  };
  const skills = catalog.data?.skills ?? [];
  const instructions = catalog.data?.instructions ?? [];
  const pickedSkills = skills.filter((skill) => selected.has(skill.path));
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
  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase());
  return (
    <>
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              aria-label="Find skills or instructions"
              placeholder="Find skills or instructions…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <Button variant="ghost" size="icon" aria-label="Refresh files" onClick={catalog.refresh}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        {catalog.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {catalog.error}
          </p>
        ) : null}
        {catalog.data?.warnings.map((warning) => (
          <p key={warning} className="text-xs text-muted-foreground">
            {warning}
          </p>
        ))}
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">Instructions</h3>
          <p className="text-xs text-muted-foreground">
            Choose the sections to share. Other text on each machine stays in place.
          </p>
          {instructions
            .filter(
              (file) =>
                matches(file.path) || file.sections.some((section) => matches(section.title)),
            )
            .map((file) => (
              <div key={file.path} className="rounded-md border">
                <div className="border-b px-3 py-2 font-mono text-xs text-muted-foreground">
                  {file.path}
                </div>
                {file.sections
                  .filter((section) => matches(file.path) || matches(section.title))
                  .map((section) => (
                    <div key={section.id} className="px-3 py-2 not-last:border-b">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected.has(sectionKey(file.path, section.id))}
                          onCheckedChange={(checked) =>
                            toggle(sectionKey(file.path, section.id), checked)
                          }
                        />
                        {section.title}
                      </label>
                      <details className="mt-1 ps-6 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Read section</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                          {section.contents}
                        </pre>
                      </details>
                    </div>
                  ))}
              </div>
            ))}
          {catalog.isSuccess && !instructions.length ? (
            <p className="text-xs text-muted-foreground">
              No AGENTS.md or CLAUDE.md files found here.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">Skills</h3>
          <p className="text-xs text-muted-foreground">
            Each skill includes its scripts and supporting files. A sync replaces the selected skill
            folder.
          </p>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {skills
              .filter((skill) => matches(`${skill.name} ${skill.path}`))
              .map((skill) => (
                <label
                  key={skill.path}
                  className="flex items-center gap-2 px-3 py-2 text-sm not-last:border-b"
                >
                  <Checkbox
                    checked={selected.has(skill.path)}
                    onCheckedChange={(checked) => toggle(skill.path, checked)}
                  />
                  <span className="min-w-0">
                    <span className="block">{skill.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {skill.path}
                    </span>
                  </span>
                </label>
              ))}
            {catalog.isSuccess && !skills.length ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">No skills found here.</p>
            ) : null}
          </div>
        </div>
        {catalog.isPending ? <p className="text-sm text-muted-foreground">Reading files…</p> : null}
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">Sync to</h3>
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
                {target.label}
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
            <DialogTitle>Review sync</DialogTitle>
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
                  {item.target.label}
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
    </>
  );
}

function SyncSubscriptions({ location, source }: { location: Location; source?: Location }) {
  const links = useEnvironmentQuery(
    agentFileSync.links({ environmentId: location.environmentId, input: {} }),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = useAtomValue(agentFileSync.manage.permissionAtom(location.environmentId));
  useEffect(() => {
    const timer = setInterval(links.refresh, 15_000);
    return () => clearInterval(timer);
  }, [links.refresh]);
  const subscriptions = (links.data ?? []).filter(
    (link) =>
      link.scope.cwd === location.cwd &&
      (!source ||
        (link.sourceEnvironmentId === source.environmentId && link.selection.cwd === source.cwd)),
  );
  if (!subscriptions.length) return null;
  const manage = async (id: string, action: "pause" | "resume" | "remove") => {
    setBusy(true);
    setError(null);
    try {
      const result = await runAtomCommand(
        appAtomRegistry,
        agentFileSync.manage,
        { environmentId: location.environmentId, input: { id, action } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") setError(message(result));
      links.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sync.");
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">
        {source ? `Syncing to ${location.label}` : "Syncing to this machine"}
      </h3>
      {subscriptions.map((link) => (
        <div key={link.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">From {link.label}</p>
            <span className="text-xs text-muted-foreground">
              {link.paused ? "Paused" : "Automatic"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {link.selection.skills.length} skills ·{" "}
            {link.selection.instructions.reduce((n, file) => n + file.sectionIds.length, 0)}{" "}
            sections · Updated {new Date(link.lastSyncedAt).toLocaleString()}
          </p>
          {link.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {link.error} Restore the synced content and resume, or stop sync and review a new
              selection.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !allowed}
              onClick={() => void manage(link.id, link.paused ? "resume" : "pause")}
            >
              {link.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !allowed}
              onClick={() => void manage(link.id, "remove")}
            >
              Stop sync
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Stopping sync keeps the current files on this machine.
          </p>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
