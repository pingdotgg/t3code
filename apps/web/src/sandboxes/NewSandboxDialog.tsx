import type {
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { sandboxEnvironment } from "../state/sandboxes";
import { rememberCreatedSandbox } from "./createdSandboxes";
import { ManifestFolderInput } from "./ManifestFolderInput";
import { ManifestPicker } from "./ManifestPicker";
import { runOnHost, suggestSandboxName } from "./sandboxActions";
import { SandboxHostMenu } from "./SandboxHostMenu";
import {
  readDefaultSandboxHost,
  useOffersSandboxes,
  useSandboxes,
  useSandboxHost,
} from "./useSandboxes";

// The host the dialog creates on, while it is open.
let openHost: EnvironmentId | null = null;
const listeners = new Set<() => void>();

/**
 * Opens the dialog from anywhere: the sidebar, the Sandboxes page or the command palette. Without
 * a host it uses the first that can reach agentctl.
 */
export function openNewSandboxDialog(hostEnvironmentId?: EnvironmentId) {
  openHost = hostEnvironmentId ?? readDefaultSandboxHost();
  for (const listener of listeners) listener();
}

function closeNewSandboxDialog() {
  openHost = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function NewSandboxDialogHost() {
  const host = useSyncExternalStore(subscribe, () => openHost);
  if (!useOffersSandboxes()) return null;
  return (
    <Dialog open={host !== null} onOpenChange={(next) => (next ? null : closeNewSandboxDialog())}>
      {/* Another host has its own manifests and Sandboxes, so its content starts over. */}
      {host !== null ? <NewSandboxDialogContent key={host} hostEnvironmentId={host} /> : null}
    </Dialog>
  );
}

function NewSandboxDialogContent({
  hostEnvironmentId,
}: {
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const sandboxes = useSandboxes().filter(
    (sandbox) => sandbox.hostEnvironmentId === hostEnvironmentId,
  );
  const homeDirectory = useSandboxHost(hostEnvironmentId)?.snapshot.homeDirectory ?? "";
  const [manifests, setManifests] = useState<ReadonlyArray<AgentctlSandboxManifest> | null>(null);
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (
    nextManifests: ReadonlyArray<AgentctlSandboxManifest>,
    nextSettings: AgentctlSandboxSettings,
  ) => {
    setManifests(nextManifests);
    setSettings(nextSettings);
    // The manifest of the last Sandbox comes first, so "another one" is one click.
    setManifestPath(
      (current) =>
        current ??
        nextManifests.find((candidate) => candidate.path === nextSettings.lastManifestPath)?.path ??
        nextManifests[0]?.path ??
        null,
    );
  };
  const load = () =>
    Promise.all([
      runOnHost(sandboxEnvironment.listManifests, hostEnvironmentId, {}),
      runOnHost(sandboxEnvironment.getSettings, hostEnvironmentId, {}),
    ]).then(([listed, read]) => {
      if ("error" in listed || "error" in read) {
        setError("error" in listed ? listed.error : "error" in read ? read.error : null);
        return null;
      }
      return [listed.value, read.value] as const;
    });

  const loadInitial = useEffectEvent((isCancelled: () => boolean) => {
    void load().then((loaded) => {
      if (loaded !== null && !isCancelled()) apply(...loaded);
    });
  });

  // Loads once when the dialog opens; adding a folder reloads explicitly.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- host RPC: reads manifests while open, and drops a read that ends after close
  useEffect(() => {
    let cancelled = false;
    loadInitial(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const manifest = manifests?.find((candidate) => candidate.path === manifestPath) ?? null;

  const suggestedName = manifest === null ? "" : suggestSandboxName(manifest.agentName, sandboxes);
  const effectiveName = nameEdited ? name : suggestedName;

  const addManifestRoot = async (folder: string) => {
    const added = await runOnHost(sandboxEnvironment.addManifestRoot, hostEnvironmentId, {
      folder,
    });
    if ("error" in added) {
      setError(added.error);
      return;
    }
    const loaded = await load();
    if (loaded !== null) apply(...loaded);
  };

  const create = async () => {
    if (manifest === null) return;
    setSubmitting(true);
    setError(null);
    const name = effectiveName.trim();
    const created = await runOnHost(sandboxEnvironment.create, hostEnvironmentId, {
      manifestPath: manifest.path,
      name,
    });
    setSubmitting(false);
    const failure = "error" in created ? created.error : created.value.error;
    if (failure !== null) {
      setError(failure);
      return;
    }
    // The sidebar shows its progress from here, so there is nothing to wait for.
    rememberCreatedSandbox(hostEnvironmentId, name);
    // Unless the dialog moved on to another host meanwhile, whose form this must not close.
    if (openHost === hostEnvironmentId) closeNewSandboxDialog();
  };

  const hostRow = (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground">On</span>
      <SandboxHostMenu value={hostEnvironmentId} onChange={(next) => openNewSandboxDialog(next)} />
    </div>
  );

  // Without a manifest folder there is nothing to choose from yet, so that comes first.
  if (settings !== null && settings.manifestRoots.length === 0) {
    return (
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Sandbox</DialogTitle>
          <DialogDescription>
            Choose a folder with agentctl manifests, such as a repository with an agents folder. T3
            Code finds every agent.yaml and agent.&lt;variant&gt;.yaml in it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {hostRow}
            <ManifestFolderInput
              hostEnvironmentId={hostEnvironmentId}
              label="Choose folder…"
              onAdd={addManifestRoot}
            />
            {error ? <div className="break-words text-destructive text-sm">{error}</div> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeNewSandboxDialog}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    );
  }

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>New Sandbox</DialogTitle>
        <DialogDescription>
          Applies an agentctl manifest and connects to the Sandbox when it is ready.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {hostRow}
          {manifests === null ? (
            <div className="text-muted-foreground text-sm">Looking for manifests…</div>
          ) : manifests.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No agent.yaml manifests in {settings?.manifestRoots.join(", ")}.
            </div>
          ) : (
            <ManifestPicker
              manifests={manifests}
              homeDirectory={homeDirectory}
              value={manifest}
              onValueChange={(next) => setManifestPath(next.path)}
            />
          )}
          <div>
            <ManifestFolderInput
              hostEnvironmentId={hostEnvironmentId}
              label="Add manifest folder"
              onAdd={addManifestRoot}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-sandbox-name">Name</Label>
            <Input
              id="new-sandbox-name"
              value={effectiveName}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error ? <div className="break-words text-destructive text-sm">{error}</div> : null}
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={closeNewSandboxDialog}>
          Cancel
        </Button>
        <Button
          onClick={() => void create()}
          disabled={submitting || manifest === null || effectiveName.trim() === ""}
        >
          {submitting ? "Applying…" : "Create Sandbox"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
