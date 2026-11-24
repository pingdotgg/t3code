import { useAtomValue } from "@effect/atom-react";
import {
  linkBackBlockLabel,
  linkBatchFailureLabel,
  linkWithMintedCode,
} from "@t3tools/client-runtime/link-batch";
import {
  ANOTHER_ADDRESS,
  linkRequestFailureMessage,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { type PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ArrowLeftRightIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import {
  type EnvironmentPresentation,
  useEnvironment,
  useEnvironments,
} from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import {
  peerLinkEnvironment,
  useLinkableMachines,
  useLinkBackOffers,
  useLinkThroughRoutes,
} from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePeerLinkMutation } from "~/state/use-peer-link-mutation";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useNowMinute } from "../../hooks/useNowMinute";
import { m as resolveMessage } from "../../i18n/messages";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkEnvironmentAction } from "./LinkEnvironmentAction";
import { LinkedEnvironmentEditor } from "./LinkedEnvironmentEditor";
import {
  linkedEnvironmentList,
  linkedEnvironmentStatus,
  returnLinkStatus,
} from "./LinkedEnvironmentsSettings.logic";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import { LinkSeveralEnvironmentsAction } from "./LinkSeveralEnvironments";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

// Console log labels for the atom commands.
const UNLINK_COMMAND_LABEL = "unlink environment";
const LINK_COMMAND_LABEL = "link environment";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environments,
  primaryEnvironmentId,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const gt = useGT();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const selected =
    selectedId === null
      ? (environments.find((environment) => environment.environmentId === primaryEnvironmentId) ??
        environments[0])
      : environments.find((environment) => environment.environmentId === selectedId);
  if (selectedId === null && selected) setSelectedId(selected.environmentId);
  if (!selected)
    return selectedId === null ? null : (
      <SettingsSection title={gt("Agent links")}>
        <SettingsRow
          title={gt("Source unavailable")}
          description={gt("Reconnect the selected source to manage its links.")}
          control={
            <Button size="xs" variant="outline" onClick={() => setSelectedId(null)}>
              <T>Choose another source</T>
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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const m = useMessages();
  const environmentId = source.environmentId;
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }), m);
  // Links made outside this client bump nothing the shared list reads, so showing the panel
  // asks again. Listing probes every linked environment, too costly for a timer nobody asked for.
  // A list still loading counts as read now, so the next return to the window asks again.
  useLiveRefresh(
    () => {
      if (!links.isPending) links.refresh();
    },
    {
      key: `linked-environments:${environmentId}`,
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const [search, setSearch] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showAvailable, setShowAvailable] = useState(false);
  const now = DateTime.makeUnsafe(useNowMinute());
  const machines = useLinkableMachines(environmentId, showAvailable);
  // A batch needs at least two other machines this app has saved.
  const otherMachines = useEnvironments().environments.length - 1;
  const all = links.data?.links ?? [];
  const matches = (label: string) =>
    label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const { visible, showFilters } = linkedEnvironmentList(all, search, attentionOnly, now);
  const visibleLinks = new Set(visible);
  const available = machines.filter(
    (machine) =>
      !all.some((link) => link.environmentId === machine.environmentId) && matches(machine.label),
  );
  return (
    <SettingsSection
      {...searchableSetting("linked-environments")}
      title={gt("Agent links")}
      headerAction={
        canLink ? (
          <div className="flex items-center gap-2">
            {otherMachines > 1 ? (
              <LinkSeveralEnvironmentsAction environmentId={environmentId} />
            ) : null}
            <LinkEnvironmentAction
              environmentId={environmentId}
              sourceLabel={source.label}
              onOpen={() => onSelect(environmentId)}
            />
          </div>
        ) : null
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span id="agent-link-source">
            <T>From</T>
          </span>
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
        {showFilters ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-32 flex-1">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={gt("Find a destination…")}
                aria-label={gt("Find a destination")}
                nativeInput
              />
            </div>
            <Button
              size="xs"
              variant={!attentionOnly ? "secondary" : "ghost-muted"}
              aria-pressed={!attentionOnly}
              onClick={() => setAttentionOnly(false)}
            >
              <T>All</T>
            </Button>
            <Button
              size="xs"
              variant={attentionOnly ? "secondary" : "ghost-muted"}
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly(true)}
            >
              <T>Needs attention</T>
            </Button>
          </div>
        ) : null}
      </div>
      {links.error ? (
        <SettingsRow
          title={gt("Could not refresh links")}
          description={links.error}
          control={
            <Button size="xs" variant="outline" onClick={links.refresh}>
              <T>Retry</T>
            </Button>
          }
        />
      ) : null}
      {!links.data ? (
        links.error ? null : (
          <SettingsRow title={gt("Loading links…")} role="status" />
        )
      ) : all.length === 0 ? (
        <SettingsRow
          title={gt("No destinations linked")}
          description={gt("Link a destination so agents on {source} can work there.", {
            source: source.label,
          })}
        />
      ) : (
        <>
          <div
            aria-hidden
            className="grid grid-cols-[minmax(0,1fr)_6.5rem_0.75rem] gap-3 px-3 py-2 text-3xs uppercase text-muted-foreground sm:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_0.75rem] sm:px-4"
          >
            <span>
              <T>Destination</T>
            </span>
            <span className="hidden sm:block">
              <T>Agent permissions</T>
            </span>
            <span>
              <T>Link status</T>
            </span>
            <span />
          </div>
          {visible.length === 0 ? <SettingsRow title={gt("No matching destinations")} /> : null}
          {all.map((link) => (
            <div key={link.environmentId} hidden={!visibleLinks.has(link)}>
              <LinkedEnvironmentRow
                environmentId={environmentId}
                sourceLabel={source.label}
                link={link}
                open={expandedId === link.environmentId}
                onOpenChange={(open) => {
                  onSelect(environmentId);
                  setExpandedId(open ? link.environmentId : null);
                }}
              />
            </div>
          ))}
        </>
      )}
      {canLink && !attentionOnly ? (
        <Collapsible open={showAvailable} onOpenChange={setShowAvailable}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-3 text-left text-xs text-muted-foreground sm:px-4">
            <ChevronDownIcon aria-hidden className={cn("size-3", !showAvailable && "-rotate-90")} />
            <T>Other destinations</T>
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            {available.length === 0 ? (
              <SettingsRow
                title={gt("No other known destinations")}
                description={gt("Use Link to enter another address.")}
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
  const gt = useGT();
  const m = useMessages();
  const now = DateTime.makeUnsafe(useNowMinute());
  const status = linkedEnvironmentStatus(link, now, m);
  const target = useEnvironment(link.environmentId);
  const prepared = usePreparedConnection(link.environmentId);
  const canRead = useEnvironmentScope(link.environmentId, AuthAccessReadScope);
  const canCheck =
    canRead && Option.isSome(prepared) && offersLinkedEnvironments(target?.serverConfig);
  const reverse = useEnvironmentQuery(
    open && canCheck
      ? peerLinkEnvironment.list({ environmentId: link.environmentId, input: {} })
      : null,
    m,
  );
  const [evidence, setEvidence] = useState<{
    links: ReadonlyArray<PeerLinkSummary>;
    at: number;
  } | null>(null);
  const [editorMounted, setEditorMounted] = useState(open);
  if (open && !editorMounted) setEditorMounted(true);
  if ((!canCheck || (open && reverse.error)) && evidence !== null) setEvidence(null);
  if (
    open &&
    canCheck &&
    reverse.isSuccess &&
    reverse.data &&
    reverse.dataUpdatedAt !== evidence?.at
  )
    setEvidence({ links: reverse.data.links, at: reverse.dataUpdatedAt });
  const reverseLinks =
    !canCheck || (open && reverse.error) ? null : (reverse.data?.links ?? evidence?.links ?? null);
  const direction = returnLinkStatus(environmentId, reverseLinks, now, m);
  const returnLabel =
    open && !canCheck
      ? gt("Return unavailable")
      : open && reverse.error
        ? gt("Return unavailable")
        : open && reverse.isPending && reverseLinks === null
          ? gt("Checking return…")
          : direction.label;
  const returnDetail =
    returnLabel === gt("Return unavailable")
      ? gt(
          "Connect to the destination with access to read its links to check the return direction.",
        )
      : returnLabel === gt("Checking return…")
        ? gt("Checking the destination for a return link.")
        : direction.detail;
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const [forgetting, setForgetting] = useState(false);
  const mutation = usePeerLinkMutation(environmentId);
  const forget = async () => {
    if (!mutation.start()) return;
    const perform = async () => {
      const confirmed = await (requestConfirmDialog(
        gt(
          "Forget {label}? Agents on {source} stop working there. Revoke its “T3 Code · …” client in {label}’s Sharing & access to end that session too.",
          { label: link.label, source: sourceLabel },
        ),
        { variant: "destructive" },
      ) ?? Promise.resolve(false));
      if (!confirmed) return;
      setForgetting(true);
      const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not forget the link"),
            description: String(squashAtomCommandFailure(result)),
          }),
        );
    };
    await perform().finally(() => {
      setForgetting(false);
      mutation.finish();
    });
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        disabled={forgetting}
        className="grid w-full grid-cols-[minmax(0,1fr)_6.5rem_0.75rem] items-center gap-3 px-3 py-3 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_0.75rem] sm:px-4"
      >
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full break-words text-sm font-medium">{link.label}</span>
            <Tooltip>
              <TooltipTrigger
                render={<span />}
                aria-label={returnDetail}
                className={cn(
                  "inline-flex items-center gap-1 text-3xs font-normal",
                  direction.warning
                    ? "text-warning"
                    : returnLabel === gt("Two-way")
                      ? "text-info"
                      : "text-muted-foreground",
                )}
              >
                {returnLabel === gt("Two-way") ? (
                  <ArrowLeftRightIcon aria-hidden className="size-3" />
                ) : (
                  <ArrowRightIcon aria-hidden className="size-3" />
                )}
                {returnLabel}
              </TooltipTrigger>
              <TooltipPopup>{returnDetail}</TooltipPopup>
            </Tooltip>
          </span>
          <span className="block text-xs text-muted-foreground sm:hidden">
            {m(accessConfig[link.access].label)}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:block">
          {m(accessConfig[link.access].label)}
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
      <CollapsiblePanel animate={false} keepMounted={editorMounted}>
        {editorMounted ? (
          <div className="bg-muted/15 px-3 py-3 sm:px-4">
            {status.detail ? <p className="mb-3 text-xs text-warning">{status.detail}</p> : null}
            {reverse.error ? (
              <p role="status" className="mb-3 text-xs text-muted-foreground">
                <T>Could not check the return link.</T>{" "}
                <Button size="xs" variant="link" onClick={reverse.refresh}>
                  <T>Retry</T>
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

/** What the link dialog opens with when something other than its own button opened it. */
export interface LinkEnvironmentPrefill {
  /** The machine to link to, by environment id, or `ANOTHER_ADDRESS` with `address`. */
  readonly choice: string | null;
  readonly address?: string;
  /**
   * With `address`: the machine there, and one of this app's that links to it at full access and
   * so can get the pairing code from it.
   */
  readonly through?: {
    readonly viaEnvironmentId: EnvironmentId;
    readonly environmentId: EnvironmentId;
    readonly label: string;
  };
}

/**
 * The one link flow. When this client is connected to the picked machine and may create pairing
 * links there, it mints the code itself; otherwise it asks for one.
 */
export function LinkEnvironmentDialog({
  environmentId,
  open,
  onOpenChange,
  trigger = null,
  prefill,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
  readonly prefill?: LinkEnvironmentPrefill;
}) {
  const gt = useGT();
  const m = useMessages();
  const setOpen = onOpenChange;
  // Named in the title: from the map, nothing else on screen says which machine is linking.
  const source = useEnvironment(environmentId);
  const saved = useLinkableMachines(environmentId, open);
  const routes = useLinkThroughRoutes(environmentId, open);
  // Machines this app has no entry for are still pickable when one of its environments links
  // to them at full access.
  const machines = [
    ...saved,
    ...[...routes.values()]
      .filter((route) => saved.every((machine) => machine.environmentId !== route.environmentId))
      .map((route) => ({
        environmentId: route.environmentId,
        label: route.label,
        machine: "server" as const,
        connected: false,
        connectOnly: false,
        linked: false,
        urls: route.urls,
      })),
  ];
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(prefill?.choice ?? null);
  const [address, setAddress] = useState(prefill?.address ?? "");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: LINK_COMMAND_LABEL });
  const linkOnTarget = useAtomCommand(peerLinkEnvironment.link, {
    label: "link environment back",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const pairThrough = useAtomCommand(peerLinkEnvironment.pairLink, {
    label: "pair link through a linked environment",
    // The answer is a credential; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  // Machines that would not give a code through a link, so the dialog asks for one instead.
  const [throughFailed, setThroughFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [alsoLinkBack, setAlsoLinkBack] = useState(false);
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  // Only for the machine the dialog opened for: another choice or address is another machine.
  const prefilledThrough =
    prefill?.through !== undefined &&
    selected === ANOTHER_ADDRESS &&
    address === (prefill.address ?? "")
      ? prefill.through
      : null;
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  // Minting with this client's own session there comes first: it needs no third machine.
  const throughCandidate =
    prefilledThrough ?? (targetId === null || canMint ? null : (routes.get(targetId) ?? null));
  const via = useEnvironment(throughCandidate?.viaEnvironmentId ?? null);
  // The environment holding the link refuses a level this client's session there does not hold.
  const mayPairThrough = useAtomValue(
    peerLinkEnvironment.pairLink.permissionAtom(
      throughCandidate?.viaEnvironmentId ?? null,
      throughCandidate === null
        ? undefined
        : { environmentId: throughCandidate.environmentId, access },
    ),
  );
  const through =
    throughCandidate !== null &&
    via !== null &&
    mayPairThrough &&
    !throughFailed.has(throughCandidate.environmentId)
      ? throughCandidate
      : null;
  const linkBack = useLinkBackOffers(environmentId, targetId === null ? [] : [targetId], open);
  const backOffer = linkBack.offerFor(targetId);
  const ready =
    through !== null ||
    (selected !== null &&
      (!needsAddress || address.trim().length > 0) &&
      (canMint || pairingCode.trim().length > 0));
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(prefill?.choice ?? null);
      setAddress(prefill?.address ?? "");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
      setThroughFailed(new Set());
      setAlsoLinkBack(false);
    }
  };
  // Settles to what to link with, or null after reporting why the linked machine gave no code.
  const resolveThrough = async (target: NonNullable<typeof through>) => {
    const asked = await pairThrough({
      environmentId: target.viaEnvironmentId,
      input: { environmentId: target.environmentId, access },
    });
    if (asked._tag === "Success" && asked.value.type === "credential") {
      const [url, ...alternateUrls] = asked.value.urls;
      if (url !== undefined) {
        return {
          url,
          ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
          expectedEnvironmentId: asked.value.environmentId,
          expectedLabel: asked.value.label,
          pairingCode: asked.value.credential,
        };
      }
    }
    if (asked._tag === "Failure" && isAtomCommandInterrupted(asked)) return null;
    setThroughFailed((failed) => new Set(failed).add(target.environmentId));
    failureToast(
      gt("{via} could not get a pairing code from {target}", {
        via: via?.label ?? "",
        target: target.label,
      }),
      gt("Enter its address and a pairing code from it instead."),
    );
    return null;
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast(
      gt("Could not link the environment"),
      linkRequestFailureMessage(minted.failure, resolveMessage),
    );
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const throughInput = through === null ? null : await resolveThrough(through);
    const code = through === null ? await resolvePairingCode() : null;
    const result =
      through !== null
        ? throughInput === null
          ? null
          : await link({ environmentId, input: { ...throughInput, access } })
        : code === null
          ? null
          : await link({
              environmentId,
              input: {
                url,
                ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
                // A typed address links alone: only this app's own addresses name a machine.
                ...(machine === null || needsAddress
                  ? {}
                  : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
                pairingCode: code,
                access,
              },
            });
    // The link back is its own link, made on the other machine: it never undoes this one.
    const back =
      result?._tag === "Success" &&
      alsoLinkBack &&
      backOffer.kind === "offered" &&
      linkBack.source !== null &&
      targetId !== null &&
      // A typed address can answer as another machine: the picked one links back only if it did.
      result.value.environmentId === targetId
        ? await linkWithMintedCode({
            machine: linkBack.source,
            access,
            mint: mintPairingCodeOn,
            link: async (input) => {
              const reverse = await linkOnTarget({ environmentId: targetId, input });
              return reverse._tag === "Success"
                ? Result.succeed(reverse.value)
                : Result.fail(squashAtomCommandFailure(reverse));
            },
          })
        : null;
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      const names = { source: source?.label ?? "", target: result.value.label };
      toastManager.add({
        type: "success",
        title:
          back?.kind === "linked"
            ? gt("Linked {source} and {target} both ways", names)
            : gt("Linked {label}", { label: result.value.label }),
      });
      if (back?.kind === "failed") {
        failureToast(
          gt("Could not link {target} back to {source}", names),
          back.detail ?? linkBatchFailureLabel(back.failure, m),
        );
      }
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not link the environment"), String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      {trigger}
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {source === null ? (
              <T>Link an environment</T>
            ) : through !== null ? (
              gt("Link {source} to {target}", { source: source.label, target: through.label })
            ) : machine === null ? (
              gt("Link {label} to another machine", { label: source.label })
            ) : (
              gt("Link {source} to {target}", { source: source.label, target: machine.label })
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads there. It appears under
              Authorized clients in that environment's Sharing & access, where it can be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 && (through === null || through !== prefilledThrough) ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={(next) => {
                  // The opt-in names one machine: it does not carry over to another.
                  if (next !== selected) setAlsoLinkBack(false);
                  setChoice(next);
                }}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                <T>Already linked. Linking again renews it with the access you pick.</T>
              </p>
            ) : null}
            {through !== null ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "{via} links to {target} at full access, so it gets the pairing code. No code to paste.",
                  { via: via?.label ?? "", target: through.label },
                )}
              </p>
            ) : null}
            {needsAddress && through === null ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address</T>
                </span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      This app has no address for <Var>{machine.label}</Var> that another machine
                      can reach. Enter its https or Tailscale address.
                    </T>
                  </span>
                ) : null}
              </label>
            ) : null}
            {needsAddress && through === null && address.trim() ? (
              <LinkAddressWarning address={address} />
            ) : null}
            {selected === null || canMint || through !== null ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Pairing code</T>
                </span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? gt("From Sharing & access there, or t3 pair")
                      : gt("Paste the code")
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      Create a link on <Var>{machine.label}</Var>: Settings → Sharing & access →
                      Authorized clients → Create link, then paste its code here.
                    </T>
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
            {machine === null || source === null ? null : backOffer.kind === "offered" ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-sm has-data-disabled:cursor-default">
                <Checkbox
                  checked={alsoLinkBack}
                  disabled={busy}
                  onCheckedChange={setAlsoLinkBack}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block font-medium text-foreground">
                    {gt("Also link {target} back to {source}", {
                      source: source.label,
                      target: machine.label,
                    })}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {gt("Agents on {target} can then work on {source} too.", {
                      source: source.label,
                      target: machine.label,
                    })}
                  </span>
                </span>
              </label>
            ) : backOffer.kind === "blocked" ? (
              <p className="text-xs text-muted-foreground">
                {linkBackBlockLabel(
                  backOffer.reason,
                  { source: source.label, target: machine.label },
                  m,
                )}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? gt("Linking…") : gt("Link", { $context: "verb, links an environment" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What a link's health means for the user, in a sentence. */
export function peerLinkStatusText(health: PeerLinkHealth, gt: ReturnType<typeof useGT>): string {
  return health.kind === "expired"
    ? gt("Expired. Link it again with a new pairing code.")
    : health.kind === "unreachable"
      ? (health.detail ?? gt("Not answering right now."))
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? gt(
              "{days, plural, one {Expires in {days} day. Link it again to renew.} other {Expires in {days} days. Link it again to renew.}}",
              { days: health.expiresInDays },
            )
          : gt("Reachable");
}

/** Forgets `link` from `environmentId` after the user confirms. */
export function useForgetPeerLink(environmentId: EnvironmentId, link: PeerLinkSummary) {
  const gt = useGT();
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: UNLINK_COMMAND_LABEL });
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Forget {label}? Agents here stop working there, and their session on {label} ends too if it answers.",
        { label: link.label },
      ),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.removed && result.value.endedThere !== true) {
        toastManager.add({
          type: "warning",
          title: gt("{label} did not answer", { label: link.label }),
          description: gt(
            "Revoke \"T3 Code · …\" in {label}''s Sharing & access to end the session there too.",
            { label: link.label },
          ),
        });
      }
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not forget the link"), String(squashAtomCommandFailure(result)));
    }
  };
  return { busy, forget };
}
