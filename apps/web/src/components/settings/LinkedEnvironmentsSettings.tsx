import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessReadScope, type EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ArrowLeftRightIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { type EnvironmentPresentation, useEnvironment } from "~/state/environments";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNowMinute } from "../../hooks/useNowMinute";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinkEnvironmentAction } from "./LinkEnvironmentAction";
import { LinkedEnvironmentEditor } from "./LinkedEnvironmentEditor";
import { linkedEnvironmentStatus, returnLinkStatus } from "./LinkedEnvironmentsSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LinkedEnvironmentsSettings({
  environments,
  primaryEnvironmentId,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const selected =
    selectedId === null
      ? (environments.find((environment) => environment.environmentId === primaryEnvironmentId) ??
        environments[0])
      : environments.find((environment) => environment.environmentId === selectedId);
  if (!selected)
    return selectedId === null ? null : (
      <SettingsSection title="Agent links">
        <SettingsRow
          title="Source unavailable"
          description="Reconnect the selected source to manage its links."
          control={
            <Button size="xs" variant="outline" onClick={() => setSelectedId(null)}>
              Choose another source
            </Button>
          }
        />
      </SettingsSection>
    );
  return (
    <SourceLinks
      key={selected.environmentId}
      source={selected}
      environments={environments}
      onSelect={setSelectedId}
    />
  );
}

