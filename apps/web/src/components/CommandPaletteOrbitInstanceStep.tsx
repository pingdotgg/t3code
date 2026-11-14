import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import type { OrbitDraftTarget } from "../orbit/orbitDraft";
import {
  filterOrbitInstanceRows,
  isOrbitInstanceNameFormatValid,
  orbitInstancePick,
  orbitInstanceRowSubline,
  orbitNameCheckFailure,
  orbitNameFieldForSearch,
  orbitNameHint,
  EMPTY_ORBIT_NAME_FIELD,
  type OrbitInstanceRow,
  type OrbitNameCheckState,
  type OrbitNameField,
  type OrbitNameHint,
} from "../orbit/orbitInstanceStepLogic";
import { checkOrbitInstanceName } from "../orbit/orbitPaletteProjects";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ITEM_ICON_CLASS, type CommandPaletteGroup } from "./CommandPalette.logic";
import { Skeleton } from "./ui/skeleton";

/** The Project the step creates in: a listed row, or the draft's own copy while the list loads. */
export interface OrbitStepProject {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly nodeName: string | null;
  readonly domainSuffix: string | null;
}

export function orbitStepProjectFromTarget(target: OrbitDraftTarget): OrbitStepProject {
  return {
    id: target.projectId,
    slug: target.projectSlug,
    name: target.projectName,
    nodeName: target.nodeName,
    domainSuffix: target.domainSuffix,
  };
}

const NAME_CHECK_DEBOUNCE_MS = 300;

export interface OrbitInstanceStep {
  readonly field: OrbitNameField;
  readonly hint: OrbitNameHint;
  readonly setTypedName: (value: string) => void;
  /** Marks a press of the plus or Enter without a usable name, so the field says why. */
  readonly markSubmitted: () => void;
}

/**
 * The name field's state: what the user typed (kept per Project), else the name a search without
 * a match fills in, and Orbit's live check of that name.
 */
