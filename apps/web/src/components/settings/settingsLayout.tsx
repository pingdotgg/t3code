import { SettingsScopeSentence } from "./SettingsScopeSentence";
import { SettingsGroup } from "./SettingsGroup";
import {
  InfoIcon,
  LockIcon,
  RotateCcwIcon,
  SearchIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { usePrimaryEnvironmentId, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useServerConfigs } from "../../state/entities";
import {
  DEFAULT_SERVER_SETTINGS,
  isManagedSettingPath,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import {
  createContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
  usePrimarySettingsAvailable,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { WorkspacePageContainer, type WorkspacePageWidth } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  isProjectScopedSettingKey,
  listProjectOverrides,
  type ProjectOverrideEntry,
  scopedSettingsAreMixed,
  scopedSettingsSource,
} from "./scopedSettings";
import { useClearProjectOverrides, useClearScopedSettings } from "./useScopedSettings";
import {
  SettingInheritance,
  type SettingInheritanceState,
  SettingOverrideCount,
  type SettingOverridingProject,
  SettingResetPlacementContext,
} from "./SettingInheritance";

const EMPTY_SETTING_KEYS: readonly (keyof ServerSettings)[] = [];
const EMPTY_MANAGED_PATHS: readonly string[] = [];

declare module "@tanstack/react-router" {
  interface HistoryState {
    settingsTargetHighlight?: boolean;
  }
}

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly highlightTarget: boolean;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  highlightTarget: true,
  onTargetHandled: noop,
});

function SettingsSearchTargetProvider({
  targetId,
  highlightTarget = true,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  highlightTarget?: boolean;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = { targetId, highlightTarget, onTargetHandled };
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

let pendingTargetScroll: AbortController | undefined;

function scrollAndFocusSettingsTarget(target: HTMLElement, highlight = true): void {
  pendingTargetScroll?.abort();
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const markedScrollTarget =
    typeof target.querySelector === "function"
      ? target.querySelector<HTMLElement>(":scope > [data-settings-scroll-target]")
      : null;
  const scrollTarget =
    markedScrollTarget ??
    (target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target);

  const scroll = () =>
    scrollTarget.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "center",
    });
  scroll();
  const panel = target.parentElement?.closest<HTMLElement>(
    '[data-slot="collapsible-panel"][data-open]',
  );
  const heightTransition = () =>
    panel
      ?.getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === "height",
      );
  if (panel && (panel.hasAttribute("data-starting-style") || heightTransition())) {
    const controller = new AbortController();
    pendingTargetScroll = controller;
    const { signal } = controller;
    const finishScroll = () => {
      if (signal.aborted) return;
      controller.abort();
      if (
        panel.hasAttribute("data-open") &&
        target.isConnected &&
        document.activeElement === target
      ) {
        scroll();
      }
    };
    const waitForHeight = () => {
      const transition = heightTransition();
      if (transition) {
        void transition.finished.then(finishScroll, () => controller.abort());
      } else {
        finishScroll();
      }
    };
    // Base UI clears the starting style before the height transition finishes.
    if (panel.hasAttribute("data-starting-style")) {
      const observer = new MutationObserver(() => {
        if (!panel.hasAttribute("data-starting-style")) {
          observer.disconnect();
          waitForHeight();
        }
      });
      observer.observe(panel, { attributes: true, attributeFilter: ["data-starting-style"] });
      signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    } else {
      waitForHeight();
    }
    target.addEventListener("blur", () => controller.abort(), { once: true, signal });
  }
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (!highlight || prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

export function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, highlightTarget, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = (target: T | null) => {
    if (target && isSearchTarget) {
      scrollAndFocusSettingsTarget(target, highlightTarget);
      onTargetHandled();
    }
  };

  return targetRef;
}

export function SettingsSearchTarget({
  children,
  ...targetProps
}: ComponentPropsWithoutRef<"div">) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(targetProps.id);
  return (
    <div {...targetProps} ref={targetRef} tabIndex={targetProps.id ? -1 : targetProps.tabIndex}>
      {children}
    </div>
  );
}

