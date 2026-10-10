import {
  FileSearchIcon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  PowerOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useAtomRefresh } from "@effect/atom-react";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
import {
  type PluginInstallation,
  type PluginInstallationId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
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
  pluginRemovalStatement,
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
import { pluginEnvironment } from "../../state/plugins";
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
  const explainedAccess = useExplainedPluginAccess(access);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<{
    readonly installationId: PluginInstallationId;
    readonly added: PluginAddedMarker | null;
  } | null>(null);
  const catalogState = resolvePluginCatalogState({
    connected,
    data: catalog.data,
    error: catalog.error,
  });
  if (catalogState._tag === "unsupported") return null;
  const installations = catalogState._tag === "available" ? catalogState.view.installations : null;
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
              installations.map((installation) => (
                <PluginRow
                  key={installation.installationId}
                  environment={environment}
                  installation={installation}
                  canManage={canManage}
                  onReview={() =>
                    setReviewing({ installationId: installation.installationId, added: null })
                  }
                />
              ))
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
  canManage,
  onReview,
}: {
  readonly environment: EnvironmentPresentation;
  readonly installation: PluginInstallation;
  readonly canManage: boolean;
  readonly onReview: () => void;
}) {
  const view = presentPluginInstallation(installation);
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
              {pluginRemovalStatement(environment.label)}
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

/** Details of one installation; for one that needs consent, the consent screen. */
export function PluginReviewDialog({
  environment,
  detail,
  canManage,
  status,
  notice,
  onRetry,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly detail: PluginDetailState;
  readonly canManage: boolean;
  readonly status: string | null;
  readonly notice: string | null;
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
  const view = installation ? presentPluginInstallation(installation) : null;
  const digest = installation?.source?.digest ?? null;
  const acknowledged = digest !== null && trustedDigest === digest;

  const gate = usePluginActionGate(
    canManage && installation !== null
      ? {
          environmentId: environment.environmentId,
          installation,
          acknowledgedDigest: acknowledged ? digest : null,
        }
      : null,
  );

  const approve = async () => {
    if (!installation || digest === null || !acknowledged) return;
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
                    {manifest.capabilities.length === 0 ? (
                      "None declared"
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {manifest.capabilities.map((capability) => (
                          <Badge key={capability} variant="outline">
                            {capability}
                          </Badge>
                        ))}
                      </span>
                    )}
                    {manifest.proposedApi ? (
                      <span className="mt-1 block text-muted-foreground">
                        Uses proposed APIs that may change between T3 Code versions.
                      </span>
                    ) : null}
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
              <Button
                size="sm"
                disabled={!canManage || !acknowledged || busy}
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