function SourceLinks({
  source,
  environments,
  onSelect,
}: {
  readonly source: EnvironmentPresentation;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onSelect: (id: EnvironmentId) => void;
}) {
  const environmentId = source.environmentId;
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }));
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const [search, setSearch] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showAvailable, setShowAvailable] = useState(false);
  const now = DateTime.makeUnsafe(useNowMinute());
  const machines = useLinkableMachines(environmentId, showAvailable);
  const all = links.data?.links ?? [];
  const matches = (label: string) =>
    label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visible = all.filter(
    (link) =>
      matches(link.label) && (!attentionOnly || linkedEnvironmentStatus(link, now).attention),
  );
  const available = machines.filter(
    (machine) =>
      !all.some((link) => link.environmentId === machine.environmentId) && matches(machine.label),
  );
  return (
    <SettingsSection
      {...searchableSetting("linked-environments")}
      title="Agent links"
      headerAction={
        canLink ? (
          <LinkEnvironmentAction
            environmentId={environmentId}
            sourceLabel={source.label}
            onOpen={() => onSelect(environmentId)}
          />
        ) : null
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span id="agent-link-source">From</span>
          {environments.length > 1 ? (
            <div className="min-w-0 flex-1">
              <Select
                value={environmentId}
                onValueChange={(id) => {
                  if (id !== null) onSelect(id);
                }}
              >
                <SelectTrigger size="sm" aria-labelledby="agent-link-source">
                  <SelectValue>{source.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <span className="text-foreground">{source.label}</span>
          )}
        </div>
        {all.length > 2 ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-32 flex-1">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a destination…"
                aria-label="Find a destination"
                nativeInput
              />
            </div>
            <Button
              size="xs"
              variant={!attentionOnly ? "secondary" : "ghost-muted"}
              aria-pressed={!attentionOnly}
              onClick={() => setAttentionOnly(false)}
            >
              All
            </Button>
            <Button
              size="xs"
              variant={attentionOnly ? "secondary" : "ghost-muted"}
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly(true)}
            >
              Needs attention
            </Button>
          </div>
        ) : null}
      </div>
      {links.error ? (
        <SettingsRow
          title="Could not refresh links"
          description={links.error}
          control={
            <Button size="xs" variant="outline" onClick={links.refresh}>
              Retry
            </Button>
          }
        />
      ) : null}
      {!links.data ? (
        <SettingsRow title={links.error ? "Links unavailable" : "Loading links…"} role="status" />
      ) : all.length === 0 ? (
        <SettingsRow
          title="No destinations linked"
          description={`Link a destination so agents on ${source.label} can work there.`}
        />
      ) : (
        <>
          <div
            aria-hidden
            className="grid grid-cols-[minmax(0,1fr)_6.5rem_0.75rem] gap-3 px-3 py-2 text-3xs uppercase text-muted-foreground sm:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_0.75rem] sm:px-4"
          >
            <span>Destination</span>
            <span className="hidden sm:block">Agent permissions</span>
            <span>Link status</span>
            <span />
          </div>
          {visible.length === 0 ? (
            <SettingsRow title="No matching destinations" />
          ) : (
            visible.map((link) => (
              <LinkedEnvironmentRow
                key={link.environmentId}
                environmentId={environmentId}
                sourceLabel={source.label}
                link={link}
                open={expandedId === link.environmentId}
                onOpenChange={(open) => {
                  onSelect(environmentId);
                  setExpandedId(open ? link.environmentId : null);
                }}
              />
            ))
          )}
        </>
      )}
      {canLink && !attentionOnly ? (
        <Collapsible open={showAvailable} onOpenChange={setShowAvailable}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-3 text-left text-xs text-muted-foreground sm:px-4">
            <ChevronDownIcon aria-hidden className={cn("size-3", !showAvailable && "-rotate-90")} />
            Other destinations
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            {available.length === 0 ? (
              <SettingsRow
                title="No other known destinations"
                description="Use Link to enter another address."
              />
            ) : (
              available.map((machine) => (
                <div
                  key={machine.environmentId}
                  className="flex items-center justify-between gap-3 border-t border-border/50 px-3 py-3 sm:px-4"
                >
                  <span className="min-w-0 break-words text-sm">{machine.label}</span>
                  <LinkEnvironmentAction
                    environmentId={environmentId}
                    targetId={machine.environmentId}
                    sourceLabel={source.label}
                    onOpen={() => onSelect(environmentId)}
                  />
                </div>
              ))
            )}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  sourceLabel,
  link,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly link: PeerLinkSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const now = DateTime.makeUnsafe(useNowMinute());
  const status = linkedEnvironmentStatus(link, now);
  const target = useEnvironment(link.environmentId);
  const prepared = usePreparedConnection(link.environmentId);
  const canRead = useEnvironmentScope(link.environmentId, AuthAccessReadScope);
  const canCheck =
    canRead && Option.isSome(prepared) && offersLinkedEnvironments(target?.serverConfig);
  const reverse = useEnvironmentQuery(
    open && canCheck
      ? peerLinkEnvironment.list({ environmentId: link.environmentId, input: {} })
      : null,
  );
  const [evidence, setEvidence] = useState<{
    links: ReadonlyArray<PeerLinkSummary>;
    at: number;
  } | null>(null);
  if ((!canCheck || (open && reverse.error)) && evidence !== null) setEvidence(null);
  if (
    open &&
    canCheck &&
    reverse.isSuccess &&
    reverse.data &&
    reverse.dataUpdatedAt !== evidence?.at
  )
    setEvidence({ links: reverse.data.links, at: reverse.dataUpdatedAt });
  const direction = returnLinkStatus(
    environmentId,
    open
      ? reverse.isSuccess && !reverse.isPending && !reverse.error
        ? (reverse.data?.links ?? null)
        : null
      : (evidence?.links ?? null),
    now,
  );
  const returnLabel =
    open && !canCheck
      ? "Return unavailable"
      : open && reverse.error
        ? "Return unavailable"
        : open && reverse.isPending
          ? "Checking return…"
          : direction.label;
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const [forgetting, setForgetting] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents on ${sourceLabel} stop working there. Revoke its “T3 Code · …” client in ${link.label}’s Sharing & access to end that session too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setForgetting(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setForgetting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not forget the link",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        disabled={forgetting}
        className="grid w-full grid-cols-[minmax(0,1fr)_6.5rem_0.75rem] items-center gap-3 px-3 py-3 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_0.75rem] sm:px-4"
      >
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words text-sm font-medium">{link.label}</span>
            <Tooltip>
              <TooltipTrigger
                render={<span />}
                aria-label={direction.detail}
                className={cn(
                  "inline-flex items-center gap-1 text-3xs font-normal",
                  direction.warning
                    ? "text-warning"
                    : returnLabel === "Two-way"
                      ? "text-info"
                      : "text-muted-foreground",
                )}
              >
                {returnLabel === "Two-way" ? (
                  <ArrowLeftRightIcon aria-hidden className="size-3" />
                ) : (
                  <ArrowRightIcon aria-hidden className="size-3" />
                )}
                {returnLabel}
              </TooltipTrigger>
              <TooltipPopup>
                {returnLabel === "Return unavailable"
                  ? "Connect to the destination with access to read its links to check the return direction."
                  : direction.detail}
              </TooltipPopup>
            </Tooltip>
          </span>
          <span className="block text-xs text-muted-foreground sm:hidden">
            {accessConfig[link.access].label}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:block">
          {accessConfig[link.access].label}
        </span>
        <span
          className="inline-flex items-center gap-1.5 text-xs"
          aria-label={status.detail ?? status.label}
        >
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
          {status.label}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 text-muted-foreground", !open && "-rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? (
          <div className="bg-muted/15 px-3 py-3 sm:px-4">
            {status.detail ? <p className="mb-3 text-xs text-warning">{status.detail}</p> : null}
            {reverse.error ? (
              <p role="status" className="mb-3 text-xs text-muted-foreground">
                Could not check the return link.{" "}
                <Button size="xs" variant="link" onClick={reverse.refresh}>
                  Retry
                </Button>
              </p>
            ) : null}
            <LinkedEnvironmentEditor
              environmentId={environmentId}
              link={link}
              onForget={() => void forget()}
              canForget={canUnlink}
              disabled={forgetting}
            />
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