/**
 * Layout for the composer model/traits pickers in a settings row: size to the
 * "Model · Effort" label up to 18rem, then truncate. The `sm:` cap must be
 * explicit so it replaces the composer's `sm:max-w-56` in `cn`.
 */
export const SETTINGS_PICKER_TRIGGER_CLASSNAME = "min-w-0 max-w-full shrink-0 sm:max-w-72";

export function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label="Background policy details">
            <InfoIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

type SettingsRowScopeKind = "project" | "environment" | "device";

interface SettingsSectionLock {
  readonly locked: boolean;
  readonly register: (kind: SettingsRowScopeKind) => () => void;
}

const SettingsSectionLockContext = createContext<SettingsSectionLock | null>(null);

const ENVIRONMENT_WIDE_MESSAGE = "Environment-wide setting. Select an environment to change it.";
const ENVIRONMENT_WIDE_SECTION_MESSAGE =
  "Environment-wide settings. Select an environment to change them.";

/**
 * At a project scope, a section whose rows all apply to the whole
 * environment locks as one: a lock beside the title explains it once and the
 * card dims, instead of every row carrying its own tooltip. Rows register
 * whether they are device-local or can be overridden, so the section needs no per-page wiring.
 */
function useSettingsSectionLock(): SettingsSectionLock {
  const context = useOptionalSettingsScope();
  const isProjectScope =
    context !== null && (context.scope.kind === "project" || context.scope.kind === "checkout");
  const [counts, setCounts] = useState({ project: 0, environment: 0, device: 0 });
  const register = (kind: SettingsRowScopeKind) => {
    setCounts((current) => ({ ...current, [kind]: current[kind] + 1 }));
    return () => setCounts((current) => ({ ...current, [kind]: current[kind] - 1 }));
  };
  const locked =
    isProjectScope && counts.environment > 0 && counts.project === 0 && counts.device === 0;
  return { locked, register };
}

/**
 * `warning` is a passive caveat for the whole section: an amber glyph beside the title with the
 * sentence as its tooltip, never a banner row inside the card.
 */
export function SettingsSection({
  title,
  hideTitle = false,
  icon,
  warning,
  titleAction,
  headerAction,
  variant = "grouped",
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  hideTitle?: boolean;
  icon?: ReactNode;
  warning?: string | undefined;
  titleAction?: ReactNode;
  headerAction?: ReactNode;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);
  const lock = useSettingsSectionLock();
  const lockIndicator = lock.locked ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={ENVIRONMENT_WIDE_SECTION_MESSAGE}
            className="inline-flex size-5 items-center justify-center rounded-badge text-dim-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <LockIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{ENVIRONMENT_WIDE_SECTION_MESSAGE}</TooltipPopup>
    </Tooltip>
  ) : null;

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn(!hideTitle && "space-y-2", className)}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div data-settings-scroll-target className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="flex items-center gap-2 text-title text-foreground">
              {icon}
              {title}
            </h2>
            {titleAction}
            {warning ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      aria-label={warning}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-badge text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <TriangleAlertIcon aria-hidden className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">{warning}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {headerAction || lockIndicator ? (
            <div className="flex min-w-6 items-center justify-end gap-2">
              {headerAction}
              {lockIndicator}
            </div>
          ) : null}
        </div>
      )}
      <SettingsSectionLockContext value={lock}>
        <SettingsGroup
          data-settings-scroll-target={hideTitle ? "" : undefined}
          data-locked={lock.locked ? "" : undefined}
          inert={lock.locked}
          variant={variant}
          className={lock.locked ? "opacity-45" : undefined}
        >
          {children}
        </SettingsGroup>
      </SettingsSectionLockContext>
    </section>
  );
}