export function useOrbitInstanceStep(input: {
  readonly project: OrbitStepProject | null;
  readonly query: string;
  readonly matchCount: number;
  /** The name the composer's Instance chip passed in, typed by the user before. */
  readonly initialTyped: { readonly projectId: number; readonly value: string } | null;
}): OrbitInstanceStep {
  const projectId = input.project?.id ?? null;
  const [typed, setTyped] = useState(input.initialTyped ?? { projectId: -1, value: "" });
  // A press without a name, kept for the Project and search it was made in.
  const [submittedFor, setSubmittedFor] = useState<{
    readonly projectId: number | null;
    readonly query: string;
  } | null>(null);
  const [check, setCheck] = useState<{
    readonly projectId: number;
    readonly state: OrbitNameCheckState;
  } | null>(null);

  const typedValue = typed.projectId === projectId ? typed.value : "";
  const field =
    typedValue !== ""
      ? { value: typedValue, source: "user" as const }
      : projectId === null
        ? EMPTY_ORBIT_NAME_FIELD
        : orbitNameFieldForSearch(EMPTY_ORBIT_NAME_FIELD, {
            query: input.query,
            matchCount: input.matchCount,
          });
  const name = field.value;
  const checkable = projectId !== null && isOrbitInstanceNameFormatValid(name);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Gateway about the name as it is typed
  useEffect(() => {
    if (!checkable || projectId === null) return;
    let current = true;
    const timer = setTimeout(() => {
      checkOrbitInstanceName(projectId, name).then(
        (answer) => {
          if (current) setCheck({ projectId, state: { status: "answered", name, answer } });
        },
        (error: unknown) => {
          if (current) setCheck({ projectId, state: orbitNameCheckFailure(name, error) });
        },
      );
    }, NAME_CHECK_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [checkable, projectId, name]);

  const hint = orbitNameHint({
    name,
    check: check !== null && check.projectId === projectId ? check.state : { status: "idle" },
    projectName: input.project?.name ?? "",
    submitted: submittedFor?.projectId === projectId && submittedFor.query === input.query,
  });
  return {
    field,
    hint,
    setTypedName: (value) => {
      setSubmittedFor(null);
      if (projectId !== null) setTyped({ projectId, value });
    },
    markSubmitted: () => setSubmittedFor({ projectId, query: input.query }),
  };
}

/** "New instance": the name field, the plus, and the line under it. The name is unique per Project; the address is only a by-product, so it is not shown. */
export function OrbitNewInstanceSection(props: {
  readonly project: OrbitStepProject;
  readonly step: OrbitInstanceStep;
  readonly onCreate: () => void;
  /** No Instance row is highlighted, so Enter creates this one. */
  readonly selected: boolean;
}) {
  const { step } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const create = () => {
    if (!step.hint.canCreate) inputRef.current?.focus();
    props.onCreate();
  };
  return (
    <div className="px-2 pt-2" data-orbit-new-instance>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">New instance</div>
      {/* A step lighter than the palette, as in the design; brighter while it is Enter's target. */}
      <div
        data-selected={props.selected || undefined}
        className="flex h-10 items-center gap-2 rounded-xl border border-foreground/9 bg-foreground/4 ps-2 pe-1.5 transition-[border-color,box-shadow] focus-within:border-foreground/55 focus-within:ring-3 focus-within:ring-foreground/8 focus-within:ring-inset data-selected:border-foreground/30 data-selected:focus-within:border-foreground/55"
      >
        <span className="flex min-w-0 flex-1 items-baseline">
          <input
            ref={inputRef}
            aria-label="Instance name"
            placeholder="Instance name"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
            value={step.field.value}
            onChange={(event) => step.setTypedName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              event.preventDefault();
              create();
            }}
          />
        </span>
        <button
          type="button"
          aria-label="Create instance"
          className="relative flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md bg-foreground/8 text-muted-foreground outline-none enabled:hover:bg-foreground/12 enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
          disabled={!step.hint.plusEnabled}
          onClick={create}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      <div
        role="status"
        className={cn(
          "px-2 pt-1 pb-1 text-xs",
          step.hint.tone === "ok"
            ? "text-success-foreground"
            : step.hint.tone === "bad"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
        )}
        data-orbit-name-hint={step.hint.tone}
      >
        {step.hint.text}
      </div>
    </div>
  );
}

function InstanceDot(props: { readonly state: OrbitInstanceRow["state"] }) {
  return (
    <span className="flex size-4 items-center justify-center" aria-hidden>
      <span
        className={cn(
          "size-2 rounded-full",
          props.state === "running"
            ? "bg-success"
            : props.state === "stopped"
              ? "bg-warning"
              : "border border-muted-foreground/70",
        )}
      />
    </span>
  );
}

const EXISTING_GROUP = "orbit-existing-instances";
/** The failed list's Retry row; Enter on it retries instead of creating. */
export const ORBIT_INSTANCES_RETRY_VALUE = `${EXISTING_GROUP}:retry`;
const EXISTING_LABEL = "Existing instances";
const SKELETON_WIDTHS = ["42%", "34%", "48%", "30%"];

function infoGroup(item: CommandPaletteGroup["items"][number]): CommandPaletteGroup[] {
  return [{ value: EXISTING_GROUP, label: EXISTING_LABEL, items: [item] }];
}

function infoItem(value: string, text: string): CommandPaletteGroup["items"][number] {
  return {
    kind: "action",
    value: `${EXISTING_GROUP}:${value}`,
    searchTerms: [],
    title: <span className="text-muted-foreground">{text}</span>,
    icon: null,
    disabled: true,
    run: async () => {},
  };
}

/** The "Existing instances" list, already filtered by the search, and its states. */
export function orbitExistingInstanceGroups(input: {
  readonly status: "loading" | "failed" | "loaded";
  readonly project: OrbitStepProject;
  readonly rows: ReadonlyArray<OrbitInstanceRow>;
  readonly query: string;
  readonly retry: () => void;
  readonly pick: (row: OrbitInstanceRow) => Promise<void>;
}): CommandPaletteGroup[] {
  if (input.status === "loading") {
    return [
      {
        value: EXISTING_GROUP,
        label: EXISTING_LABEL,
        items: SKELETON_WIDTHS.map((width, index) => ({
          kind: "action",
          value: `${EXISTING_GROUP}:loading:${index}`,
          searchTerms: [],
          title: (
            <span className="flex w-60 flex-col gap-1.5 py-0.5">
              <Skeleton className="h-3" style={{ width }} />
              <Skeleton className="h-2.5 w-1/2" />
            </span>
          ),
          icon: <Skeleton className="size-4" />,
          disabled: true,
          run: async () => {},
        })),
      },
    ];
  }
  if (input.status === "failed") {
    return infoGroup({
      kind: "action",
      value: ORBIT_INSTANCES_RETRY_VALUE,
      searchTerms: [],
      title: (
        <span className="whitespace-normal text-muted-foreground">
          Could not load the instances of {input.project.name}. You can still create a new one.
        </span>
      ),
      searchTitle: "Could not load the instances",
      icon: <TriangleAlertIcon className={ITEM_ICON_CLASS} />,
      titleTrailingContent: (
        <span className="ms-auto shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-foreground text-xs">
          Retry
        </span>
      ),
      keepOpen: true,
      run: async () => input.retry(),
    });
  }
  const shown = filterOrbitInstanceRows(input.rows, input.query);
  if (shown.length === 0) {
    return infoGroup(
      infoItem(
        "empty",
        input.query.trim() !== "" && input.rows.length > 0 ? "Nothing found." : "No instances yet.",
      ),
    );
  }
  return [
    {
      value: EXISTING_GROUP,
      label: EXISTING_LABEL,
      items: shown.map((row) => ({
        kind: "action",
        value: `${EXISTING_GROUP}:${row.instanceId}`,
        searchTerms: [row.name],
        title: row.name,
        description: orbitInstanceRowSubline(row),
        icon: <InstanceDot state={row.state} />,
        ...(row.lastUsedAt === null
          ? {}
          : {
              titleTrailingContent: (
                <span className="ms-auto shrink-0 text-muted-foreground/70 text-xs">
                  {formatRelativeTimeLabel(row.lastUsedAt)}
                </span>
              ),
            }),
        ...(orbitInstancePick(row).kind === "disabled" ? { disabled: true } : {}),
        run: () => input.pick(row),
      })),
    },
  ];
}

/** The list status the step shows for the Gateway read it shares with the Project list. */
export function orbitInstanceListStatus(state: {
  readonly status: string;
}): "loading" | "failed" | "loaded" {
  if (state.status === "loaded") return "loaded";
  return state.status === "unreachable" ? "failed" : "loading";
}
