import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type ExtensionInstallSource,
  type InstalledExtension,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckIcon,
  FileUpIcon,
  LinkIcon,
  PackagePlusIcon,
  PuzzleIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseExtensionReference } from "../../extensionReference";
import {
  openVsxExtensionExists,
  searchOpenVsxExtensions,
  type OpenVsxExtensionSummary,
} from "../../openVsx";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { useDebouncedValue } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useExtensions } from "../extensions/useExtensions";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import { DOWNLOAD_FORMAT, OpenVsxExtensionIcon, OpenVsxResultCard } from "./OpenVsxResultCard";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };
const SEARCH_DEBOUNCE_MS = 350;
const VSIX_MIME_TYPE = "application/vsix";

type PendingInstall =
  | { type: "openVsx"; source: ExtensionInstallSource; label: string; publisher: string }
  | { type: "vsix"; file: File; label: string; publisher: null };

const HOST_DESCRIPTIONS = {
  notInstalled: "Downloads the first time an extension opens.",
  downloading: "Downloading the extension host…",
  starting: "Starting the extension host…",
  ready: "Running.",
  failed: "The extension host stopped.",
  unsupported: "Extensions are not supported on this machine.",
} as const;

function commandError(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : fallback;
}

async function uploadVsix(environmentId: EnvironmentId, file: File): Promise<string> {
  if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    throw new Error("That .vsix file is larger than 50 MB.");
  }
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: { type: "file", name: file.name, mimeType: VSIX_MIME_TYPE, sizeBytes: file.size },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      return {
        abort: () => controller.abort(),
        done: fetch(url, {
          method: "POST",
          headers: { "Content-Type": VSIX_MIME_TYPE },
          body: file,
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`Upload rejected (${response.status}).`);
        }),
      };
    },
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  throw new Error("The .vsix file could not be uploaded.");
}

