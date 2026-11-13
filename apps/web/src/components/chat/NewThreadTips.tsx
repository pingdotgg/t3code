import type { EnvironmentId, TipId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { use, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { deriveProjectIdentity } from "~/projectIdentity";
import {
  readProjects,
  readThreadShells,
  useAllEnvironmentShellsBootstrapped,
  useServerConfigs,
} from "~/state/entities";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { useEnvironmentSessionsSettled } from "~/state/session";
import { compactSidebarTimeLabel, formatRelativeTimeLabel } from "~/timestampFormat";
import { TIP_BY_ID, TIPS, type Tip, type TipAction } from "~/tips/catalog";
import { sidebarPreviewFolders, type SidebarPreviewFolder } from "~/tips/sidebarPreview";
import { deckStartIndex } from "~/tips/tipsState";
import { canStoreTips, markTipDone, readTipsState } from "~/tips/tipsStorage";
import { markTipOpened, markTipShown, runTipsVisit, setTipDismissed } from "~/tips/tipsStore";
import { settingsSearchHash } from "../settings/settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BackgroundThreadContext } from "./backgroundThread";

/**
 * The tips section under the new-thread composer. Its tips are picked once per visit, so it
 * never changes while the user types, and arrows browse it only while focus is inside it.
 */
export function NewThreadTips({
  environmentId,
  projectId,
  readyDrivers,
  composerDriver,
  onTryPrompt,
  onEmpty,
}: {
  environmentId: EnvironmentId;
  projectId: string | null;
  /** Comma-separated drivers ready for the draft's project, or undefined while they load. */
  readyDrivers: string | undefined;
  composerDriver: string | null;
  onTryPrompt: (prompt: string) => void;
  /** Called when the last tip left while focus was inside, so focus has somewhere to go. */
  onEmpty: () => void;
}) {
  const enabled = useClientSettings((settings) => settings.newThreadTipsEnabled);
  const settingsReady = useClientSettingsHydrated();
  const shellsReady = useAllEnvironmentShellsBootstrapped();
  // Configs and permissions decide which tips can work, and voice may run on any connected
  // machine; picking before they load would spend the day's tip on a later one. The draft's own
  // machine always counts, even before it shows as connected.
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const pickMachines = [
    environmentId,
    ...connectedEnvironmentIds.filter((id) => id !== environmentId),
  ];
  const configs = useServerConfigs();
  const configReady = pickMachines.every((id) => configs.has(id));
  const sessionReady = useEnvironmentSessionsSettled(pickMachines);
  // Out of flow under the composer: a short or narrow window has no room for the section.
  const roomy = useMediaQuery("(height > 40rem) and (min-width: 40rem)");
  // Under Settings the section is covered; unmounting it there also picks up any change made in
  // Settings when the user comes back.
  const background = use(BackgroundThreadContext);
  if (background || !enabled || !roomy) return null;
  // A draft can move to another project or environment; its tips depend on both.
  return (
    <TipsSection
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId}
      ready={settingsReady && shellsReady && configReady && sessionReady}
      readyDrivers={readyDrivers}
      composerDriver={composerDriver}
      onTryPrompt={onTryPrompt}
      onEmpty={onEmpty}
    />
  );
}

function TipsSection({
  environmentId,
  ready,
  readyDrivers,
  composerDriver,
  onTryPrompt,
  onEmpty,
}: {
  environmentId: EnvironmentId;
  /**
   * Whether what the pick reads has loaded. Checked only until the pick, so a machine that
   * connects later never unmounts an open section.
   */
  ready: boolean;
  readyDrivers: string | undefined;
  composerDriver: string | null;
  onTryPrompt: (prompt: string) => void;
  onEmpty: () => void;
}) {
  // Picked once per draft, after it is on screen and its project's providers have loaded, so it
  // never changes while the user types or switches tabs.
  const [deck, setDeck] = useState<ReadonlyArray<TipId> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks tips from localStorage once the page is visible; a hidden page would spend today's tip
  useEffect(() => {
    if (deck !== null || !ready || readyDrivers === undefined) return;
    const pick = () => {
      if (document.visibilityState !== "visible") return;
      setDeck(canStoreTips() ? runTipsVisit(environmentId, new Set(readyDrivers.split(","))) : []);
    };
    const frame = requestAnimationFrame(pick);
    document.addEventListener("visibilitychange", pick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", pick);
    };
  }, [deck, environmentId, ready, readyDrivers]);
  if (deck === null || deck.length === 0) return null;
  return (
    <TipsCarousel
      deck={deck}
      environmentId={environmentId}
      composerDriver={composerDriver}
      onTryPrompt={onTryPrompt}
      onEmpty={onEmpty}
    />
  );
}

function TipsCarousel({
  deck: picked,
  environmentId,
  composerDriver,
  onTryPrompt,
  onEmpty,
}: {
  deck: ReadonlyArray<TipId>;
  environmentId: EnvironmentId;
  composerDriver: string | null;
  onTryPrompt: (prompt: string) => void;
  onEmpty: () => void;
}) {
  const navigate = useNavigate();
  // Tips hidden or finished in this visit leave at once. Settings lists every tip, and a
  // hidden one can be brought back there.
  const [gone, setGone] = useState<ReadonlySet<TipId>>(new Set());
  const deck = picked.filter((id) => !gone.has(id));
  // Start on the oldest tip not yet seen, so each one gets its turn without the arrows.
  const [currentId, setCurrentId] = useState(
    () => picked[deckStartIndex(TIPS, picked, readTipsState())],
  );
  // Read once: the setting changes as soon as "Turn it on" is pressed, and that button must
  // stay until the save ends.
  const [sidebarWasOn] = useState(() => getClientSettings().boringSidebarEnabled);
  const index = currentId === undefined ? -1 : deck.indexOf(currentId);
  const tip = currentId === undefined || index === -1 ? undefined : TIP_BY_ID.get(currentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the first time a tip is on screen in localStorage and analytics
  useEffect(() => {
    if (tip !== undefined) markTipShown(tip.id, environmentId);
  }, [tip, environmentId]);

  const sectionRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const slideId = useId();
  const savingSidebar = useRef(false);
  if (tip === undefined) return null;

  // Paging replaces the focused button; keep focus in the section so the arrows still work.
  const keepFocus = () => sectionRef.current?.focus({ preventScroll: true });
  const paged = deck.length > 1;
  const go = (step: number) => setCurrentId(deck[(index + step + deck.length) % deck.length]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // With one tip the arrows have nowhere to go, so focus stays on its button.
    if (!paged || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    // Modified arrows belong to the browser and OS, such as Alt+Left for Back.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    // Only the tip's own buttons are replaced; an arrow button keeps its focus.
    if (actionsRef.current?.contains(document.activeElement)) keepFocus();
    go(event.key === "ArrowLeft" ? -1 : 1);
  };
  // The tip leaves and the next one takes its place. When that removes the button that had
  // focus, focus stays in the section, or goes to the composer after the last tip.
  const remove = (id: TipId) => {
    const focused = document.activeElement;
    const inside = sectionRef.current?.contains(focused) === true;
    const at = deck.indexOf(id);
    flushSync(() => {
      setGone((current) => new Set(current).add(id));
      if (id === currentId) setCurrentId(deck[at + 1] ?? deck[at - 1]);
    });
    if (!inside || focused?.isConnected) return;
    if (sectionRef.current) keepFocus();
    else onEmpty();
  };
  const hide = () => {
    if (setTipDismissed(tip.id, true, environmentId)) remove(tip.id);
  };
  const turnOnSidebar = () => {
    // A second press during a slow save would queue the same write again.
    if (savingSidebar.current) return;
    savingSidebar.current = true;
    void persistClientSettingsUpdate((current) => ({ ...current, boringSidebarEnabled: true }))
      .then(
        () => {
          // The sidebar changes on screen, so the tip has nothing more to say.
          markTipDone("boring-sidebar");
          remove("boring-sidebar");
        },
        () => toastManager.add({ type: "error", title: "Could not save the sidebar setting" }),
      )
      .finally(() => {
        savingSidebar.current = false;
      });
  };
  const runAction = (action: TipAction) => {
    markTipOpened(tip.id, environmentId);
    if (action.kind === "boring-sidebar") turnOnSidebar();
    else if (action.kind === "prompt") onTryPrompt(action.prompt);
    else if (action.kind === "setting")
      void navigate({
        to: action.to,
        hash: settingsSearchHash(action.target),
        // Per-machine settings open on the draft's machine, not every environment.
        ...(action.scoped ? { search: { machine: environmentId } } : {}),
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
  };

  const showPreview = tip.id === "boring-sidebar";
  return (
    <section
      ref={sectionRef}
      aria-roledescription={paged ? "carousel" : undefined}
      aria-label="Tips"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The focus mark is the header line and the left rule in the ring color: a ring would box
      // the section in. Forced colors drops those colors, so there it gets an outline.
      className="group/tips @container text-xs focus-visible:outline-hidden"
    >
      <div className="flex h-6 items-center gap-2 text-muted-foreground pointer-coarse:gap-3">
        <span className="font-medium">Tips</span>
        {paged ? (
          <span aria-hidden className="tabular-nums">
            {index + 1} / {deck.length}
          </span>
        ) : null}
        <span
          aria-hidden
          className="h-px flex-1 bg-foreground/20 group-focus-visible/tips:h-0.5 group-focus-visible/tips:bg-ring"
        />
        {paged ? (
          <span className="-ms-2 flex items-center pointer-coarse:gap-5">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Previous tip"
              aria-controls={slideId}
              onClick={() => go(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Next tip"
              aria-controls={slideId}
              onClick={() => go(1)}
            >
              <ChevronRightIcon />
            </Button>
          </span>
        ) : null}
        {/* The padded touch target must not move the label in from the right edge. */}
        <span className="flex pointer-coarse:-me-1.5">
          <InlineButton
            tone="muted"
            touchTarget="padded"
            // Settings checks the draft's machine, as the section does.
            onClick={() =>
              void navigate({ to: "/settings/tips", search: { machine: environmentId } })
            }
          >
            See all
          </InlineButton>
        </span>
      </div>
      <div className="flex items-start justify-between gap-7 pt-3">
        <div
          className={cn(
            "flex max-w-lg min-w-0 flex-col gap-3 border-s-2 border-foreground/20 ps-3.5 group-focus-visible/tips:border-ring",
            showPreview && "@2xl:max-w-md",
          )}
        >
          <div
            id={slideId}
            aria-live="polite"
            {...(paged
              ? {
                  role: "group",
                  "aria-roledescription": "slide",
                  "aria-label": `Tip ${index + 1} of ${deck.length}`,
                }
              : {})}
          >
            <p className="text-sm font-medium text-foreground">{tip.lead}</p>
            <p className="mt-0.5 text-pretty leading-relaxed text-muted-foreground">{tip.body}</p>
          </div>
          {/* Keyed by tip, so a new tip never inherits focus on Hide. */}
          <div
            key={tip.id}
            ref={actionsRef}
            className="-ms-0.5 flex flex-wrap items-center gap-1.5"
          >
            <TipActions
              tip={withoutDoneActions(tip, sidebarWasOn)}
              appearance="button"
              composerDriver={composerDriver}
              onAction={runAction}
            />
            <Button size="xs" variant="ghost-muted" aria-label="Hide this tip" onClick={hide}>
              Hide
            </Button>
          </div>
        </div>
        {showPreview ? <BoringSidebarPreview /> : null}
      </div>
    </section>
  );
}

/** Drops "Turn it on" when Boring sidebar is already on, as after clearing "Tried it". */
export const withoutDoneActions = (tip: Tip, boringSidebarOn: boolean): Tip =>
  tip.id === "boring-sidebar" && boringSidebarOn
    ? { ...tip, actions: tip.actions.filter((action) => action.kind !== "boring-sidebar") }
    : tip;

/** The tip's actions. Settings shows prompts as copy buttons, since it has no composer. */
export function TipActions({
  tip,
  onAction,
  composerDriver = null,
  appearance = "inline",
}: {
  tip: Tip;
  onAction: (action: TipAction) => void;
  /** The composer's provider, or null where there is no composer to fill. */
  composerDriver?: string | null;
  /** Buttons in the tips section; inline links inside a Settings row. */
  appearance?: "inline" | "button";
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "tip text" });
  return tip.actions.map((action, position) => {
    const copyText =
      action.kind === "copy"
        ? action.text
        : action.kind === "prompt" &&
            (composerDriver === null ||
              (action.driver !== undefined && action.driver !== composerDriver))
          ? action.prompt
          : null;
    const props = {
      ...(action.kind === "link"
        ? { render: <a href={action.href} target="_blank" rel="noreferrer noopener" /> }
        : {}),
      onClick: () => {
        if (copyText === null) return onAction(action);
        copyToClipboard(copyText, undefined);
        // Report a copy, so a copied prompt never also lands in the composer.
        onAction({ kind: "copy", label: action.label, text: copyText });
      },
      children:
        copyText === null
          ? action.label
          : isCopied
            ? "Copied"
            : action.kind === "prompt"
              ? "Copy prompt"
              : action.label,
    };
    return appearance === "inline" ? (
      <InlineButton key={action.label} {...props} />
    ) : (
      <Button
        key={action.label}
        size="xs"
        variant={position === 0 ? "outline" : "ghost"}
        {...props}
      />
    );
  });
}

/**
 * A small copy of the Boring sidebar: project folders with the user's own recent threads under
 * them, drawn with the sidebar's own colors so it follows the theme.
 */
function BoringSidebarPreview() {
  const [{ folders, now }] = useState(() => {
    const now = Date.now();
    return { folders: sidebarPreviewFolders(readProjects(), readThreadShells(), now), now };
  });
  return (
    // Its bottom edge fades out, so it reads as a glimpse of the sidebar and not as a second box.
    <div aria-hidden className="hidden w-56 shrink-0 mask-b-from-80% @2xl:block">
      {/* The extra space under the last row is what fades, so every row stays clear. */}
      <div className="flex flex-col rounded-t-xl border border-b-0 border-border/70 bg-sidebar px-1 pt-1 pb-4 text-sidebar-foreground">
        {folders.map((folder) => (
          <PreviewFolder key={folder.key} folder={folder} now={now} />
        ))}
      </div>
    </div>
  );
}

function PreviewFolder({ folder, now }: { folder: SidebarPreviewFolder; now: number }) {
  const sample = deriveProjectIdentity(folder.name);
  return (
    <>
      <div className="flex h-6 items-center gap-2 px-2">
        {folder.project === null ? (
          <ProjectMonogram text={sample.monogram} color={sample.color} className="size-3.5" />
        ) : (
          <ProjectFavicon project={folder.project} className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground/90">
          {folder.name}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 text-sidebar-muted-foreground" />
      </div>
      <div className="flex h-6 items-center gap-2 ps-7.5 pe-2">
        <span className="min-w-0 flex-1 truncate">{folder.thread.title}</span>
        <span className="shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground">
          {compactSidebarTimeLabel(formatRelativeTimeLabel(folder.thread.updatedAt, now))}
        </span>
      </div>
    </>
  );
}
