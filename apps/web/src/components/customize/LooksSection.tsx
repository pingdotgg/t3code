import { randomUUID } from "../../lib/utils";
import { useId, useState } from "react";
import type { SavedLook } from "@t3tools/contracts/settings";
import {
  assignLook,
  deleteLook,
  exportLook,
  importLook,
  resolveProjectLook,
} from "../../customizationLooks";
import {
  useActiveLookProjectKey,
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
} from "../../hooks/useSettings";
import { deriveLogicalProjectKey } from "../../logicalProject";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  pickCustomizeSettings,
  readThemeStorageSnapshot,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";

function resetHistory() {
  const store = useCustomizeInterfaceStore.getState();
  if (store.active) {
    store.close();
    store.open();
  }
}

export function LooksSection({ expanded = false }: { expanded?: boolean }) {
  const settings = useClientSettings();
  const projectKey = useActiveLookProjectKey();
  const active = resolveProjectLook(settings, projectKey);
  const projects = useProjects();
  const logicalProjects = new Map<string, (typeof projects)[number]>();
  for (const project of projects) {
    const key = deriveLogicalProjectKey(project);
    if (!logicalProjects.has(key)) logicalProjects.set(key, project);
  }
  const [manage, setManage] = useState(expanded);
  const [selectedId, setSelectedId] = useState(active?.id ?? "");
  const selected = settings.savedLooks.find((look) => look.id === selectedId);
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [json, setJson] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const id = useId();

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the look.");
    } finally {
      setBusy(false);
    }
  };
  const saveNew = () =>
    run(
      async () => {
        const look: SavedLook = {
          id: randomUUID(),
          name: name.trim() || "My look",
          settings: pickCustomizeSettings(getClientSettings()),
          theme: readThemeStorageSnapshot(),
        };
        await persistClientSettingsUpdate((current) => {
          const next = { ...current, savedLooks: [...current.savedLooks, look] };
          return projectKey ? assignLook(next, [projectKey], look.id) : next;
        });
        setSelectedId(look.id);
        setName(look.name);
        setManage(true);
        resetHistory();
      },
      projectKey ? "Look saved and assigned to this project." : "Look saved. Default is unchanged.",
    );
  const apply = (lookId: string | null, keys = selection) =>
    run(
      async () => {
        await persistClientSettingsUpdate((current) => assignLook(current, keys, lookId));
        resetHistory();
      },
      lookId ? "Look assigned to selected projects." : "Selected projects now use Default.",
    );
  const importJson = (source: string) =>
    run(async () => {
      const look = importLook(source, randomUUID());
      await persistClientSettingsUpdate((current) => ({
        ...current,
        savedLooks: [...current.savedLooks, look],
      }));
      setSelectedId(look.id);
      setName(look.name);
      setJson("");
    }, "Look imported. Select projects to apply it. Missing themes use the built-in theme.");

  return (
    <section aria-label="Looks" className="space-y-3 border-t border-border/70 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Looks</h3>
        <span className="text-xs text-muted-foreground">
          {active ? `${active.name} · this project` : "Default"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {active
          ? "Edits save to this look for every assigned project. Save a new look to edit this project separately."
          : "Edits change Default, used by projects without an assigned look."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveNew()}>
          Save as new look
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setManage(!manage)} aria-expanded={manage}>
          Manage looks
        </Button>
        {active && projectKey ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void apply(null, [projectKey])}
          >
            Use Default for this project
          </Button>
        ) : null}
      </div>
      {manage ? (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm" htmlFor={`${id}-look`}>
            <span>Saved look</span>
            <select
              id={`${id}-look`}
              aria-label="Saved look"
              className="w-full rounded-md border bg-background p-2"
              value={selectedId}
              onChange={(event) => {
                const look = settings.savedLooks.find((entry) => entry.id === event.target.value);
                setSelectedId(event.target.value);
                setName(look?.name ?? "");
                setDeleting(false);
              }}
            >
              <option value="">Choose a look</option>
              {settings.savedLooks.map((look) => (
                <option key={look.id} value={look.id}>
                  {look.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm" htmlFor={`${id}-name`}>
            <span>Look name</span>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My look"
            />
          </label>
          {selected ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    void run(
                      () =>
                        persistClientSettingsUpdate((current) => ({
                          ...current,
                          savedLooks: current.savedLooks.map((look) =>
                            look.id === selected.id ? { ...look, name: name.trim() } : look,
                          ),
                        })),
                      "Look renamed.",
                    )
                  }
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const copy = { ...selected, id: randomUUID(), name: `${selected.name} copy` };
                      await persistClientSettingsUpdate((current) => ({
                        ...current,
                        savedLooks: [...current.savedLooks, copy],
                      }));
                      setSelectedId(copy.id);
                      setName(copy.name);
                    }, "Look duplicated. Assign the copy to edit it separately.")
                  }
                >
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(() => {
                      const snapshot = {
                        settings: pickCustomizeSettings(getClientSettings()),
                        theme: readThemeStorageSnapshot(),
                      };
                      return persistClientSettingsUpdate((current) => ({
                        ...current,
                        savedLooks: current.savedLooks.map((look) =>
                          look.id === selected.id ? { ...look, ...snapshot } : look,
                        ),
                      }));
                    }, "Current customization saved to this look.")
                  }
                >
                  Save changes to this look
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                  Delete look
                </Button>
              </div>
              {deleting ? (
                <div
                  role="group"
                  aria-label="Confirm delete look"
                  className="space-y-2 rounded-md border p-3"
                >
                  <p className="text-sm">
                    Delete {selected.name}? Assigned projects will use Default.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await persistClientSettingsUpdate((current) =>
                          deleteLook(current, selected.id),
                        );
                        setSelectedId("");
                        setDeleting(false);
                        resetHistory();
                      }, "Look deleted. Assigned projects now use Default.")
                    }
                  >
                    Confirm delete
                  </Button>{" "}
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(exportLook(selected));
                    }, "Look JSON copied.")
                  }
                >
                  Copy look JSON
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([exportLook(selected)], { type: "application/json" }),
                    );
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = "t3-look.json";
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download look
                </Button>
              </div>
            </>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Apply to projects…</legend>
            <p className="text-xs text-muted-foreground">
              Assignments stay on this device. Checkouts of the same repository share a look across
              environments.
            </p>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {[...logicalProjects].map(([key, project]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selection.includes(key)}
                    onChange={(event) =>
                      setSelection((current) =>
                        event.target.checked
                          ? [...current, key]
                          : current.filter((entry) => entry !== key),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {resolveProjectLook(settings, key)?.name ?? "Default"}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !selected || selection.length === 0}
                onClick={() => void apply(selectedId)}
              >
                Apply to {selection.length} projects
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selection.length === 0}
                onClick={() => void apply(null)}
              >
                Use Default
              </Button>
            </div>
          </fieldset>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">Import a look</summary>
            <label className="block text-sm" htmlFor={`${id}-file`}>
              JSON file
            </label>
            <input
              id={`${id}-file`}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void file
                    .text()
                    .then(importJson)
                    .catch(() => setMessage("Could not read the file."));
                event.target.value = "";
              }}
            />
            <label className="block text-sm" htmlFor={`${id}-json`}>
              Or paste look JSON
            </label>
            <textarea
              id={`${id}-json`}
              className="w-full rounded-md border bg-background p-2 text-xs"
              rows={4}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
            <Button size="sm" disabled={busy || !json.trim()} onClick={() => void importJson(json)}>
              Import JSON
            </Button>
          </details>
        </div>
      ) : null}
      <p role="status" className="text-xs text-muted-foreground">
        {message}
      </p>
    </section>
  );
}