export function ExtensionsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsUnavailableGroup message="Connect an environment to manage extensions.">
          {null}
        </SettingsUnavailableGroup>
      ) : (
        <ExtensionsSettingsContent environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function ExtensionsSettingsContent({ environmentId }: { environmentId: EnvironmentId }) {
  const { state, error, resolveIconUrl } = useExtensions(environmentId);
  const install = useAtomCommand(serverEnvironment.installExtension, COMMAND_OPTIONS);
  const uninstall = useAtomCommand(serverEnvironment.uninstallExtension, COMMAND_OPTIONS);
  const setEnabled = useAtomCommand(serverEnvironment.setExtensionEnabled, COMMAND_OPTIONS);
  const connect = useAtomCommand(serverEnvironment.connectExtensionHost, COMMAND_OPTIONS);
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const installed = state?.extensions ?? [];
  const unsupported = state?.host === "unsupported";

  const runInstall = async (request: PendingInstall) => {
    setInstalling(request.label);
    const toastId = toastManager.add(
      stackedThreadToast({ type: "loading", title: `Installing ${request.label}`, timeout: 0 }),
    );
    let message: string | null = null;
    let extension: InstalledExtension | null = null;
    let uploadId: string | null = null;
    try {
      let source: ExtensionInstallSource;
      if (request.type === "vsix") {
        uploadId = await uploadVsix(environmentId, request.file);
        source = { type: "vsix", uploadId };
      } else {
        source = request.source;
      }
      const result = await install({ environmentId, input: { source } });
      if (result._tag === "Success") extension = result.value;
      else message = commandError(result, "The extension could not be installed.");
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "The extension could not be installed.";
    }
    if (uploadId) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: uploadId,
      });
    }
    setInstalling(null);
    if (extension) {
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "success",
          title: `Installed ${extension.displayName}`,
          description: extension.microsoftOnly
            ? "This extension is built for Microsoft's editor and may not work."
            : "Open it from the right panel.",
          timeout: 6_000,
        }),
      );
    } else if (message) {
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: `Could not install ${request.label}`,
          description: message,
        }),
      );
    } else {
      toastManager.close(toastId);
    }
  };

  const runRowCommand = async (
    extension: InstalledExtension,
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusyIds((current) => new Set(current).add(extension.id));
    const message = commandError(await command(), "The extension could not be updated.");
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(extension.id);
      return next;
    });
    if (message) {
      toastManager.add({
        type: "error",
        title: `${title} ${extension.displayName}`,
        description: message,
      });
    }
  };

  const retryHost = async () => {
    const message = commandError(
      await connect({ environmentId, input: {} }),
      "The extension host could not start.",
    );
    if (message) {
      toastManager.add({ type: "error", title: "Extension host failed", description: message });
    }
  };

  return (
    <>
      <SettingsSection title="Extension host" icon={<PuzzleIcon className="size-3.5" />}>
        <SettingsRow
          title="VS Code extensions"
          description={
            state?.hostMessage && (state.host === "failed" || unsupported)
              ? state.hostMessage
              : HOST_DESCRIPTIONS[state?.host ?? "notInstalled"]
          }
          status={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : state?.host === "downloading" || state?.host === "starting" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="xs" /> {HOST_DESCRIPTIONS[state.host]}
              </span>
            ) : null
          }
          control={
            state?.host === "failed" ? (
              <Button size="sm" variant="outline" onClick={() => void retryHost()}>
                Retry
              </Button>
            ) : state?.host === "ready" ? (
              <Badge variant="success">Running</Badge>
            ) : null
          }
        />
      </SettingsSection>

      <SettingsSection
        id="installed-extensions"
        title="Installed"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={unsupported || installing !== null}
            onClick={() => setAddOpen(true)}
          >
            <LinkIcon /> Add from link or .vsix
          </Button>
        }
      >
        <SettingsRow title="Installed extensions" description="Extensions run on this environment.">
          <div className="pt-1 pb-2">
            {state === null ? (
              <p className="py-2 text-sm text-muted-foreground">Loading extensions…</p>
            ) : installed.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No extensions installed.</p>
            ) : (
              installed.map((extension) => (
                <div
                  key={extension.id}
                  className="flex items-center gap-3 border-t border-border/50 py-2.5"
                >
                  <OpenVsxExtensionIcon
                    key={extension.iconUrl}
                    iconUrl={resolveIconUrl(extension)}
                    fallbackIcon={PuzzleIcon}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">{extension.displayName}</p>
                      {extension.microsoftOnly ? (
                        <Badge variant="warning" size="sm">
                          Microsoft-only: may not work
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {extension.publisher} · v{extension.version}
                    </p>
                  </div>
                  {busyIds.has(extension.id) ? <Spinner size="xs" /> : null}
                  <Switch
                    aria-label={`${extension.enabled ? "Disable" : "Enable"} ${extension.displayName}`}
                    checked={extension.enabled}
                    disabled={busyIds.has(extension.id)}
                    onCheckedChange={(enabled) =>
                      void runRowCommand(
                        extension,
                        enabled ? "Could not enable" : "Could not disable",
                        () => setEnabled({ environmentId, input: { id: extension.id, enabled } }),
                      )
                    }
                  />
                  <Button
                    aria-label={`Uninstall ${extension.displayName}`}
                    size="icon-xs"
                    variant="ghost-destructive"
                    disabled={busyIds.has(extension.id)}
                    onClick={() =>
                      void runRowCommand(extension, "Could not uninstall", () =>
                        uninstall({ environmentId, input: { id: extension.id } }),
                      )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      {unsupported ? null : (
        <SettingsSection title="Open VSX" variant="plain">
          <ExtensionMarketplace
            installedIds={new Set(installed.map((extension) => extension.id.toLowerCase()))}
            installing={installing}
            onInstall={(extension) =>
              setPending({
                type: "openVsx",
                source: {
                  type: "openVsx",
                  namespace: extension.namespace,
                  name: extension.name,
                },
                label: extension.displayName,
                publisher: extension.namespace,
              })
            }
          />
        </SettingsSection>
      )}

      <AddExtensionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmit={(request) => {
          setAddOpen(false);
          setPending(request);
        }}
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.publisher
                ? `Trust publisher ${pending.publisher}?`
                : `Trust ${pending?.label ?? "this file"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Extensions run code on this machine with the same access as T3 Code. They can read and
              change files, run programs, and use the network. Only install extensions you trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const request = pending;
                setPending(null);
                if (request) void runInstall(request);
              }}
            >
              Trust and install
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ExtensionMarketplace({
  installedIds,
  installing,
  onInstall,
}: {
  installedIds: ReadonlySet<string>;
  installing: string | null;
  onInstall: (extension: OpenVsxExtensionSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxExtensionSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (!debouncedQuery) {
      setResults(null);
      setError(null);
      setIsSearching(false);
      return;
    }
    const controller = new AbortController();
    setIsSearching(true);
    setError(null);
    searchOpenVsxExtensions(debouncedQuery, { signal: controller.signal }).then(
      (next) => {
        if (controller.signal.aborted) return;
        setResults(next);
        setIsSearching(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setResults(null);
        setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
        setIsSearching(false);
      },
    );
    return () => controller.abort();
  }, [debouncedQuery]);

  return (
    <div className="space-y-3">
      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search Open VSX extensions"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search extensions..."
          type="search"
          value={query}
        />
      </InputGroup>
      {error ? (
        <div
          aria-live="polite"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          {error}
        </div>
      ) : null}
      {results ? (
        results.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">No extensions found.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((extension) => {
              const isInstalled = installedIds.has(extension.id.toLowerCase());
              const isInstalling = installing === extension.displayName;
              return (
                <OpenVsxResultCard
                  key={extension.id}
                  name={extension.displayName}
                  subtitle={`${extension.namespace} · ${DOWNLOAD_FORMAT.format(extension.downloadCount)} downloads`}
                  description={extension.description || "A VS Code extension."}
                  iconUrl={extension.iconUrl}
                  fallbackIcon={PuzzleIcon}
                  action={
                    <Button
                      aria-label={`Install ${extension.displayName}`}
                      disabled={isInstalled || installing !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => onInstall(extension)}
                    >
                      {isInstalling ? (
                        <Spinner />
                      ) : isInstalled ? (
                        <CheckIcon />
                      ) : (
                        <PackagePlusIcon />
                      )}
                      {isInstalling ? "Installing..." : isInstalled ? "Installed" : "Install"}
                    </Button>
                  }
                />
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}

function AddExtensionDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: PendingInstall) => void;
}) {
  const [reference, setReference] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const source = parseExtensionReference(reference);
  const showInvalid = reference.trim() !== "" && source === null;
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const checkVersion = useRef(0);

  useEffect(() => {
    if (!open) return;
    setReference("");
    setNotFound(false);
  }, [open]);

  const submitReference = async () => {
    if (!source) return;
    const version = ++checkVersion.current;
    setChecking(true);
    let found = false;
    try {
      found = await openVsxExtensionExists(source.namespace, source.name);
      if (version !== checkVersion.current) return;
      if (!found) setNotFound(true);
    } catch (cause) {
      if (version !== checkVersion.current) return;
      toastManager.add({
        type: "error",
        title: "Could not check Open VSX",
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
    setChecking(false);
    if (!found) return;
    onSubmit({
      type: "openVsx",
      source,
      label: `${source.namespace}.${source.name}`,
      publisher: source.namespace,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        checkVersion.current++;
        setChecking(false);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an extension</DialogTitle>
          <DialogDescription>
            Paste an Open VSX or Visual Studio Marketplace link, or an extension ID like
            publisher.name.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitReference();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="extension-reference">Link or ID</Label>
              <Input
                id="extension-reference"
                autoFocus
                placeholder="https://open-vsx.org/extension/publisher/name"
                value={reference}
                disabled={checking}
                aria-invalid={showInvalid || notFound || undefined}
                onChange={(event) => {
                  checkVersion.current++;
                  setReference(event.target.value);
                  setNotFound(false);
                }}
              />
              {showInvalid ? (
                <p className="text-destructive text-xs">That is not an extension link or ID.</p>
              ) : notFound ? (
                <p className="text-destructive text-xs">
                  This extension is not on Open VSX. Some Microsoft extensions are only on the
                  Visual Studio Marketplace, and T3 Code cannot install them.
                </p>
              ) : null}
            </div>
            <input
              ref={fileInputRef}
              accept=".vsix"
              className="sr-only"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                checkVersion.current++;
                setChecking(false);
                onSubmit({ type: "vsix", file, label: file.name, publisher: null });
              }}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <FileUpIcon /> Choose .vsix file
          </Button>
          <Button disabled={!source || checking || notFound} onClick={() => void submitReference()}>
            Add extension
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
