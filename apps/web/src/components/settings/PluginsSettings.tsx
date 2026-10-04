import {
  FileSearchIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PlugIcon,
  PlusIcon,
  PowerOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { RegistryContext, useAtomRefresh } from "@effect/atom-react";
import {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type PluginInstallation,
  type PluginInstallationId,
  type PluginNpmInstallationResult,
  type PluginNpmPackage,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  describePluginNpmSource,
  PLUGIN_NPM_INTEGRITY_STATEMENT,
  PLUGIN_NPM_PROVENANCE_PENDING,
  PLUGIN_NPM_SCRIPTS_STATEMENT,
  pluginNpmInstallRequest,
  pluginNpmListKey,
  pluginNpmProvenanceKnown,
  pluginNpmRowLabel,
  pluginNpmUpdateRequest,
  presentPluginNpmUpdate,
  resolvePluginNpmPackagesState,
  pluginRemoveDescription,
  resolvePluginNpmProvenance,
  supportsPluginNpm,
  type PluginNpmPackagesState,
  type PluginNpmProvenance,
  type PluginNpmStepMarker,
} from "@t3tools/client-runtime/state/pluginNpmPresentation";
import { settlePluginNpmStep } from "@t3tools/client-runtime/state/pluginNpm";
import { describePluginCapabilities } from "@t3tools/client-runtime/state/pluginContributions";
import {
  canManagePlugins,
  createPluginActionGate,
  describePluginSource,
  explainedPluginAccess,
  PLUGIN_ACCESS_CHECKING,
  PLUGIN_DIGEST_STATEMENT,
  PLUGIN_DIRECTORY_GUIDANCE,
  PLUGIN_MANAGE_ACCESS_REQUIRED,
  PLUGIN_MANAGE_ACCESS_UNREADABLE,
  pluginAccessStatus,
  pluginAddDirectory,
  pluginCommandErrorMessage,
  pluginDirectoryLocation,
  pluginManagementNotice,
  pluginTrustStatement,
  presentPluginInstallation,
  resolvePluginCatalogState,
  resolvePluginDetail,
  resolvePluginManageAccess,
  startPluginAddHandoff,
  type PluginActionSubject,
  type PluginAddedMarker,
  type PluginDetailState,
  type PluginManageAccess,
  type PluginStateTone,
} from "@t3tools/client-runtime/state/pluginPresentation";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import type { EnvironmentPresentation } from "../../state/environments";
import { pluginEnvironment, pluginNpmEnvironment } from "../../state/plugins";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { Checkbox } from "../ui/checkbox";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { PluginContributionsList } from "./PluginContributions";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const TONE_BADGE = {
  neutral: "outline",
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
} as const satisfies Record<PluginStateTone, string>;

type Settled<A> = { readonly value: A } | { readonly error: string | null };

/** A command's value, or the server's message; an interrupted command has no message. */
async function settle<A, E>(command: Promise<AtomCommandResult<A, E>>): Promise<Settled<A>> {
  const result = await command;
  if (result._tag === "Success") return { value: result.value };
  return {
    error: isAtomCommandInterrupted(result)
      ? null
      : pluginCommandErrorMessage(squashAtomCommandFailure(result)),
  };
}

/** Lets callbacks created earlier (dialogs, multi-step actions) act only on what the screen still shows. */
function usePluginActionGate(current: PluginActionSubject | null) {
  const [gate] = useState(createPluginActionGate);
  useLayoutEffect(() => {
    gate.set(current);
    return () => gate.set(null);
  });
  return gate;
}

/** Explains the last settled access through a re-check, so the check moves no explanation. */
function useExplainedPluginAccess(access: PluginManageAccess) {
  const [settled, setSettled] = useState<PluginManageAccess | null>(null);
  if (access !== "pending" && access !== settled) setSettled(access);
  return explainedPluginAccess(access, settled);
}

/**
 * The access-check status in a slot sized by an invisible copy of its text, so
 * showing or clearing it changes no width or height.
 */
function AccessStatusSlot({ status }: { readonly status: string | null }) {
  return (
    <span className="grid whitespace-nowrap">
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {PLUGIN_ACCESS_CHECKING}
      </span>
      <span role="status" className="col-start-1 row-start-1">
        {status}
      </span>
    </span>
  );
}

/** Calls `refresh` when `key` changes from one known value to another; never on a timer. */
function useRefreshOnChange(key: string | null, refresh: () => void) {
  const last = useRef(key);
  useEffect(() => {
    const previous = last.current;
    last.current = key;
    if (previous !== null && key !== null && previous !== key) refresh();
  }, [key, refresh]);
}

export function PluginsSettings() {
  const { scope, environments } = useSettingsScope();
  // An older server has no catalogue, so its section is not shown at all.
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.plugins === true,
  );
  return (
    <SettingsPageContainer>
      {scope.kind === "unavailable" ? (
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : supported.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugIcon />
            </EmptyMedia>
            <EmptyTitle>Plugins are not available</EmptyTitle>
            <EmptyDescription>
              Update T3 Code on the selected environments to manage plugins.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SettingsSection {...searchableSetting("plugins")} variant="plain">
          <div className="space-y-8">
            {supported.map((environment) => (
              <PluginEnvironmentSection key={environment.environmentId} environment={environment} />
            ))}
          </div>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function PluginEnvironmentSection({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  return (
    <PluginManageAccessScope environment={environment}>
      {(access, onRetryAccess) => (
        <PluginEnvironmentCatalog
          environment={environment}
          access={access}
          onRetryAccess={onRetryAccess}
        />
      )}
    </PluginManageAccessScope>
  );
}

type PluginManageAccessChildren = (
  access: PluginManageAccess,
  onRetryAccess: (() => void) | null,
) => ReactNode;

/**
 * Resolves whether this session may manage the environment's plugins (access:write)
 * and renders `children` with it. Plugin settings forms, which save through an
 * administrative RPC, use it to go read-only.
 */
export function PluginManageAccessScope({
  environment,
  children,
}: {
  readonly environment: EnvironmentPresentation;
  readonly children: PluginManageAccessChildren;
}) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") {
    // The desktop app owns its primary server outright; a browser checks its cookie session.
    return isElectron ? (
      children("granted", null)
    ) : (
      <PrimaryPluginManageAccess>{children}</PrimaryPluginManageAccess>
    );
  }
  return (
    <RemotePluginManageAccess environmentId={environment.environmentId}>
      {children}
    </RemotePluginManageAccess>
  );
}

function PrimaryPluginManageAccess({
  children,
}: {
  readonly children: PluginManageAccessChildren;
}) {
  const session = usePrimarySessionState();
  const access = resolvePluginManageAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return children(access, session.refresh);
}

function RemotePluginManageAccess({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentPresentation["environmentId"];
  readonly children: PluginManageAccessChildren;
}) {
  const session = useEnvironmentSessionState(environmentId);
  const refreshSession = useAtomRefresh(environmentSession.sessionStateAtom(environmentId));
  const access = resolvePluginManageAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return children(access, refreshSession);
}

export function PluginEnvironmentCatalog({
  environment,
  access,
  onRetryAccess,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: PluginManageAccess;
  readonly onRetryAccess: (() => void) | null;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const catalog = useEnvironmentQuery(
    connected
      ? pluginEnvironment.catalog({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  // An older server has no npm installs: no entry, no list call.
  const npmSupported = supportsPluginNpm(environment.serverConfig?.environment.capabilities);
  const npmAtom =
    connected && npmSupported
      ? pluginNpmEnvironment.packages({ environmentId: environment.environmentId, input: {} })
      : null;
  const npmQuery = useEnvironmentQuery(npmAtom);
  const registry = useContext(RegistryContext);
  // Called after an await, so it reads the list from the registry, not from this render.
  const settleNpmStep = (reply: PluginNpmPackage | null) =>
    npmAtom === null ? null : settlePluginNpmStep(registry, npmAtom, reply);
  const npmState = resolvePluginNpmPackagesState({
    supported: npmSupported,
    data: npmQuery.data,
    error: npmQuery.error,
  });
  const explainedAccess = useExplainedPluginAccess(access);
  const [adding, setAdding] = useState(false);
  const [installingNpm, setInstallingNpm] = useState(false);
  const [reviewing, setReviewing] = useState<{
    readonly installationId: PluginInstallationId;
    readonly added: PluginAddedMarker | null;
    readonly npmInstalled: PluginNpmStepMarker | null;
  } | null>(null);
  const catalogState = resolvePluginCatalogState({
    connected,
    data: catalog.data,
    error: catalog.error,
  });
  const installations = catalogState._tag === "available" ? catalogState.view.installations : null;
  // Provenance is a query: read it again when installations or their files change.
  useRefreshOnChange(
    npmSupported && installations !== null ? pluginNpmListKey(installations) : null,
    npmQuery.refresh,
  );
  if (catalogState._tag === "unsupported") return null;
  const canManage = canManagePlugins(access, catalogState);
  const notice = pluginManagementNotice(explainedAccess, catalogState, environment.label);
  const accessStatus = pluginAccessStatus(access, catalogState);
  return (
    <>
      <SettingsSection
        title={environment.label}
        icon={
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            className="size-3.5"
          />
        }
        headerAction={
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              <AccessStatusSlot status={accessStatus} />
            </span>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canManage}
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-3" />
              Add plugin
            </Button>
            {npmSupported ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canManage}
                onClick={() => setInstallingNpm(true)}
              >
                <PackageIcon className="size-3" />
                Install from npm
              </Button>
            ) : null}
          </span>
        }
      >
        {catalogState._tag === "disconnected" ? (
          <SettingsRow
            title="Environment disconnected"
            description={`Reconnect ${environment.label} to manage its plugins.`}
          />
        ) : catalogState._tag === "failed" ? (
          <SettingsRow
            title="Could not load plugins"
            description={catalogState.message}
            control={
              <Button size="sm" variant="outline" onClick={catalog.refresh}>
                Retry
              </Button>
            }
          />
        ) : installations === null ? (
          <SettingsRow title="Loading plugins…" role="status" />
        ) : (
          <>
            {explainedAccess === "denied" ? (
              <SettingsRow title="View only" description={PLUGIN_MANAGE_ACCESS_REQUIRED} />
            ) : explainedAccess === "unreadable" ? (
              <SettingsRow
                title="View only"
                description={PLUGIN_MANAGE_ACCESS_UNREADABLE}
                control={
                  onRetryAccess ? (
                    <Button size="sm" variant="outline" onClick={onRetryAccess}>
                      Retry
                    </Button>
                  ) : null
                }
              />
            ) : null}
            {installations.length === 0 ? (
              <SettingsRow
                title="No plugins"
                description={`Plugins are trusted local code that runs on ${environment.label}'s machine. Add one from a directory there.`}
              />
            ) : (
              installations.map((installation) => {
                const provenance = resolvePluginNpmProvenance({
                  state: npmState,
                  installationId: installation.installationId,
                  step: null,
                });
                return (
                  <PluginRow
                    key={installation.installationId}
                    environment={environment}
                    installation={installation}
                    provenance={provenance}
                    canManage={canManage}
                    onReview={() =>
                      setReviewing({
                        installationId: installation.installationId,
                        added: null,
                        npmInstalled: null,
                      })
                    }
                  />
                );
              })
            )}
          </>
        )}
      </SettingsSection>
      {adding ? (
        <AddPluginDialog
          environment={environment}
          canManage={canManage}
          status={accessStatus}
          notice={notice}
          onClose={() => setAdding(false)}
          onAdded={(installation) => {
            setAdding(false);
            setReviewing({
              installationId: installation.installationId,
              added: startPluginAddHandoff({ installation, restartCatalog: catalog.refresh }),
              npmInstalled: null,
            });
          }}
        />
      ) : null}
      {installingNpm ? (
        <InstallFromNpmDialog
          environment={environment}
          canManage={canManage}
          status={accessStatus}
          notice={notice}
          onClose={() => setInstallingNpm(false)}
          onInstalled={(result) => {
            setInstallingNpm(false);
            setReviewing({
              installationId: result.installation.installationId,
              added: startPluginAddHandoff({
                installation: result.installation,
                restartCatalog: catalog.refresh,
              }),
              npmInstalled: settleNpmStep(result.package),
            });
          }}
        />
      ) : null}
      {reviewing !== null ? (
        <PluginReviewDialog
          environment={environment}
          detail={resolvePluginDetail({
            catalog: catalogState,
            installationId: reviewing.installationId,
            added: reviewing.added,
          })}
          canManage={canManage}
          status={accessStatus}
          notice={notice}
          npm={
            npmSupported
              ? {
                  state: npmState,
                  installed: reviewing.npmInstalled,
                  refresh: npmQuery.refresh,
                  settle: settleNpmStep,
                }
              : null
          }
          onRetry={catalog.refresh}
          onClose={() => setReviewing(null)}
        />
      ) : null}
    </>
  );
}

function PluginRow({
  environment,
  installation,
  provenance,
  canManage,
  onReview,
}: {
  readonly environment: EnvironmentPresentation;
  readonly installation: PluginInstallation;
  readonly provenance: PluginNpmProvenance;
  readonly canManage: boolean;
  readonly onReview: () => void;
}) {
  const view = presentPluginInstallation(installation);
  const npmPackage = provenance._tag === "found" ? provenance.package : null;
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const enable = useAtomCommand(pluginEnvironment.enable, "plugin enable");
  const disable = useAtomCommand(pluginEnvironment.disable, "plugin disable");
  const resume = useAtomCommand(pluginEnvironment.resume, "plugin resume");
  const refresh = useAtomCommand(pluginEnvironment.refresh, "plugin refresh");
  const remove = useAtomCommand(pluginEnvironment.remove, "plugin remove");
  const target = {
    environmentId: environment.environmentId,
    input: { installationId: installation.installationId },
  };
  const gate = usePluginActionGate(
    canManage
      ? { environmentId: environment.environmentId, installation, acknowledgedDigest: null }
      : null,
  );
  const act = async (failureTitle: string, command: () => Promise<Settled<unknown>>) => {
    let started = false;
    const actionTarget = {
      environmentId: environment.environmentId,
      installationId: installation.installationId,
    };
    const outcome = await gate.run(actionTarget, [command], () => {
      started = true;
      setBusy(true);
    });
    if (started) setBusy(false);
    if (outcome._tag === "failed" && outcome.error !== null)
      toastManager.add({ type: "error", title: failureTitle, description: outcome.error });
  };
  const manageable = canManage && !busy;
  return (
    <>
      <SettingsRow
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{view.title}</span>
            {installation.manifest ? (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {installation.manifest.version}
              </span>
            ) : null}
          </span>
        }
        description={
          <span className="block space-y-0.5">
            {installation.manifest?.description ? (
              <span className="line-clamp-2 block">{installation.manifest.description}</span>
            ) : null}
            {npmPackage ? (
              <span className="block text-xs">{pluginNpmRowLabel(npmPackage)}</span>
            ) : null}
            <span className="block font-mono text-xs break-all">{installation.directory}</span>
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={TONE_BADGE[view.tone]}>{view.stateLabel}</Badge>
            {view.detail ? <span>{view.detail}</span> : null}
            {view.delivery ? (
              <>
                <Badge variant={TONE_BADGE[view.delivery.tone]}>{view.delivery.label}</Badge>
                {view.delivery.detail ? <span>{view.delivery.detail}</span> : null}
              </>
            ) : null}
          </span>
        }
        control={
          <div className="flex items-center gap-2">
            {view.canReview ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onReview}>
                Review
              </Button>
            ) : null}
            {view.status === "enabled" || view.status === "disabled" ? (
              <Switch
                checked={installation.enabled}
                disabled={!manageable}
                aria-label={`Enable ${view.title}`}
                onCheckedChange={(checked) =>
                  void act(checked ? "Could not enable plugin" : "Could not disable plugin", () =>
                    settle(checked ? enable(target) : disable(target)),
                  )
                }
              />
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Actions for ${view.title}`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={onReview}>
                  <FileSearchIcon />
                  {view.canReview ? "Review" : "Details"}
                </MenuItem>
                {view.canResume ? (
                  <MenuItem
                    disabled={!manageable}
                    onClick={() =>
                      void act("Could not resume plugin", () => settle(resume(target)))
                    }
                  >
                    <RotateCcwIcon />
                    Resume
                  </MenuItem>
                ) : null}
                {view.canDisable && view.status !== "enabled" ? (
                  <MenuItem
                    disabled={!manageable}
                    onClick={() =>
                      void act("Could not disable plugin", () => settle(disable(target)))
                    }
                  >
                    <PowerOffIcon />
                    Disable
                  </MenuItem>
                ) : null}
                <MenuItem
                  disabled={!manageable}
                  onClick={() =>
                    void act("Could not check plugin files", () => settle(refresh(target)))
                  }
                >
                  <RefreshCwIcon />
                  Check files again
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={!manageable}
                  onClick={() => setConfirmingRemove(true)}
                >
                  <Trash2Icon />
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      />
      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {view.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pluginRemoveDescription(provenance, environment.label)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!manageable}
              onClick={() => {
                setConfirmingRemove(false);
                void act("Could not remove plugin", () => settle(remove(target)));
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function AddPluginDialog({
  environment,
  canManage,
  status,
  notice,
  onClose,
  onAdded,
}: {
  readonly environment: EnvironmentPresentation;
  /** Read at submit time, so a dialog that lost authority while open sends nothing. */
  readonly canManage: boolean;
  readonly status: string | null;
  readonly notice: string | null;
  readonly onClose: () => void;
  readonly onAdded: (installation: PluginInstallation) => void;
}) {
  const inputId = useId();
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useAtomCommand(pluginEnvironment.add, "plugin add");
  const target = environment.entry.target;
  const device =
    isElectron &&
    (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
      ? "this-device"
      : "unknown";
  const submit = async () => {
    const trimmed = pluginAddDirectory({ canManage, busy, directory });
    if (trimmed === null) return;
    setBusy(true);
    setError(null);
    const outcome = await settle(
      add({ environmentId: environment.environmentId, input: { directory: trimmed } }),
    );
    setBusy(false);
    if ("value" in outcome) onAdded(outcome.value.installation);
    else setError(outcome.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add plugin</DialogTitle>
          <DialogDescription>Add a plugin directory on {environment.label}.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor={inputId}>Plugin directory</Label>
            <Input
              id={inputId}
              nativeInput
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="/path/to/plugin"
              maxLength={4096}
              value={directory}
              disabled={busy || !canManage}
              onChange={(event) => setDirectory(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {pluginDirectoryLocation(environment.label, device)}
            </p>
            <p className="text-sm text-muted-foreground">{PLUGIN_DIRECTORY_GUIDANCE}</p>
            {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
            <p className="text-sm text-muted-foreground">
              <AccessStatusSlot status={status} />
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={pluginAddDirectory({ canManage, busy, directory }) === null}
            onClick={() => void submit()}
          >
            Add and review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function InstallFromNpmDialog({
  environment,
  canManage,
  status,
  notice,
  onClose,
  onInstalled,
}: {
  readonly environment: EnvironmentPresentation;
  /** Read at submit time, so a dialog that lost authority while open sends nothing. */
  readonly canManage: boolean;
  readonly status: string | null;
  readonly notice: string | null;
  readonly onClose: () => void;
  readonly onInstalled: (result: PluginNpmInstallationResult) => void;
}) {
  const inputId = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [registry, setRegistry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = useAtomCommand(pluginNpmEnvironment.add, "plugin install from npm");
  const request = pluginNpmInstallRequest({ canManage, busy, name, version, registry });
  const submit = async () => {
    if (request._tag !== "ready") return;
    setBusy(true);
    setError(null);
    const outcome = await settle(
      install({ environmentId: environment.environmentId, input: request.input }),
    );
    setBusy(false);
    if ("value" in outcome) onInstalled(outcome.value);
    else setError(outcome.error);
  };
  const locked = busy || !canManage;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Install from npm</DialogTitle>
          <DialogDescription>
            {environment.label} downloads the package, checks it against the registry's checksum,
            and unpacks it. Review its files before approving it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${inputId}-name`}>Package</Label>
              <Input
                id={`${inputId}-name`}
                nativeInput
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder="t3-notifier or @acme/t3-notifier"
                maxLength={214}
                value={name}
                disabled={locked}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${inputId}-version`}>Version or tag</Label>
              <Input
                id={`${inputId}-version`}
                nativeInput
                spellCheck={false}
                autoComplete="off"
                placeholder="latest"
                maxLength={256}
                value={version}
                disabled={locked}
                onChange={(event) => setVersion(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${inputId}-registry`}>Registry (optional)</Label>
              <Input
                id={`${inputId}-registry`}
                nativeInput
                spellCheck={false}
                autoComplete="off"
                placeholder="https://registry.npmjs.org"
                maxLength={2048}
                value={registry}
                disabled={locked}
                onChange={(event) => setRegistry(event.target.value)}
              />
            </div>
            {/* An invalid request is shown as typed; nothing is sent until it is valid. */}
            {request._tag === "invalid" ? (
              <p className="text-sm text-destructive">{request.message}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">{PLUGIN_NPM_SCRIPTS_STATEMENT}</p>
            {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
            <p className="text-sm text-muted-foreground">
              <AccessStatusSlot status={status} />
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={request._tag !== "ready"} onClick={() => void submit()}>
            Download and review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReviewField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** One environment's npm list as a plugin's details read it. */
interface PluginNpmDetails {
  readonly state: PluginNpmPackagesState;
  /** Set when the dialog was opened by installing from npm: that install's reply. */
  readonly installed: PluginNpmStepMarker | null;
  readonly refresh: () => void;
  /** Records a settled step's reply, or null after a failure, and reads the list again. */
  readonly settle: (reply: PluginNpmPackage | null) => PluginNpmStepMarker | null;
}

/** Each declared capability with what it lets the plugin do; `added` ones are highlighted. */
function CapabilityList({
  capabilities,
  added,
}: {
  readonly capabilities: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
}) {
  if (capabilities.length === 0) return "None declared";
  return (
    <span className="block space-y-1">
      {describePluginCapabilities(capabilities).map((capability) => (
        <span key={capability.name} className="flex items-baseline gap-2">
          <span className="shrink-0">
            <Badge variant={added.includes(capability.name) ? "warning" : "outline"}>
              {capability.name}
            </Badge>
          </span>
          {capability.meaning ? (
            <span className="text-muted-foreground">{capability.meaning}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Details of one installation; for one that needs consent, the consent screen. */
export function PluginReviewDialog({
  environment,
  detail,
  canManage,
  status,
  notice,
  npm,
  onRetry,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly detail: PluginDetailState;
  readonly canManage: boolean;
  readonly status: string | null;
  readonly notice: string | null;
  /** Null for a server without npm installs. */
  readonly npm: PluginNpmDetails | null;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  const checkboxId = useId();
  const installation = detail._tag === "found" ? detail.installation : null;
  // The digest the user acknowledged; new bytes need a new acknowledgement.
  const [trustedDigest, setTrustedDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consent = useAtomCommand(pluginEnvironment.consent, "plugin consent");
  const enable = useAtomCommand(pluginEnvironment.enable, "plugin enable");
  const remove = useAtomCommand(pluginEnvironment.remove, "plugin remove");
  const view = installation ? presentPluginInstallation(installation) : null;
  const digest = installation?.source?.digest ?? null;
  const acknowledged = digest !== null && trustedDigest === digest;
  // The latest npm step's outcome, until a list read after it arrives.
  const [npmStep, setNpmStep] = useState<PluginNpmStepMarker | null>(npm?.installed ?? null);
  const provenance =
    npm !== null && installation !== null
      ? resolvePluginNpmProvenance({
          state: npm.state,
          installationId: installation.installationId,
          step: npmStep,
        })
      : ({ _tag: "none" } as const);
  const npmPackage = provenance._tag === "found" ? provenance.package : null;
  // An npm download's package, checksum, and scripts policy must be on screen before approval.
  const provenanceKnown = pluginNpmProvenanceKnown(provenance);
  const settleNpmStep = (reply: PluginNpmPackage | null) => {
    if (npm !== null) setNpmStep(npm.settle(reply));
  };

  const gate = usePluginActionGate(
    canManage && installation !== null
      ? {
          environmentId: environment.environmentId,
          installation,
          acknowledgedDigest: acknowledged ? digest : null,
          provenanceKnown,
        }
      : null,
  );

  const approve = async () => {
    if (!installation || digest === null || !acknowledged || !provenanceKnown) return;
    const target = {
      environmentId: environment.environmentId,
      input: { installationId: installation.installationId },
    };
    let started = false;
    // Bound to these exact files: new bytes or a withdrawn acknowledgement stop it before each step.
    const outcome = await gate.run(
      {
        environmentId: environment.environmentId,
        installationId: installation.installationId,
        approvedDigest: digest,
      },
      [
        () => settle(consent({ ...target, input: { ...target.input, digest } })),
        () => settle(enable(target)),
      ],
      () => {
        started = true;
        setBusy(true);
        setError(null);
      },
    );
    if (started) setBusy(false);
    if (outcome._tag === "failed") setError(outcome.error);
    else if (outcome._tag === "done") onClose();
  };

  // A download nobody approved yet: removing it deletes the server's copy.
  const discard = async () => {
    if (!installation) return;
    let started = false;
    const outcome = await gate.run(
      { environmentId: environment.environmentId, installationId: installation.installationId },
      [
        () =>
          settle(
            remove({
              environmentId: environment.environmentId,
              input: { installationId: installation.installationId },
            }),
          ),
      ],
      () => {
        started = true;
        setBusy(true);
        setError(null);
      },
    );
    if (started) setBusy(false);
    if (outcome._tag === "failed") setError(outcome.error);
    else if (outcome._tag === "done") onClose();
  };
  const canDiscard =
    view?.canReview === true && npmPackage !== null && installation?.consent === null;

  const manifest = installation?.manifest ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {view !== null
              ? view.canReview
                ? `Review ${view.title}`
                : view.title
              : detail._tag === "missing"
                ? "Plugin removed"
                : "Plugin"}
          </DialogTitle>
          <DialogDescription>
            {installation !== null && view !== null
              ? !view.canReview
                ? `${view.stateLabel} on ${environment.label}.`
                : installation.consent === null
                  ? `Approve these exact files to run this plugin on ${environment.label}.`
                  : "Its files changed since you approved it. Approve the new files to run it again."
              : detail._tag === "missing"
                ? `This plugin is no longer installed on ${environment.label}.`
                : detail._tag === "failed"
                  ? `Could not load the current plugins from ${environment.label}: ${detail.message}`
                  : detail._tag === "loading"
                    ? "Loading plugin…"
                    : notice}
          </DialogDescription>
        </DialogHeader>
        {installation !== null && view !== null ? (
          <DialogPanel>
            <div className="space-y-4">
              <dl className="space-y-2">
                {manifest ? (
                  <>
                    <ReviewField label="Plugin ID">
                      <span className="font-mono text-xs">{manifest.id}</span>
                    </ReviewField>
                    <ReviewField label="Version">{manifest.version}</ReviewField>
                  </>
                ) : null}
                {npmPackage ? (
                  <>
                    <ReviewField label="Package">{describePluginNpmSource(npmPackage)}</ReviewField>
                    <ReviewField label="Integrity">
                      <span className="font-mono text-xs break-all">
                        {npmPackage.source.integrity}
                      </span>
                      <span className="mt-1 block text-muted-foreground">
                        {PLUGIN_NPM_INTEGRITY_STATEMENT}
                      </span>
                    </ReviewField>
                  </>
                ) : provenance._tag === "checking" ? (
                  <ReviewField label="Package">Checking what is installed…</ReviewField>
                ) : provenance._tag === "unknown" ? (
                  <ReviewField label="Package">
                    {npm?.state._tag === "failed"
                      ? "Not known: where it came from did not load"
                      : "Checking where it came from…"}
                  </ReviewField>
                ) : null}
                <ReviewField label="Directory">
                  <span className="font-mono text-xs break-all">{installation.directory}</span>
                </ReviewField>
                <ReviewField label="Files">
                  {installation.source ? describePluginSource(installation.source) : "Unreadable"}
                </ReviewField>
                {digest !== null ? (
                  <ReviewField label="Digest">
                    <span className="font-mono text-xs break-all">{digest}</span>
                  </ReviewField>
                ) : null}
                {manifest ? (
                  <ReviewField label="Capabilities">
                    <CapabilityList capabilities={manifest.capabilities} added={[]} />
                    {manifest.proposedApi ? (
                      <span className="mt-1 block text-muted-foreground">
                        Uses proposed APIs that may change between T3 Code versions.
                      </span>
                    ) : null}
                  </ReviewField>
                ) : null}
                {manifest ? (
                  <ReviewField label="Contributes">
                    <PluginContributionsList
                      environment={environment}
                      manifest={manifest}
                      installation={installation}
                    />
                  </ReviewField>
                ) : null}
                {view.delivery ? (
                  <ReviewField label="Event delivery">
                    <Badge variant={TONE_BADGE[view.delivery.tone]}>{view.delivery.label}</Badge>
                    {view.delivery.detail ? (
                      <span className="mt-1 block text-muted-foreground">
                        {view.delivery.detail}
                      </span>
                    ) : null}
                  </ReviewField>
                ) : null}
                {installation.consent ? (
                  <ReviewField label="Approved">
                    {formatRelativeTimeLabel(installation.consent.grantedAt)}
                    {installation.consent.digest === digest ? "" : " (different files)"}
                  </ReviewField>
                ) : null}
              </dl>
              {installation.problem ? (
                <Alert variant="error">
                  <AlertTitle>Unavailable</AlertTitle>
                  <AlertDescription>{installation.problem}</AlertDescription>
                </Alert>
              ) : null}
              {view.canReview ? (
                <>
                  <Alert variant="warning">
                    <AlertTitle>Trusted local code</AlertTitle>
                    <AlertDescription>
                      <p>{pluginTrustStatement(environment.label)}</p>
                      <p>{PLUGIN_DIGEST_STATEMENT}</p>
                      {npmPackage ? <p>{PLUGIN_NPM_SCRIPTS_STATEMENT}</p> : null}
                      {provenanceKnown ? null : <p>{PLUGIN_NPM_PROVENANCE_PENDING}</p>}
                    </AlertDescription>
                  </Alert>
                  {/* Always laid out, so an access check while reviewing moves nothing. */}
                  <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      id={checkboxId}
                      className="mt-0.5"
                      checked={acknowledged}
                      disabled={busy || digest === null || !canManage}
                      onCheckedChange={(checked) => setTrustedDigest(checked ? digest : null)}
                    />
                    I trust this code to run as my user on {environment.label}
                  </label>
                  {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
                  <p className="text-sm text-muted-foreground">
                    <AccessStatusSlot status={status} />
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {pluginTrustStatement(environment.label)}
                </p>
              )}
              {npm?.state._tag === "failed" ? (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    Could not load where this plugin came from: {npm.state.message}
                  </span>
                  <Button size="sm" variant="outline" onClick={npm.refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {!view.canReview &&
              (provenance._tag === "found" || provenance._tag === "checking") ? (
                <PluginNpmUpdateSection
                  environment={environment}
                  installation={installation}
                  pkg={npmPackage}
                  canManage={canManage}
                  onSettled={settleNpmStep}
                />
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {detail._tag === "failed" ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          {view?.canReview ? (
            <>
              <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
                Cancel
              </DialogClose>
              {canDiscard ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canManage || busy}
                  onClick={() => void discard()}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={!canManage || !acknowledged || !provenanceKnown || busy}
                onClick={() => void approve()}
              >
                Approve and enable
              </Button>
            </>
          ) : (
            <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              Close
            </DialogClose>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Updating an npm installation: download a version next to the installed one,
 * review it, then apply it, which approves its files. `pkg` is null while the
 * screen checks what is installed after a step whose outcome it does not know.
 */
function PluginNpmUpdateSection({
  environment,
  installation,
  pkg,
  canManage,
  onSettled,
}: {
  readonly environment: EnvironmentPresentation;
  readonly installation: PluginInstallation;
  readonly pkg: PluginNpmPackage | null;
  readonly canManage: boolean;
  /** Called after every step that ran, with its reply or null when it failed. */
  readonly onSettled: (reply: PluginNpmPackage | null) => void;
}) {
  const inputId = useId();
  const checkboxId = useId();
  const [version, setVersion] = useState("");
  // The downloaded update's digest the user acknowledged; another download needs a new one.
  const [trustedDigest, setTrustedDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const stageUpdate = useAtomCommand(pluginNpmEnvironment.stageUpdate, "plugin update download");
  const applyUpdate = useAtomCommand(pluginNpmEnvironment.applyUpdate, "plugin update");
  const discardUpdate = useAtomCommand(pluginNpmEnvironment.discardUpdate, "plugin update discard");
  const environmentId = environment.environmentId;
  const installationId = installation.installationId;
  const update = pkg ? presentPluginNpmUpdate(installation, pkg) : null;
  const stagedDigest = update?.update.source.digest ?? null;
  const acknowledged = stagedDigest !== null && trustedDigest === stagedDigest;
  const gate = usePluginActionGate(
    canManage && pkg !== null
      ? {
          environmentId,
          installation,
          acknowledgedDigest: null,
          stagedUpdateDigest: stagedDigest,
          acknowledgedUpdateDigest: acknowledged ? stagedDigest : null,
        }
      : null,
  );
  const request = pluginNpmUpdateRequest({ canManage, busy, version });

  const run = async (
    step: () => Promise<Settled<{ readonly package: PluginNpmPackage }>>,
    approvedUpdateDigest?: string,
  ) => {
    let started = false;
    const reply: { current: PluginNpmPackage | null } = { current: null };
    const outcome = await gate.run(
      {
        environmentId,
        installationId,
        ...(approvedUpdateDigest === undefined ? {} : { approvedUpdateDigest }),
      },
      [
        async () => {
          const settled = await step();
          if ("value" in settled) reply.current = settled.value.package;
          return settled;
        },
      ],
      () => {
        started = true;
        setBusy(true);
        setError(null);
        setApplied(null);
      },
    );
    if (!started) return false;
    setBusy(false);
    onSettled(reply.current);
    if (outcome._tag === "failed") setError(outcome.error);
    return outcome._tag === "done";
  };

  const download = async () => {
    if (request._tag !== "ready") return;
    if (
      await run(() =>
        settle(stageUpdate({ environmentId, input: { installationId, version: request.input } })),
      )
    )
      setVersion("");
  };
  const discard = () =>
    void run(() => settle(discardUpdate({ environmentId, input: { installationId } })));
  const apply = async () => {
    if (update === null || stagedDigest === null || !acknowledged) return;
    // Bound to the files the user reviewed: another download stops it before it is sent.
    if (
      await run(
        () =>
          settle(applyUpdate({ environmentId, input: { installationId, digest: stagedDigest } })),
        stagedDigest,
      )
    )
      setApplied(update.update.version);
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Updates</h3>
      {pkg === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Checking what is installed…
        </p>
      ) : update === null ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void download();
          }}
        >
          <Label htmlFor={inputId}>Version or tag</Label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              nativeInput
              spellCheck={false}
              autoComplete="off"
              placeholder="latest"
              maxLength={256}
              value={version}
              disabled={busy || !canManage}
              onChange={(event) => setVersion(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={request._tag !== "ready"}>
              Download update
            </Button>
          </div>
          {request._tag === "invalid" ? (
            <p className="text-sm text-destructive">{request.message}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Downloads that version next to the installed one and checks it. The installed version
            keeps running until you apply the update.
          </p>
        </form>
      ) : (
        <>
          <dl className="space-y-2">
            <ReviewField label="New version">
              {update.update.version}
              {update.sameAsInstalled ? " (the files already installed)" : ""}
            </ReviewField>
            <ReviewField label="Integrity">
              <span className="font-mono text-xs break-all">{update.update.integrity}</span>
            </ReviewField>
            <ReviewField label="Files">{describePluginSource(update.update.source)}</ReviewField>
            <ReviewField label="Digest">
              <span className="font-mono text-xs break-all">{update.update.source.digest}</span>
            </ReviewField>
            <ReviewField label="Capabilities">
              <CapabilityList
                capabilities={update.update.manifest.capabilities}
                added={update.addedCapabilities}
              />
              {update.addedCapabilities.length > 0 ? (
                <span className="mt-1 block text-muted-foreground">
                  New: {update.addedCapabilities.join(", ")}
                </span>
              ) : null}
              {update.removedCapabilities.length > 0 ? (
                <span className="mt-1 block text-muted-foreground">
                  No longer declared: {update.removedCapabilities.join(", ")}
                </span>
              ) : null}
            </ReviewField>
            <ReviewField label="Contributes">
              <PluginContributionsList
                environment={environment}
                manifest={update.update.manifest}
                installation={null}
              />
            </ReviewField>
            <ReviewField label="Downloaded">
              {formatRelativeTimeLabel(update.update.stagedAt)}
            </ReviewField>
          </dl>
          {update.disclosure.map((statement) => (
            <p key={statement} className="text-sm text-muted-foreground">
              {statement}
            </p>
          ))}
          <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={checkboxId}
              className="mt-0.5"
              checked={acknowledged}
              disabled={busy || !canManage}
              onCheckedChange={(checked) => setTrustedDigest(checked ? stagedDigest : null)}
            />
            I trust version {update.update.version} to run as my user on {environment.label}
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy || !canManage} onClick={discard}>
              Discard update
            </Button>
            <Button
              size="sm"
              disabled={busy || !canManage || !acknowledged}
              onClick={() => void apply()}
            >
              Apply update
            </Button>
          </div>
        </>
      )}
      {applied ? (
        <p role="status" className="text-sm text-muted-foreground">
          Updated to {applied}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
