import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { ServerIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`shell:profile.${key}`, options);

import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
  useManagedTunnelUsage,
} from "../../cloud/managedRelayState";
import { relayFailureReason } from "../../cloud/relayFailureReason";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { T3CHAT_SUBSCRIPTION_URL, TunnelUsageMeter, tunnelUpgradeCopy } from "../cloud/TunnelUsage";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import {
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";
import { useT3ChatLink } from "./useT3ChatLink";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? td("linkDateUnavailable")
    : td("linked", { date: linkedAtFormatter.format(linkedAt) });
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? td("managedTunnel")
    : td("activityPublishingOnly");
}

function T3ConnectEnvironmentRow(props: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly confirmationOpen: boolean;
  readonly mutationPending: boolean;
  readonly onConfirmationChange: (open: boolean) => void;
  readonly onDeregister: (environment: RelayClientEnvironmentRecord) => void;
}) {
  const { environment } = props;
  const { t } = useTranslation("shell");
  return (
    <ClerkUserProfileRow icon={<ServerIcon className="size-4" />}>
      <Collapsible open={props.confirmationOpen} onOpenChange={props.onConfirmationChange}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm leading-4.5 font-medium text-foreground">
              {environment.label}
            </h3>
            <p className="mt-1 text-xs leading-4.5 text-muted-foreground">
              {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
            </p>
          </div>
          <CollapsibleTrigger
            render={
              <Button size="sm" variant="destructive-outline" disabled={props.mutationPending}>
                {t("profile.deregister")}
              </Button>
            }
          />
        </div>

        <CollapsiblePanel>
          <div className="pt-3">
            <div
              className="rounded-lg border border-input bg-muted/32 px-5 py-4 shadow-xs/5"
              role="group"
              aria-label={t("profile.confirmDeregisterAria", { label: environment.label })}
            >
              <h4 className="text-sm leading-4.5 font-semibold text-foreground">
                {t("profile.deregisterServer")}
              </h4>
              <p className="mt-1 text-xs leading-4.5 text-muted-foreground">
                {t("profile.willBeRemoved", { label: environment.label })}
              </p>
              <p className="mt-4 max-w-xl text-xs leading-4.5 text-muted-foreground">
                {t("profile.deregisterDetail")}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.mutationPending}
                  onClick={() => props.onConfirmationChange(false)}
                >
                  {t("profile.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={props.mutationPending}
                  onClick={() => props.onDeregister(environment)}
                >
                  {props.mutationPending ? t("profile.deregistering") : t("profile.deregister")}
                </Button>
              </div>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </ClerkUserProfileRow>
  );
}

function T3ConnectTunnelUsage() {
  const { t } = useTranslation("shell");
  const usage = useManagedTunnelUsage();
  const t3Chat = useT3ChatLink();
  if (usage.used === null || usage.limit === null) return null;
  return (
    <div className="border-t py-4">
      <TunnelUsageMeter used={usage.used} limit={usage.limit} />
      {usage.upgrade ? (
        <p className="mt-2 text-xs leading-4.5 text-muted-foreground">
          {usage.upgrade === "link" && t3Chat.linkUrl ? (
            <Trans
              i18nKey={"profile.confirmOnT3Chat" as never}
              components={[
                <a
                  className="underline"
                  href={t3Chat.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  key="0"
                />,
              ]}
            />
          ) : (
            <>
              {tunnelUpgradeCopy(usage.upgrade)}{" "}
              {usage.upgrade === "link" ? (
                <InlineButton disabled={t3Chat.pending !== null} onClick={() => void t3Chat.link()}>
                  {t3Chat.pending === "link" ? t("profile.opening") : t("profile.linkT3Chat")}
                </InlineButton>
              ) : (
                <a
                  className="underline"
                  href={T3CHAT_SUBSCRIPTION_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("profile.upgradeOnT3Chat")}
                </a>
              )}
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

export function T3ConnectUserProfilePage() {
  const { t } = useTranslation("shell");
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refreshAfterMutation, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [confirmingEnvironmentId, setConfirmingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const mutationPendingRef = useRef(false);
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);
    setConfirmingEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      void refreshRelayEnvironments();
      toastManager.add({
        type: "success",
        title: t("profile.serverDeregistered"),
        description: t("profile.deregisteredDetail"),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    // The relay may have removed it before failing.
    environmentsState.refresh();
    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : t("profile.couldNotDeregister");
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: t("profile.couldNotDeregisterTitle"),
        description: relayFailureReason(cause) ?? message,
        ...(traceId
          ? {
              actionProps: {
                children: t("profile.copyTraceId"),
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
              actionVariant: "outline",
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const usage = useManagedTunnelUsage();
  const refreshAll = usage.refresh;
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);

  return (
    <ClerkUserProfilePage
      title={t("profile.connectTitle")}
      description={t("profile.connectDescription")}
      action={
        <ClerkUserProfileRefreshButton
          disabled={deregisteringEnvironmentId !== null}
          isPending={environmentsState.isPending}
          onClick={refreshAll}
        />
      }
    >
      <div>
        <T3ConnectTunnelUsage />
        {environmentsState.error ? (
          <div className="mb-4 border-t border-destructive/35 py-3 text-xs" role="alert">
            <p className="font-medium text-destructive-foreground">
              {t("profile.couldNotLoadEnvironments")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{environmentsState.error}</p>
          </div>
        ) : null}

        {isInitialLoad ? (
          <p className="border-t py-4 text-xs text-muted-foreground" role="status">
            {t("profile.loadingEnvironments")}
          </p>
        ) : environments.length > 0 ? (
          <ul className="border-t">
            {environments.map((environment) => (
              <T3ConnectEnvironmentRow
                key={environment.environmentId}
                environment={environment}
                confirmationOpen={confirmingEnvironmentId === environment.environmentId}
                mutationPending={deregisteringEnvironmentId !== null}
                onConfirmationChange={(open) =>
                  setConfirmingEnvironmentId(open ? environment.environmentId : null)
                }
                onDeregister={(selected) => void handleDeregister(selected)}
              />
            ))}
          </ul>
        ) : environmentsState.error ? null : (
          <div className="border-t">
            <Empty size="compact">
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>{t("profile.noEnvironments")}</EmptyTitle>
                <EmptyDescription>{t("profile.noEnvironmentsDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </ClerkUserProfilePage>
  );
}
