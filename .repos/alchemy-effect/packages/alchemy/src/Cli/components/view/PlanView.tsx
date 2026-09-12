/** @jsxImportSource react */
/**
 * THE plan renderer. Every surface that shows a plan tree — `alchemy plan`
 * output, the approval prompt, and the live apply/dev/destroy progress —
 * renders through this one state-driven component, so a plan always looks
 * the same wherever it appears.
 *
 * - One {@link PlanTree} holds the flattened tree (namespaces,
 *   resources, bindings, actions) plus per-row runtime state (apply status
 *   and the row's latest log message), updated from engine
 *   {@link ApplyEvent}s.
 * - Two presentation `mode`s: `review` renders action glyphs (`+ ~ - ±`),
 *   `apply` renders live statuses with spinners and per-row messages.
 * - `virtual` viewports follow the active row and support keyboard scrolling;
 *   `full` viewports produce static terminal scrollback. This choice is
 *   independent of whether the tree will receive more events.
 * - Property diffs (`detailed`) render in every mode, and the window is
 *   line-budget aware so multi-line rows never overflow the terminal.
 */
import { useMemo, useSyncExternalStore, type JSX, type ReactNode } from "react";
import {
  Box,
  KeyBar,
  Row,
  SectionHeading,
  SpinnerGlyph,
  TaskRow,
  Text,
  useBorderStyle,
  useGlyphs,
  useKeyGlyphs,
} from "../ui/index.ts";
import type { Plan as AlchemyPlan } from "../../../Plan.ts";
import type { ApplyStatus } from "../../../Report.ts";
import type { ActionVerb, PlanSummaryCounts } from "../../NamespaceTree.ts";
import { formatModeNote } from "../../ModeTag.ts";
import { theme } from "../../CliKit/index.ts";
import { formatElapsed } from "../../Format.ts";
import {
  actionStyle,
  applyStatusColor,
  isInProgress,
  isTerminalStatus,
} from "./statusStyle.ts";
import { matchYamlChange, matchYamlKey } from "../../PropertyDiff.ts";
import { NamespaceRow, namespaceStyle } from "./PlanRow.tsx";
import { StackOutputs } from "./StackOutputs.tsx";
import {
  PlanTree,
  initialResourceState,
  type PlanRow,
  type PlanTreeState,
  type ResourceRow,
  type RowState,
} from "./PlanTree.ts";
import { usePlanViewport } from "./usePlanViewport.ts";
import { usePlanPresentation } from "./usePlanPresentation.ts";

export { PlanTree } from "./PlanTree.ts";
export type {
  PlanOutcome,
  PlanProgress,
  PlanRow,
  PlanTreeOptions,
  PlanTreeState,
  PlanView,
  PlanViewport,
  RowState,
} from "./PlanTree.ts";
export type { PlanSummaryCounts } from "../../NamespaceTree.ts";

/**
 * Row detail: the latest log/annotation line, painted danger when the row
 * failed so the error reads at the row instead of only in the final dump.
 */
const rowDetail = (status: ApplyStatus, message: string | undefined) =>
  message !== undefined && status === "fail" ? (
    <Text color={theme.color.danger}>{message}</Text>
  ) : (
    message
  );

// ── Component ─────────────────────────────────────────────────────────────

export interface PlanProps {
  /** Reactive tree containing rows, statuses, label, and presentation state. */
  tree: PlanTree;
  /** Allow the tree to collapse behind `p`. */
  collapsible?: boolean;
  /** Widget rendered before the summary block. */
  before?: ReactNode;
  /** Widget rendered on the summary row before the summary. */
  summaryBefore?: ReactNode;
  /** Widget rendered on the summary row after the summary. */
  summaryAfter?: ReactNode;
  /** Widget rendered below the virtualized rows. */
  footer?: ReactNode;
  /** Widget rendered after the complete Plan. */
  after?: ReactNode;
}

const usePlanTree = (tree: PlanTree): PlanTreeState => {
  const subscribe = useMemo(() => tree.subscribe.bind(tree), [tree]);
  const snapshot = useMemo(() => tree.snapshot.bind(tree), [tree]);
  return useSyncExternalStore(subscribe, snapshot);
};

