import type {
  EnvironmentId,
  MemoryVaultAccess,
  MemoryVaultDetailLevel,
  MemoryVaultRetrieval,
  MemoryVaultSearchHit,
  MemoryVaultSettingsPatch,
  MemoryVaultSummary,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { memoryVaultEnvironment } from "../../state/memoryVaults";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { NameVaultDialog } from "./NameVaultDialog";

const ACCESS_LABELS: Record<MemoryVaultAccess, string> = {
  "read-write": "Read and update",
  "read-only": "Read only",
  reference: "Reference only",
};
const DETAIL_LABELS: Record<MemoryVaultDetailLevel, string> = {
  concise: "Concise",
  standard: "Standard",
  detailed: "Detailed",
};
const RETRIEVAL_LABELS: Record<MemoryVaultRetrieval, string> = {
  relevant: "Relevant sections",
  full: "Whole vault",
};
const NONE = "__none__";

function errorText(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message
    ? error.message
    : "The memory vault request failed.";
}

function ChoiceSelect<T extends string>({
  value,
  labels,
  onChange,
  label,
}: {
  readonly value: T;
  readonly labels: Readonly<Record<T, string>>;
  readonly onChange: (value: T) => void;
  readonly label: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-label={label} className="w-full sm:w-52">
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {(Object.keys(labels) as Array<T>).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function MemoryVaultsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <Alert>
          <AlertDescription>
            Memory vaults are stored on the computer that runs Continuum. Open this page from the
            desktop app.
          </AlertDescription>
        </Alert>
      </SettingsPageContainer>
    );
  }
  return <MemoryVaultsContent environmentId={environmentId} />;
}

function MemoryVaultsContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const query = useEnvironmentQuery(memoryVaultEnvironment.overview({ environmentId, input: {} }));
  const updateSettings = useAtomCommand(memoryVaultEnvironment.updateSettings, {
    reportFailure: false,
  });
  const manage = useAtomCommand(memoryVaultEnvironment.manage, { reportFailure: false });
  const readFile = useAtomCommand(memoryVaultEnvironment.readFile, { reportFailure: false });
  const writeFile = useAtomCommand(memoryVaultEnvironment.writeFile, { reportFailure: false });
  const search = useAtomCommand(memoryVaultEnvironment.search, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [naming, setNaming] = useState<
    | { readonly kind: "create" }
    | { readonly kind: "rename"; readonly vault: MemoryVaultSummary }
    | { readonly kind: "import"; readonly directory: string }
    | null
  >(null);
  const [openVaultId, setOpenVaultId] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string; saved: string } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [hits, setHits] = useState<ReadonlyArray<MemoryVaultSearchHit> | null>(null);
  const overview = query.data;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

  const patch = async (input: MemoryVaultSettingsPatch) => {
    const result = await updateSettings({ environmentId, input });
    if (result._tag !== "Success") setError(errorText(result));
    query.refresh();
  };

  const run = async (input: Parameters<typeof manage>[0]["input"], done?: string) => {
    const result = await manage({ environmentId, input });
    if (result._tag !== "Success") {
      setError(errorText(result));
    } else {
      setError(null);
      if (done) setNotice(done.replace("{path}", result.value.path ?? ""));
    }
    query.refresh();
    return result._tag === "Success" ? result.value : null;
  };

  const open = async (vaultId: string, path: string) => {
    const result = await readFile({ environmentId, input: { vaultId, path } });
    if (result._tag === "Success") {
      setOpenVaultId(vaultId);
      setOpenFile({ path, content: result.value.content, saved: result.value.content });
    } else {
      setError(errorText(result));
    }
  };

  const save = async () => {
    if (openVaultId === null || openFile === null) return;
    const result = await writeFile({
      environmentId,
      input: { vaultId: openVaultId, path: openFile.path, content: openFile.content },
    });
    if (result._tag === "Success") setOpenFile({ ...openFile, saved: openFile.content });
    else setError(errorText(result));
    query.refresh();
  };

  const onSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (searchText.trim() === "") return setHits(null);
    const result = await search({ environmentId, input: { query: searchText } });
    if (result._tag === "Success") setHits(result.value.hits);
    else setError(errorText(result));
  };

  const pickFolder = async () => (bridge?.pickFolder ? bridge.pickFolder() : null);

  if (overview === null) {
    return (
      <SettingsPageContainer>
        <p className="px-4 text-sm text-muted-foreground">
          {query.error ?? "Loading memory vaults…"}
        </p>
      </SettingsPageContainer>
    );
  }
  const { settings } = overview;
  const vaultName = (id: string | null) =>
    overview.vaults.find((vault) => vault.id === id)?.name ?? "None";

  return (
    <SettingsPageContainer>
      {naming ? (
        <NameVaultDialog
          title={
            naming.kind === "rename"
              ? "Rename memory vault"
              : naming.kind === "import"
                ? "Import memory vault"
                : "New memory vault"
          }
          description="The name is shown in the vault picker below the composer."
          initialName={naming.kind === "rename" ? naming.vault.name : ""}
          onDone={(name) => {
            const current = naming;
            setNaming(null);
            if (!name) return;
            if (current.kind === "create") void run({ action: "create", name });
            else if (current.kind === "rename")
              void run({ action: "rename", vaultId: current.vault.id, name });
            else
              void run(
                { action: "import", directory: current.directory, name },
                "Imported into {path}.",
              );
          }}
        />
      ) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection id="memory-vaults" title="Memory vaults">
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-enabled")}
          description="Folders of Markdown notes agents read and keep current, shared across projects. A thread's vault never changes its workspace."
          control={
            <Switch
              aria-label="Use memory vaults"
              checked={settings.enabled}
              onCheckedChange={(enabled) => void patch({ enabled })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-auto-create")}
          description="Give a thread without a vault one named after its project on its first message."
          control={
            <Switch
              aria-label="Create vaults automatically"
              checked={settings.autoCreate}
              onCheckedChange={(autoCreate) => void patch({ autoCreate })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-auto-update")}
          description="Ask agents with update access to record decisions, finished work, and fixes as they go."
          control={
            <Switch
              aria-label="Update vaults automatically"
              checked={settings.autoUpdate}
              onCheckedChange={(autoUpdate) => void patch({ autoUpdate })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-default")}
          description="Used by threads that have not picked a vault."
          control={
            <ChoiceSelect
              label="Default vault"
              value={settings.defaultVaultId ?? NONE}
              labels={Object.fromEntries([
                [NONE, "None"],
                ...overview.vaults.map((vault) => [vault.id, vault.name]),
              ])}
              onChange={(value) => void patch({ defaultVaultId: value === NONE ? null : value })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-access")}
          description="What threads may do with their vault unless they choose otherwise."
          control={
            <ChoiceSelect
              label="Default access"
              value={settings.defaultAccess}
              labels={ACCESS_LABELS}
              onChange={(defaultAccess) => void patch({ defaultAccess })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-detail")}
          description="How much agents write when they update a vault."
          control={
            <ChoiceSelect
              label="Memory detail"
              value={settings.detailLevel}
              labels={DETAIL_LABELS}
              onChange={(detailLevel) => void patch({ detailLevel })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-retrieval")}
          description={`What each message carries from the vault, up to ${settings.contextBudgetChars.toLocaleString()} characters. Ask an agent to "read the whole memory vault" to include more.`}
          control={
            <ChoiceSelect
              label="Context retrieval"
              value={settings.retrieval}
              labels={RETRIEVAL_LABELS}
              onChange={(retrieval) => void patch({ retrieval })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("setting-memory-vaults-location")}
          description={overview.storageRoot}
          control={
            <div className="flex gap-2">
              {bridge?.pickFolder ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const folder = await pickFolder();
                    if (folder) void patch({ storageRoot: folder });
                  }}
                >
                  Change…
                </Button>
              ) : null}
              {settings.storageRoot !== "" ? (
                <Button size="sm" variant="ghost" onClick={() => void patch({ storageRoot: "" })}>
                  Use default
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="memory-vaults-list"
        title="Vaults"
        headerAction={
          <div className="flex gap-1">
            {bridge?.pickFolder ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const directory = await pickFolder();
                  if (directory) setNaming({ kind: "import", directory });
                }}
              >
                Import…
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setNaming({ kind: "create" })}>
              <PlusIcon />
              New vault
            </Button>
          </div>
        }
      >
        <form className="flex gap-2 px-4 py-2" onSubmit={(event) => void onSearch(event)}>
          <Input
            aria-label="Search all vaults"
            onChange={(event) => setSearchText(event.currentTarget.value)}
            placeholder="Search all vaults"
            value={searchText}
          />
          <Button size="sm" type="submit" variant="outline">
            <SearchIcon />
            Search
          </Button>
        </form>
        {hits !== null ? (
          <div className="space-y-1 px-4 pb-2">
            {hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches.</p>
            ) : (
              hits.map((hit) => (
                <button
                  className="block w-full rounded-md p-2 text-left text-sm hover:bg-accent"
                  key={`${hit.vaultId}/${hit.path}/${hit.heading}`}
                  onClick={() => void open(hit.vaultId, hit.path)}
                  type="button"
                >
                  <span className="font-medium">{vaultName(hit.vaultId)}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {hit.path} › {hit.heading}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                    {hit.excerpt}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {overview.vaults.length === 0 ? (
          <SettingsRow
            title="No vaults yet"
            description="Create one here or from the vault picker below the composer."
          />
        ) : null}
        {overview.vaults.map((vault) => (
          <SettingsRow
            key={vault.id}
            title={
              <span className="flex items-center gap-2">
                {vault.name}
                {settings.defaultVaultId === vault.id ? (
                  <Badge variant="info">Default</Badge>
                ) : null}
              </span>
            }
            description={
              <span className="flex flex-wrap gap-x-2">
                {vault.files.map((file) => (
                  <button
                    className="underline decoration-current/30 underline-offset-2 hover:text-foreground"
                    key={file.path}
                    onClick={() => void open(vault.id, file.path)}
                    type="button"
                  >
                    {file.path}
                  </button>
                ))}
              </span>
            }
            control={
              <div className="flex gap-1">
                <Button
                  aria-label={`Rename ${vault.name}`}
                  size="xs"
                  variant="ghost"
                  onClick={() => setNaming({ kind: "rename", vault })}
                >
                  <PencilIcon />
                </Button>
                {bridge?.pickFolder ? (
                  <Button
                    aria-label={`Export ${vault.name}`}
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      const directory = await pickFolder();
                      if (directory)
                        void run(
                          { action: "export", vaultId: vault.id, directory },
                          "Exported to {path}.",
                        );
                    }}
                  >
                    <FolderOpenIcon />
                  </Button>
                ) : null}
                <Button
                  aria-label={`Delete ${vault.name}`}
                  size="xs"
                  variant={confirmDelete === vault.id ? "destructive" : "ghost"}
                  onClick={() => {
                    if (confirmDelete !== vault.id) return setConfirmDelete(vault.id);
                    setConfirmDelete(null);
                    if (openVaultId === vault.id) setOpenFile(null);
                    void run({ action: "delete", vaultId: vault.id });
                  }}
                >
                  <Trash2Icon />
                  {confirmDelete === vault.id ? "Delete" : null}
                </Button>
              </div>
            }
          />
        ))}
      </SettingsSection>

      {openFile && openVaultId ? (
        <SettingsSection
          id="memory-vault-editor"
          title={`${vaultName(openVaultId)} › ${openFile.path}`}
          headerAction={
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setOpenFile(null)}>
                Close
              </Button>
              <Button
                disabled={openFile.content === openFile.saved}
                size="xs"
                onClick={() => void save()}
              >
                <SaveIcon />
                Save
              </Button>
            </div>
          }
        >
          <div className="p-3">
            <Textarea
              aria-label={`Edit ${openFile.path}`}
              className="min-h-80"
              onChange={(event) => setOpenFile({ ...openFile, content: event.currentTarget.value })}
              value={openFile.content}
            />
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
