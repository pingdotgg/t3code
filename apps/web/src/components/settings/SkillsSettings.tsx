import { CheckIcon, ChevronRightIcon, CopyIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import type { SkillInventory, SkillInventoryInstallation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  displayedSkillCount,
  fetchEnvironmentSkillInventory,
  filterSkillInventory,
  formatSkillCount,
  formatSkillPath,
  groupSkillsByHarness,
  setKeyCollapsed,
  skillContentForDisplay,
  skillKey,
} from "@t3tools/client-runtime/state/skills";
import { cn } from "../../lib/utils";
import { runtime } from "../../lib/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type InventoryState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly inventory: SkillInventory }
  | { readonly status: "error"; readonly message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : "Could not load skills.";
}

function connectionDotClassName(phase: string): string {
  if (phase === "connected") return "bg-success";
  if (phase === "connecting" || phase === "reconnecting") return "bg-warning";
  if (phase === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
}

/** Chevron that points right when collapsed and down when open. */
function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
        open && "rotate-90",
        className,
      )}
    />
  );
}

function StatusLine({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <p
      className={cn(
        "py-2 pl-9 pr-3 text-[13px] sm:pr-4",
        tone === "error" ? "text-destructive" : "text-muted-foreground/80",
      )}
    >
      {children}
    </p>
  );
}