export function Plan(props: PlanProps): JSX.Element {
  const {
    tree,
    collapsible = false,
    before,
    summaryBefore,
    summaryAfter,
    footer,
    after,
  } = props;
  const { mode } = tree;
  const keyGlyphs = useKeyGlyphs();
  const borderStyle = useBorderStyle();
  const state = usePlanTree(tree);
  const { tasks, label, viewport, busy } = state;
  const {
    progress: { completed, total: workRows },
    collapsed,
    showControls,
    lineBudget,
    refs: { beforeRef, summaryRef, controlsRef, afterRef },
  } = usePlanPresentation({
    tree,
    state,
    busy,
    collapsible,
    hasFooter: footer !== undefined,
  });
  const {
    selectedView,
    hasOutput,
    virtual: virtualizing,
    budget: budgetRows,
    offset: shownOffset,
    hiddenBelow,
    planLines: visibleLines,
  } = usePlanViewport({
    tree,
    state,
    lineBudget,
    collapsible,
    collapsed,
  });

  // ── Summary and operation bar ─────────────────────────────────────────
  const operationProgress =
    mode === "apply" ? (
      <>
        {busy ? (
          <>
            <SpinnerGlyph color={theme.color.brand} />
            <Text> </Text>
          </>
        ) : null}
        <SectionHeading>{label}</SectionHeading>
        <Text tone="muted">
          {workRows === 0 ? "" : ` (${completed}/${workRows})`}
        </Text>
      </>
    ) : null;
  const planSummary =
    selectedView === "output" ? (
      <SectionHeading>Output</SectionHeading>
    ) : mode === "apply" ? (
      <ApplySummary label="Plan" rows={tree.progressRows} tasks={tasks} />
    ) : (
      <ReviewSummary label={label} summary={tree.summary} />
    );
  const planKeys: ReadonlyArray<readonly [string, string]> = [
    ...(!collapsed && viewport === "virtual"
      ? [[keyGlyphs.upDown, `scroll ${selectedView}`] as const]
      : []),
    ...(!collapsed && hasOutput
      ? [
          [
            keyGlyphs.leftRight,
            selectedView === "plan" ? "show output" : "show plan",
          ] as const,
        ]
      : []),
    ["p", collapsed ? "show plan/output" : "hide widget"],
    ["Ctrl+C", "exit"],
  ];

  return (
    <Box flexDirection="column">
      <Box ref={beforeRef} flexDirection="column">
        {before}
      </Box>
      {collapsed ? null : (
        <Box
          ref={summaryRef}
          marginBottom={1}
          borderStyle={borderStyle}
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.color.muted}
          borderDimColor
        >
          {summaryBefore}
          {planSummary}
          {summaryAfter}
        </Box>
      )}
      {collapsed ? null : (
        <PlanContent
          tree={tree}
          state={state}
          selectedView={selectedView}
          virtual={virtualizing}
          budget={budgetRows}
          offset={shownOffset}
          hiddenBelow={hiddenBelow}
          lines={visibleLines}
        />
      )}
      {showControls ? (
        <Box
          ref={controlsRef}
          marginTop={collapsed ? 0 : 1}
          borderStyle={borderStyle}
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.color.muted}
          borderDimColor
        >
          {collapsible ? (
            <KeyBar
              inline
              marginTop={0}
              before={operationProgress}
              keys={planKeys}
              after={footer}
              divider={mode === "apply" || footer !== undefined}
            />
          ) : mode === "apply" ? (
            <>
              {operationProgress}
              {footer}
            </>
          ) : (
            footer
          )}
        </Box>
      ) : null}
      <Box ref={afterRef} flexDirection="column">
        {after}
      </Box>
    </Box>
  );
}