/** Dims a group of controls that cannot be used here; the section's `warning` says why. */
export function SettingsUnavailableGroup({
  children,
  unavailable,
}: {
  children: ReactNode;
  unavailable: boolean;
}) {
  if (!unavailable) return children;

  return (
    <div className="rounded-[inherit] [&>*+*]:border-t [&>*+*]:border-divider [&>[data-slot=settings-row]]:rounded-none [&>[data-slot=settings-row]:first-child]:rounded-t-card [&>[data-slot=settings-row]:last-child]:rounded-b-card [&_h3]:opacity-64 [&_p]:opacity-64">
      {children}
    </div>
  );
}

/** The row a popover reset belongs to; the reset removes the popover's trigger, so focus goes here. */
const SettingsRowFocusContext = createContext<(() => void) | null>(null);
function projectOverrides(
  context: ReturnType<typeof useOptionalSettingsScope>,
  scopedKeys: ReadonlyArray<keyof ServerSettings>,
): SettingOverridingProject[] {
  if (context === null || scopedKeys.length === 0) return [];
  return listProjectOverrides(context.connectedEnvironments, scopedKeys).flatMap((entry) => {
    const group = context.groups.find((candidate) =>
      candidate.memberProjects.some(
        (member) => member.environmentId === entry.environmentId && member.id === entry.projectId,
      ),
    );
    if (!group) return [];
    return [
      {
        ...entry,
        label: group.displayName,
        open: () =>
          context.selectScope({
            project: group.projectKey,
            ...(context.search.machine ? { machine: context.search.machine } : {}),
          }),
      },
    ];
  });
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  onResetOverride,
  leading,
  trailing,
  control,
  serverScoped = false,
  settingKeys = EMPTY_SETTING_KEYS,
  managedPaths = EMPTY_MANAGED_PATHS,
  mixed: mixedOverride,
  managed,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  onResetOverride?: () => void;
  /** A 32px icon tile before the text, for list rows such as providers and clients. */
  leading?: ReactNode;
  /** An indicator after the text, such as a navigation chevron. Unlike a control it stays beside the text at every width. */
  trailing?: ReactNode;
  control?: ReactNode;
  serverScoped?: boolean;
  settingKeys?: readonly (keyof ServerSettings)[];
  /** Dot paths inside a setting, such as `storageCleanup.logsAfterDays`, an administrator can lock. */
  managedPaths?: readonly string[];
  mixed?: boolean;
  /** Why an administrator's policy turns this row's control off, from the contract's denial helpers. */
  managed?: string | undefined;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const attachRow = (node: HTMLDivElement | null) => {
    rowRef.current = node;
    targetRef(node);
  };
  const focusRow = () => rowRef.current?.focus({ preventScroll: true });
  const primarySettingsAvailable = usePrimarySettingsAvailable();
  const context = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryCanWrite = useEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope);
  const writableIds = useEnvironmentsWithScope(
    context?.connectedEnvironments ?? [],
    AuthSettingsWriteScope,
  );
  const canWriteSettings = context
    ? context.connectedEnvironments.length > 0 &&
      context.connectedEnvironments.every((target) => writableIds.has(target.environmentId))
    : primaryCanWrite;
  const serverConfigs = useServerConfigs();
  // An administrator's lock on any target wins over every other reason a control is inert.
  const lockablePaths = [...settingKeys, ...managedPaths];
  const managedBy =
    lockablePaths.length === 0
      ? undefined
      : (context
          ? context.connectedEnvironments.map((environment) => environment.serverConfig)
          : [primaryEnvironmentId === null ? undefined : serverConfigs.get(primaryEnvironmentId)]
        )
          .map((config) => config?.managedPolicy)
          .find(
            (policy) =>
              policy !== undefined &&
              lockablePaths.some((path) => isManagedSettingPath(policy, path)),
          )?.organization;
  const clearOverrides = useClearScopedSettings();
  const clearProjectOverrides = useClearProjectOverrides();
  const isProjectScope =
    context !== null && (context.scope.kind === "project" || context.scope.kind === "checkout");
  const scopedKeys = settingKeys.filter(isProjectScopedSettingKey);
  const environmentWide = isProjectScope && serverScoped && scopedKeys.length === 0;
  const sectionLock = useContext(SettingsSectionLockContext);
  const registerWithSection = sectionLock?.register;
  const rowScopeKind: SettingsRowScopeKind | null = !isProjectScope
    ? null
    : !serverScoped
      ? "device"
      : environmentWide
        ? "environment"
        : "project";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers each mounted row's scope with its enclosing section so mixed sections keep device controls editable
  useLayoutEffect(() => {
    if (!registerWithSection || rowScopeKind === null) return;
    return registerWithSection(rowScopeKind);
  }, [registerWithSection, rowScopeKind]);
  const sectionLocked = sectionLock?.locked === true;
  const mixed =
    mixedOverride ?? (context !== null && scopedSettingsAreMixed(context.targets, settingKeys));
  const source =
    context && isProjectScope ? scopedSettingsSource(context.targets, scopedKeys) : null;
  const unavailable =
    serverScoped &&
    (!canWriteSettings ||
      !(context ? context.connectedEnvironments.length > 0 : primarySettingsAvailable));
  const inheritedFrom =
    source === "environment" && context?.scope.environmentIds.length === 1
      ? (context.environments.find(
          (environment) => environment.environmentId === context.scope.environmentIds[0],
        )?.label ?? "environment")
      : "environment";
  const environmentSettingsById = new Map(
    (context?.connectedEnvironments ?? []).flatMap((environment) =>
      environment.serverConfig
        ? [[environment.environmentId, environment.serverConfig.settings] as const]
        : [],
    ),
  );
  const overridingProjects = isProjectScope ? [] : projectOverrides(context, scopedKeys);
  const renderedReset =
    unavailable || managedBy !== undefined || managed !== undefined ? null : isProjectScope &&
      scopedKeys.length > 0 ? (
      source === "project" || source === "mixed" ? (
        <SettingResetButton
          label={typeof title === "string" ? title : "override"}
          tooltip="Reset to inherited value"
          onClick={() => (onResetOverride ? onResetOverride() : clearOverrides(scopedKeys))}
        />
      ) : null
    ) : (
      resetAction
    );
  const inertControl = (message: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="flex w-full items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[26rem]/settings-row:w-auto"
          />
        }
      >
        <div
          inert
          className="flex w-full items-center gap-2 opacity-64 @min-[26rem]/settings-row:w-auto"
        >
          {control}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top">{message}</TooltipPopup>
    </Tooltip>
  );
  const renderedControl =
    managed !== undefined && control
      ? inertControl(managed)
      : managedBy !== undefined && control
        ? inertControl(`Managed by ${managedBy}.`)
        : unavailable && control
          ? inertControl(
              !canWriteSettings
                ? `This connection lacks permission to change settings on ${
                    context
                      ? context.connectedEnvironments
                          .filter((target) => !writableIds.has(target.environmentId))
                          .map((target) => target.label)
                          .join(", ") || "the selected environment"
                      : (primaryEnvironment?.label ?? "the primary environment")
                  }.`
                : context
                  ? "Reconnect the selected environment to change this setting."
                  : PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
            )
          : environmentWide && control && !sectionLocked
            ? inertControl(ENVIRONMENT_WIDE_MESSAGE)
            : control;
  const customized =
    context !== null &&
    settingKeys.some((key) =>
      context.targets.some((candidate) => {
        const environmentSettings = environmentSettingsById.get(candidate.environmentId);
        return (
          environmentSettings !== undefined &&
          !Equal.equals(environmentSettings[key], DEFAULT_SERVER_SETTINGS[key])
        );
      }),
    );
  const inheritance: { state: SettingInheritanceState; summary: string } = mixed
    ? { state: "mixed", summary: "Mixed across selected environments" }
    : source === "project"
      ? { state: "overridden", summary: "Overridden for this project" }
      : source === "t3.json"
        ? { state: "inherited", summary: "Inherited from the repository's t3.json" }
        : source === "environment" && scopedKeys.length > 0
          ? { state: "inherited", summary: `Inherited from ${inheritedFrom}` }
          : customized
            ? { state: "environment", summary: "Set on the environment" }
            : { state: "default", summary: "Built-in default" };
  // The indicator shows only where a value was set somewhere: a project or
  // environment value, t3.json, a mixed selection, or projects overriding it.
  // A row on its built-in default, or inheriting one, stays quiet.
  const showInheritance =
    context !== null &&
    serverScoped &&
    settingKeys.length > 0 &&
    !unavailable &&
    (inheritance.state === "overridden" ||
      inheritance.state === "mixed" ||
      inheritance.state === "environment" ||
      source === "t3.json" ||
      overridingProjects.length > 0 ||
      Boolean(renderedReset));
  const renderedInheritance =
    context && showInheritance ? (
      <SettingInheritance
        state={inheritance.state}
        summary={inheritance.summary}
        targets={context.targets}
        environments={context.connectedEnvironments}
        keys={settingKeys}
        {...(context.scope.kind === "project" || context.scope.kind === "checkout"
          ? { projectLabel: context.scope.group.displayName }
          : {})}
        overridingProjects={overridingProjects}
        {...(canWriteSettings
          ? {
              onClearOverrides: (entries: readonly ProjectOverrideEntry[]) =>
                clearProjectOverrides(entries, scopedKeys),
            }
          : {})}
        footer={
          renderedReset ? (
            <SettingsRowFocusContext value={focusRow}>{renderedReset}</SettingsRowFocusContext>
          ) : undefined
        }
      />
    ) : null;
  // Server rows keep their reset inside the inheritance popover; client rows
  // (and rows without a chain) keep the inline arrow beside the title.
  const inlineReset = renderedInheritance ? null : renderedReset;
  const renderedStatus = status;

  return (
    <div
      {...rowProps}
      ref={attachRow}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      data-slot="settings-row"
      className={cn(
        "group/settings-row @container/settings-row rounded-card px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground",
        children ? "pt-3 pb-1" : "py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-3 @min-[26rem]/settings-row:grid @min-[26rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[26rem]/settings-row:items-center @min-[26rem]/settings-row:gap-6">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3",
            !renderedControl && "col-span-full",
          )}
        >
          {leading ? <SettingsRowTile>{leading}</SettingsRowTile> : null}
          <div className="min-w-0 flex-1 space-y-0.75">
            <div className="flex min-h-5 items-center gap-1.5">
              <h3 className="text-label text-foreground">{title}</h3>
              {renderedInheritance ? (
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  {renderedInheritance}
                </span>
              ) : null}
              {renderedInheritance && !isProjectScope ? (
                <SettingOverrideCount count={overridingProjects.length} />
              ) : null}
              {inlineReset ? (
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  {inlineReset}
                </span>
              ) : null}
            </div>
            {description ? (
              <p
                data-settings-description
                className="text-body text-muted-foreground [--type-body:var(--type-meta)]"
              >
                {description}
              </p>
            ) : null}
            {renderedStatus ? (
              <div className="pt-0.5 text-body text-muted-foreground [--type-body:var(--type-meta)]">
                {renderedStatus}
              </div>
            ) : null}
          </div>
          {trailing}
        </div>
        {renderedControl ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[26rem]/settings-row:w-auto @min-[26rem]/settings-row:justify-end">
            {renderedControl}
          </div>
        ) : null}
      </div>
      {unavailable && children ? (
        <div inert className="opacity-64">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * A line of explanation inside a settings group, between or above its rows,
 * inset to the rows' padding. `icon` leads a one-line warning or hint.
 */
export function SettingsNote({
  icon,
  children,
}: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  if (icon === undefined) {
    return (
      <p className="px-3 py-2.5 text-body text-muted-foreground [--type-body:var(--type-meta)] sm:px-4">
        {children}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2.5 text-body leading-normal text-muted-foreground [--type-body:var(--type-meta)] sm:px-4 [&>svg]:size-3.5 [&>svg]:h-lh [&>svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/** The 32px raised tile for a row's leading icon. */
export function SettingsRowTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-control surface-raised text-foreground [&_svg:not([class*='size-'])]:size-4"
    >
      {children}
    </span>
  );
}

/**
 * Resets a setting. Inline it is an arrow beside the row title; inside a
 * row's inheritance popover footer it renders as the labeled action.
 */
export function SettingResetButton({
  label,
  tooltip = "Reset to default",
  disabled = false,
  onClick,
}: {
  label: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const placement = useContext(SettingResetPlacementContext);
  const focusRow = useContext(SettingsRowFocusContext);
  if (placement === "popover") {
    return (
      <Button
        size="xs"
        variant="secondary"
        aria-label={`Reset ${label}: ${tooltip}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          flushSync(onClick);
          focusRow?.();
        }}
      >
        <RotateCcwIcon aria-hidden />
        {tooltip}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Reset ${label} to default`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

// Settings pages wear the app-wide page empty state.
export {
  PageEmptyState as SettingsEmptyState,
  PageEmptyTile as SettingsEmptyTile,
  PageEmptyTiles as SettingsEmptyTiles,
} from "../PageEmptyState";

const LOADING_ROW_TITLES = [
  <Skeleton key="0" className="h-3 w-2/5" />,
  <Skeleton key="1" className="h-3 w-1/3" />,
  <Skeleton key="2" className="h-3 w-1/2" />,
];

/** Placeholder rows inside a settings group while its list loads. `label` is read to screen readers. */
export function SettingsLoadingRows({ label, count = 3 }: { label: string; count?: 1 | 2 | 3 }) {
  return (
    <div role="status" aria-label={label} className="[&>*+*]:border-t [&>*+*]:border-divider">
      {LOADING_ROW_TITLES.slice(0, count).map((title) => (
        <div key={title.key} aria-hidden className="flex flex-col gap-2 px-3 py-3.5 sm:px-4">
          {title}
          <Skeleton className="h-2.5 w-3/5" />
        </div>
      ))}
    </div>
  );
}

/** A search that matched nothing: what was searched for, and a way back to the full list. */
export function SettingsNoMatches({
  children,
  onClear,
}: {
  children: ReactNode;
  onClear: () => void;
}) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 py-10 text-center">
      <SearchIcon aria-hidden className="size-4 text-dim-foreground" />
      <p className="text-body text-muted-foreground">{children}</p>
      <Button size="xs" variant="ghost" onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

/** A page toolbar above the first section: a search well that fills the row, then actions. */
export function SettingsToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * The always-open search well used by list pages (keybindings, archive, licenses). Escape clears
 * it, then leaves the field; only an Escape from outside it leaves Settings.
 */
export function SettingsSearchField({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <InputGroup className="min-w-48 flex-1">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (value.length > 0) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        size="sm"
      />
    </InputGroup>
  );
}

/** Every settings page is one column, 36px from the top, with 28px between sections. */
export function SettingsPageContainer({
  children,
  className,
  width = "readable",
  centered = false,
}: {
  children: ReactNode;
  className?: string;
  width?: WorkspacePageWidth;
  /** Centers short content such as an empty state in the page's height. */
  centered?: boolean;
}) {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const pathname = useLocation({ select: (location) => location.pathname });
  const highlightTarget = useLocation({
    select: (location) => location.state.settingsTargetHighlight !== false,
  });
  const targetId = hash.replace(/^#/, "") || null;
  const clearTargetHash = () => {
    void navigate({
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  return (
    <SettingsSearchTargetProvider
      targetId={targetId}
      highlightTarget={highlightTarget}
      onTargetHandled={clearTargetHash}
    >
      <div className="scrollbar-gutter-both flex-1 overflow-y-auto" data-settings-page-scroll>
        <WorkspacePageContainer
          width={width}
          className={cn(
            "max-w-[688px] gap-7 pt-9",
            centered && "min-h-full justify-center",
            className,
          )}
        >
          <SettingsScopeSentence pathname={pathname} />
          {children}
        </WorkspacePageContainer>
      </div>
    </SettingsSearchTargetProvider>
  );
}

export function scrollToSettingsTarget(
  targetId: string,
  { highlight = true }: { readonly highlight?: boolean } = {},
): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target, highlight);
  return true;
}