export function SkillsSettings() {
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("skills").id}
        title="Skills"
        icon={<SparklesIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button size="xs" variant="ghost" onClick={() => setRefreshKey((value) => value + 1)}>
            <RefreshCwIcon className="size-3.5" />
            Refresh all
          </Button>
        }
      >
        <div className="space-y-2.5 px-3 pb-3 sm:px-4">
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            Global skills discovered by Codex and Claude on each connected computer. Paths refer to
            the computer where the skill is installed.
          </p>
          <Input
            type="search"
            nativeInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills, harnesses, or paths"
            aria-label="Search skills"
            className="max-w-sm"
          />
        </div>

        <div className="divide-y divide-border/50 border-t border-border/50">
          {environments.map((environment) => (
            <EnvironmentSkillInventory
              key={environment.environmentId}
              environment={environment}
              query={query}
              refreshKey={refreshKey}
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentSkillInventory({
  environment,
  query,
  refreshKey,
}: {
  environment: EnvironmentPresentation;
  query: string;
  refreshKey: number;
}) {
  const prepared = usePreparedConnection(environment.environmentId);
  const [state, setState] = useState<InventoryState>({ status: "loading" });
  const [collapsed, setCollapsed] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (Option.isNone(prepared)) return;
    let cancelled = false;
    setState({ status: "loading" });
    void runtime
      .runPromise(fetchEnvironmentSkillInventory({ prepared: prepared.value }))
      .then((inventory) => {
        if (!cancelled) setState({ status: "loaded", inventory });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [prepared, refreshKey]);

  const visibleInventory = useMemo(
    () => (state.status === "loaded" ? filterSkillInventory(state.inventory, query) : null),
    [query, state],
  );
  const isConnected = Option.isSome(prepared);
  const skillCount = displayedSkillCount(
    state.status === "loaded" ? state.inventory : null,
    isConnected,
  );
  const visibleSkillCount = displayedSkillCount(visibleInventory, isConnected);
  const phase = environment.connection.phase;
  const isSearching = query.trim().length > 0;
  const open = isSearching || !collapsed;
  const setOpen = (nextOpen: boolean) => {
    if (!isSearching) setCollapsed(!nextOpen);
  };

  return (
    <section>
      {/* The status dot is its own tooltip trigger, so it stays a sibling of
          the disclosure button rather than nesting inside it. */}
      <div className="flex min-w-0 items-center gap-2 pr-3 sm:pr-4">
        <h3 className="contents">
          <button
            type="button"
            aria-expanded={open}
            // The panel unmounts while closed, so only reference it when open.
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-2 pl-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:pl-4"
          >
            <DisclosureChevron open={open} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {environment.label}
            </span>
          </button>
        </h3>
        <ConnectionStatusDot
          tooltipText={phase}
          dotClassName={connectionDotClassName(phase)}
          pingClassName={
            phase === "connecting" || phase === "reconnecting"
              ? "bg-warning/60 duration-2000"
              : null
          }
        />
        {skillCount !== null ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {formatSkillCount(skillCount, isSearching ? (visibleSkillCount ?? 0) : undefined)}
          </span>
        ) : null}
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent id={panelId}>
          <div className="pb-2">
            {Option.isNone(prepared) ? (
              <StatusLine>Connect to this computer to inspect its skills.</StatusLine>
            ) : state.status === "loading" ? (
              <StatusLine>Scanning skills…</StatusLine>
            ) : state.status === "error" ? (
              <StatusLine tone="error">{state.message}</StatusLine>
            ) : visibleInventory?.installations.length === 0 ? (
              <StatusLine>
                {query ? "No skills match this search." : "No global Codex or Claude skills found."}
              </StatusLine>
            ) : visibleInventory ? (
              <SkillHarnessGroups inventory={visibleInventory} isSearching={isSearching} />
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function SkillHarnessGroups({
  inventory,
  isSearching,
}: {
  inventory: SkillInventory;
  isSearching: boolean;
}) {
  const [collapsedHarnesses, setCollapsedHarnesses] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groups = useMemo(() => groupSkillsByHarness(inventory.installations), [inventory]);

  return groups.map((group) => (
    <SkillHarnessGroup
      key={group.key}
      harnessDisplayName={group.harnessDisplayName}
      harness={group.harness}
      rootPath={group.rootPath}
      skills={group.skills}
      open={isSearching || !collapsedHarnesses.has(group.key)}
      onOpenChange={(nextOpen) => {
        if (!isSearching) {
          setCollapsedHarnesses((keys) => setKeyCollapsed(keys, group.key, !nextOpen));
        }
      }}
    />
  ));
}

function SkillHarnessGroup({
  harnessDisplayName,
  harness,
  rootPath,
  skills,
  open,
  onOpenChange,
}: {
  harnessDisplayName: string;
  harness: SkillInventoryInstallation["harness"];
  rootPath: string | null;
  skills: ReadonlyArray<SkillInventoryInstallation>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelId = useId();
  const HarnessIcon = PROVIDER_ICON_BY_PROVIDER[harness] ?? null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onOpenChange(!open)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-7 pr-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:pl-8 sm:pr-4"
      >
        <DisclosureChevron open={open} className="size-3" />
        {HarnessIcon ? <HarnessIcon aria-hidden className="size-3.5 shrink-0" /> : null}
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          {harnessDisplayName}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/50">
          {skills.length}
        </span>
        {rootPath ? (
          <span className="hidden min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground/40 sm:block">
            {formatSkillPath(rootPath)}
          </span>
        ) : null}
      </button>

      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleContent id={panelId}>
          {skills.map((skill) => (
            <SkillRow key={skillKey(skill)} skill={skill} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillInventoryInstallation }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-9 pr-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:pl-11 sm:pr-4",
          open && "bg-muted/20",
        )}
      >
        <DisclosureChevron open={open} className="size-3" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground sm:w-44 sm:shrink-0 lg:w-52">
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/70">
            {skill.description}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <span className="hidden w-56 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground/40 lg:block">
          {formatSkillPath(skill.directoryPath)}
        </span>
      </button>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent id={panelId}>
          <SkillDetail skill={skill} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SkillDetail({ skill }: { skill: SkillInventoryInstallation }) {
  const content = skillContentForDisplay(skill.content);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "skill path",
    timeout: 1_500,
    onError: () => toastManager.add({ type: "error", title: "Could not copy skill path" }),
  });
  const copyPath = useCallback(
    () => copyToClipboard(skill.directoryPath),
    [copyToClipboard, skill.directoryPath],
  );

  return (
    <div className="mx-3 mt-2 mb-5 space-y-4 rounded-lg border border-border/60 bg-muted/10 p-4 sm:ml-11 sm:mr-4 sm:p-5">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-foreground">{skill.name}</h4>
        <p className="max-w-3xl text-[13px] leading-6 text-muted-foreground/85">
          {skill.description ?? "No description in this skill's frontmatter."}
        </p>
      </div>

      <div className="space-y-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">
          Installed at
        </span>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-[1.5] text-muted-foreground">
            {skill.directoryPath}
          </code>
          <Button
            size="xs"
            variant="outline"
            onClick={copyPath}
            aria-label={`Copy path for ${skill.name}`}
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {isCopied ? "Copied" : "Copy path"}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border/60">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/25 px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            SKILL.md
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/40">
            {formatSkillPath(skill.skillFilePath)}
          </span>
        </div>
        {content ? (
          <ScrollArea chainVerticalScroll className="max-h-[32rem] w-full rounded-none">
            <pre className="whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs leading-7 text-muted-foreground/90">
              {content}
            </pre>
          </ScrollArea>
        ) : (
          <p className="px-2.5 py-2 text-[12px] text-muted-foreground/70">
            This SKILL.md file is empty.
          </p>
        )}
      </div>
    </div>
  );
}