function PlanContent(props: {
  readonly tree: PlanTree;
  readonly state: PlanTreeState;
  readonly selectedView: "plan" | "output";
  readonly virtual: boolean;
  readonly budget: number;
  readonly offset: number;
  readonly hiddenBelow: number;
  readonly lines: ReturnType<typeof usePlanViewport>["planLines"];
}) {
  const { tree, state, selectedView, virtual, budget, offset, hiddenBelow } =
    props;
  const glyphs = useGlyphs();
  const overflowUnit = virtual ? "lines" : "rows";
  return (
    <Box flexDirection="column">
      {offset > 0 ? (
        <Text tone="muted">
          {glyphs.overflowUp} {offset} earlier {overflowUnit}
        </Text>
      ) : null}
      {selectedView === "output" ? (
        <StackOutputs
          value={state.output}
          offset={offset}
          limit={virtual ? budget : undefined}
        />
      ) : props.lines === undefined ? (
        tree.rows.map((row) => (
          <PlanRowView
            key={row.key}
            row={row}
            mode={tree.mode}
            detailed={tree.detailed}
            state={state.tasks.get(
              row.type === "binding" ? row.hostKey : row.key,
            )}
            defaultMode={tree.defaultMode}
          />
        ))
      ) : (
        props.lines.map((line) =>
          line.kind === "row" ? (
            <PlanRowView
              key={line.row.key}
              row={line.row}
              mode={tree.mode}
              detailed={tree.detailed}
              includeYaml={false}
              state={state.tasks.get(
                line.row.type === "binding" ? line.row.hostKey : line.row.key,
              )}
              defaultMode={tree.defaultMode}
            />
          ) : line.kind === "yaml" ? (
            <YamlLine
              key={line.key}
              line={line.line}
              paddingLeft={line.paddingLeft}
            />
          ) : (
            <DetailLine key={line.key} paddingLeft={line.paddingLeft}>
              <Text tone="muted" dimColor>
                no declared property changes
              </Text>
            </DetailLine>
          ),
        )
      )}
      {hiddenBelow > 0 ? (
        <Text tone="muted">
          {glyphs.overflowDown} {hiddenBelow} more {overflowUnit}
        </Text>
      ) : null}
    </Box>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────

function PlanRowView(props: {
  row: PlanRow;
  mode: "review" | "apply";
  detailed: boolean;
  state: RowState | undefined;
  defaultMode: AlchemyPlan["defaultMode"];
  includeYaml?: boolean;
}): JSX.Element {
  const { row, mode, detailed, state, defaultMode, includeYaml = true } = props;
  const glyphs = useGlyphs();

  if (row.type === "namespace") {
    return <NamespaceRow id={row.id} depth={row.depth} action={row.action} />;
  }

  if (row.type === "binding") {
    if (mode === "review") {
      const style =
        row.action === "delete"
          ? { color: theme.color.muted, icon: "delete" as const }
          : namespaceStyle(row.action);
      return (
        <Row gap={1} paddingLeft={row.depth * 2}>
          <Text color={style.color}>{glyphs[style.icon]}</Text>
          <Text
            color={
              row.action === "delete" ? theme.color.muted : theme.color.info
            }
          >
            {row.id}
          </Text>
          {row.action === "delete" ? <Text tone="muted">(unbind)</Text> : null}
        </Row>
      );
    }
    // `state` is the HOST resource's row state: a binding is reconciled by
    // the resource that carries it, so it settles exactly when the host does.
    const hostStatus: ApplyStatus = state?.status ?? "pending";
    const status: ApplyStatus | "no change" =
      row.action === "noop" ? "no change" : hostStatus;
    const color =
      row.action === "delete" ? theme.color.muted : applyStatusColor(status);
    const bindingStatus =
      row.action !== "delete"
        ? status
        : hostStatus === "fail"
          ? "fail"
          : isTerminalStatus(hostStatus)
            ? "unbound"
            : isInProgress(hostStatus)
              ? "unbinding"
              : "unbind";
    return (
      <TaskRow
        spinning={status !== "no change" && isInProgress(hostStatus)}
        icon={
          status === "pending"
            ? glyphs.bullet
            : status === "fail"
              ? glyphs.error
              : glyphs.success
        }
        iconColor={color}
        label={
          <Text
            color={
              row.action === "delete" ? theme.color.muted : theme.color.info
            }
          >
            {row.id}
          </Text>
        }
        depth={row.depth}
      >
        <Text color={color}>{bindingStatus}</Text>
      </TaskRow>
    );
  }

  if (row.type === "task") {
    if (mode === "review") {
      const style = namespaceStyle(row.action);
      return (
        <TaskRow
          icon={glyphs[style.icon]}
          iconColor={style.color}
          label={row.id}
          depth={row.depth}
        >
          <Text color={theme.color.info}>[action]</Text>
        </TaskRow>
      );
    }
    const status: ApplyStatus =
      state?.status ?? (row.action === "noop" ? "ran" : "pending");
    const color = applyStatusColor(status);
    return (
      <TaskRow
        spinning={isInProgress(status)}
        icon={taskIcon(row.action, status, glyphs)}
        iconColor={color}
        label={row.id}
        detail={rowDetail(status, state?.message)}
        depth={row.depth}
      >
        <Text color={color}>{taskLabel(row.action, status)}</Text>
        <Text color={theme.color.info} dimColor>
          [action]
        </Text>
        {state?.elapsedMs === undefined ? null : (
          <Text tone="muted">({formatElapsed(state.elapsedMs)})</Text>
        )}
      </TaskRow>
    );
  }

  // Resource row.
  const modeNote = formatModeNote({
    mode: row.providerMode,
    priorMode: row.fromProviderMode,
    defaultMode,
  });
  const showYaml =
    includeYaml && (detailed || row.propertyYaml?.kind === "drift");
  const yaml = showYaml ? (
    row.propertyYaml === undefined ? (
      row.action === "update" ||
      row.action === "adopted" ||
      row.action === "replace" ? (
        <DetailLine paddingLeft={row.depth * 2 + 2}>
          <Text tone="muted" dimColor>
            no declared property changes
          </Text>
        </DetailLine>
      ) : null
    ) : (
      row.propertyYaml.lines.map((line, index) => (
        <YamlLine
          key={`${index}:${line}`}
          line={line}
          paddingLeft={row.depth * 2 + 2}
        />
      ))
    )
  ) : null;

  if (mode === "review") {
    const style = namespaceStyle(row.action);
    return (
      <Box flexDirection="column" marginTop={showYaml ? 1 : 0}>
        <TaskRow
          icon={glyphs[style.icon]}
          iconColor={style.color}
          label={
            <Text color={row.action === "noop" ? undefined : style.color}>
              {row.id}
            </Text>
          }
          depth={row.depth}
          detail={row.detail}
        >
          {modeNote && <Text tone="muted">({modeNote})</Text>}
          {row.id !== row.resourceType ? (
            <Text tone="muted">({row.resourceType})</Text>
          ) : null}
        </TaskRow>
        {yaml}
      </Box>
    );
  }

  const rowState = state ?? initialResourceState(row);
  const displayStatus = resourceDisplayStatus(row, rowState.status);
  const color = applyStatusColor(displayStatus);
  return (
    <Box flexDirection="column">
      <TaskRow
        spinning={isInProgress(rowState.status)}
        icon={
          rowState.status === "pending"
            ? glyphs.bullet
            : rowState.status === "fail"
              ? glyphs.error
              : rowState.status === "adopted"
                ? glyphs.adopt
                : rowState.status === "orphaned"
                  ? glyphs.orphan
                  : glyphs.success
        }
        iconColor={color}
        label={
          <>
            {row.action === "orphaned" ? (
              <Text tone="muted">{row.id}</Text>
            ) : (
              row.id
            )}
            {row.id !== row.resourceType ? (
              <Text tone="muted"> ({row.resourceType})</Text>
            ) : null}
            {row.detail ? <Text tone="muted"> · {row.detail}</Text> : null}
          </>
        }
        detail={rowDetail(rowState.status, rowState.message)}
        depth={row.depth}
      >
        {modeNote ? <Text tone="muted">({modeNote})</Text> : null}
        <Text color={color}>{displayStatus}</Text>
        {rowState.elapsedMs === undefined ? null : (
          <Text tone="muted">({formatElapsed(rowState.elapsedMs)})</Text>
        )}
      </TaskRow>
      {yaml}
    </Box>
  );
}

// ── Headers ───────────────────────────────────────────────────────────────

function ReviewSummary(props: {
  label: string;
  summary: PlanSummaryCounts;
}): JSX.Element {
  const { counts, taskCounts, bindingChanges } = props.summary;
  const parts = [
    ...(
      ["create", "update", "adopted", "delete", "orphaned", "replace"] as const
    )
      .filter((action) => counts[action] > 0)
      .map((action) => ({
        key: action,
        label: `${counts[action]} to ${action}`,
        color: namespaceStyle(action).color,
      })),
    ...(counts.noop > 0
      ? [
          {
            key: "noop",
            label: `${counts.noop} no change`,
            color: theme.color.muted,
          },
        ]
      : []),
    ...(taskCounts.run > 0
      ? [
          {
            key: "run",
            label: `${taskCounts.run} to run`,
            color: namespaceStyle("run").color,
          },
        ]
      : []),
    ...(taskCounts.delete > 0
      ? [
          {
            key: "drop",
            label: `${taskCounts.delete} to drop`,
            color: namespaceStyle("delete").color,
          },
        ]
      : []),
    ...(taskCounts.noop > 0
      ? [
          {
            key: "task-noop",
            label: `${taskCounts.noop} tasks no change`,
            color: theme.color.muted,
          },
        ]
      : []),
    ...(bindingChanges > 0
      ? [
          {
            key: "bindings",
            label: `${bindingChanges} binding changes`,
            color: theme.color.info,
          },
        ]
      : []),
  ];
  return (
    <>
      <SectionHeading>{props.label}</SectionHeading>
      <Text tone="muted"> · </Text>
      {parts.length === 0 ? (
        <Text tone="muted">no changes</Text>
      ) : (
        parts.map((part, index) => (
          <Box key={part.key}>
            {index === 0 ? null : <Text tone="muted"> · </Text>}
            <Text color={part.color}>{part.label}</Text>
          </Box>
        ))
      )}
    </>
  );
}

const applySummaryOrder: readonly (ApplyStatus | "no change")[] = [
  "fail",
  "attaching",
  "post-attach",
  "pre-creating",
  "creating",
  "creating replacement",
  "updating",
  "adopting",
  "deleting",
  "orphaning",
  "replacing",
  "running",
  "pending",
  "created",
  "updated",
  "adopted",
  "deleted",
  "orphaned",
  "replaced",
  "ran",
  "skipped",
  "no change",
];

function ApplySummary(props: {
  label: string;
  rows: readonly PlanRow[];
  tasks: ReadonlyMap<string, RowState>;
}): JSX.Element {
  const counts = new Map<ApplyStatus | "no change", number>();
  for (const row of props.rows) {
    const status = props.tasks.get(row.key)?.status ?? "pending";
    const displayStatus = row.action === "noop" ? "no change" : status;
    counts.set(displayStatus, (counts.get(displayStatus) ?? 0) + 1);
  }
  const parts = applySummaryOrder
    .filter((status) => counts.has(status))
    .map((status) => ({
      status,
      count: counts.get(status) ?? 0,
    }));

  return (
    <>
      <SectionHeading>{props.label}</SectionHeading>
      <Text tone="muted"> · </Text>
      {parts.length === 0 ? (
        <Text tone="muted">no resources</Text>
      ) : (
        parts.map((part, index) => (
          <Box key={part.status}>
            {index === 0 ? null : <Text tone="muted"> · </Text>}
            <Text color={applyStatusColor(part.status)}>
              {part.count} {part.status}
            </Text>
          </Box>
        ))
      )}
    </>
  );
}

// ── Status helpers ────────────────────────────────────────────────────────

const resourceDisplayStatus = (
  row: ResourceRow,
  status: ApplyStatus,
): ApplyStatus | "no change" =>
  row.action === "noop" && (status === "created" || status === "updated")
    ? "no change"
    : status;

const taskLabel = (action: ActionVerb, status: ApplyStatus): string =>
  action === "delete"
    ? status === "deleted" || status === "orphaned"
      ? status
      : "drop"
    : status === "ran"
      ? action === "noop"
        ? "skip"
        : "ran"
      : status === "running"
        ? "running"
        : status === "fail"
          ? "fail"
          : action === "noop"
            ? "skip"
            : "run";

/** Static glyph for a task row; the running state renders a spinner instead. */
function taskIcon(
  action: ActionVerb,
  status: ApplyStatus,
  glyphs: ReturnType<typeof useGlyphs>,
): string {
  if (status === "fail") return glyphs.error;
  if (status === "skipped") return glyphs.bullet;
  if (status === "ran")
    return action === "noop" ? glyphs.bullet : glyphs.success;
  if (status === "deleted" || status === "orphaned") return glyphs.success;
  if (action === "delete") return glyphs[actionStyle.delete.icon];
  if (action === "noop") return glyphs[actionStyle.noop.icon];
  return glyphs[actionStyle.run.icon];
}

function YamlLine({
  line,
  paddingLeft,
}: {
  readonly line: string;
  readonly paddingLeft: number;
}) {
  const change = matchYamlChange(line);
  const content = change?.content ?? line;
  const key = matchYamlKey(content);
  const removed = change?.marker === "-";
  const added = change?.marker === "+";
  return (
    <DetailLine
      paddingLeft={paddingLeft}
      backgroundColor={
        removed
          ? theme.color.diffRemoveBackground
          : added
            ? theme.color.diffAddBackground
            : undefined
      }
    >
      <Box width={2} flexShrink={0}>
        <Text color={removed ? theme.color.danger : theme.color.success}>
          {change?.marker ?? " "}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">
          {key === undefined ? (
            content
          ) : (
            <>
              {key.indent}
              <Text color={change === undefined ? theme.color.info : undefined}>
                {key.key}
              </Text>
              {key.value}
            </>
          )}
        </Text>
      </Box>
    </DetailLine>
  );
}

function DetailLine({
  paddingLeft,
  backgroundColor,
  children,
}: {
  readonly paddingLeft: number;
  readonly backgroundColor?: string;
  readonly children: ReactNode;
}) {
  const borderStyle = useBorderStyle();
  return (
    <Box paddingLeft={paddingLeft} width="100%">
      <Box
        width="100%"
        paddingLeft={1}
        borderStyle={borderStyle}
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.color.muted}
        borderDimColor
        backgroundColor={backgroundColor}
      >
        {children}
      </Box>
    </Box>
  );
}

// ── Static convenience ────────────────────────────────────────────────────
