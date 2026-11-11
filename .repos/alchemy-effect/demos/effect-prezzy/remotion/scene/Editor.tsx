import type { ReactNode } from "react";
import { interpolate } from "remotion";
import { TITLE_BAR, WINDOW, type SceneCapture } from "../../shared/types.ts";
import { mono, sans } from "../fonts.ts";
import { vscode } from "../theme.ts";
import { Window } from "./Desktop.tsx";
import { languageLabel } from "./highlight.ts";
import type { PatchView, Row } from "./patch.ts";
import { TIMING, type SceneSchedule } from "./schedule.ts";

const CODE = { fontSize: 21, lineHeight: 32, charWidth: 21 * 0.6 } as const;
const UI = 15;
const ACTIVITY_BAR = 52;
const SIDEBAR = 270;
const TABS = 42;
const BREADCRUMBS = 28;
const STATUS = 28;
const GUTTER = 76;

interface EditorState {
  files: string[];
  tabs: string[];
  active: string | undefined;
  view: PatchView | undefined;
  /** Frames into the current patch (Infinity: settled). */
  local: number;
  /** Scroll position (in rows) to animate from, and to. */
  scrollFrom: number;
  scrollTo: number;
}

const VISIBLE_ROWS =
  Math.floor((WINDOW.height - TITLE_BAR - TABS - BREADCRUMBS - STATUS) / CODE.lineHeight) - 1;

/** Keep the change in view: its top a few rows down, its end on screen when it fits. */
const scrollFor = (view: PatchView, kind: "patch" | "open") => {
  if (kind === "open") return 0;
  const max = Math.max(0, view.rows.length - VISIBLE_ROWS);
  // The whole edit if it fits; otherwise its biggest hunk (e.g. the new code, not the imports).
  const [first, last] =
    view.last - view.first <= VISIBLE_ROWS - 6 ? [view.first, view.last] : view.main;
  let top = first - 4;
  if (last - top > VISIBLE_ROWS - 3) top = Math.min(first - 2, last - VISIBLE_ROWS + 3);
  return Math.max(0, Math.min(top, max));
};

const editorState = (capture: SceneCapture, plan: SceneSchedule, frame: number): EditorState => {
  const files = new Set(capture.start.files);
  // Start each scene with the few most recent tabs, like closing old ones between chapters.
  const tabs = capture.start.tabs.map((t) => t.file).slice(-4);
  let active = capture.start.active;
  let view = active ? plan.initialViews[active] : undefined;
  let local = Infinity;
  const scrolls = new Map<string, number>();
  let scrollFrom = 0;
  let scrollTo = 0;
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    if (beat.kind === "editor.delete") {
      files.delete(beat.file);
      const at = tabs.indexOf(beat.file);
      if (at >= 0) tabs.splice(at, 1);
      if (active === beat.file) {
        active = tabs.at(-1);
        view = undefined;
      }
      local = Infinity;
      continue;
    }
    if (beat.kind !== "editor.open" && beat.kind !== "editor.edit" && beat.kind !== "editor.patch")
      continue;
    if (!tabs.includes(beat.file)) tabs.push(beat.file);
    active = beat.file;
    files.add(beat.file);
    view = segment.view;
    local = beat.kind === "editor.open" ? Infinity : frame - segment.from - segment.switchFrames;
    scrollFrom = scrolls.get(beat.file) ?? 0;
    scrollTo = view ? scrollFor(view, beat.kind === "editor.open" ? "open" : "patch") : 0;
    scrolls.set(beat.file, scrollTo);
  }
  return { files: [...files].sort(), tabs, active, view, local, scrollFrom, scrollTo };
};

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

const buildTree = (files: string[]): TreeNode[] => {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    let node = root;
    const parts = file.split("/");
    parts.forEach((name, i) => {
      const nodePath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path: nodePath, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) =>
        a.children.length > 0 === b.children.length > 0
          ? a.name.localeCompare(b.name)
          : a.children.length > 0
            ? -1
            : 1,
      )
      .map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children);
};

const FileIcon = ({ name }: { name: string }) => {
  const ext = name.split(".").pop();
  const [label, color] =
    ext === "ts"
      ? ["TS", "#3178c6"]
      : ext === "tsx"
        ? ["⚛", "#4fc1ff"]
        : ext === "json"
          ? ["{}", "#cbcb41"]
          : ext === "css"
            ? ["#", "#56b6f7"]
            : ext === "html"
              ? ["<>", "#e37933"]
              : ["≡", "#9d9d9d"];
  return (
    <span
      style={{
        width: 22,
        display: "inline-block",
        textAlign: "center",
        color,
        fontFamily: mono,
        fontSize: label.length > 1 ? 11 : 14,
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  );
};

const Chevron = ({ open = true }: { open?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" style={{ flex: "none" }}>
    <path
      d={open ? "M4 6 L8 10 L12 6" : "M6 4 L10 8 L6 12"}
      stroke={vscode.fgMuted}
      strokeWidth="1.4"
      fill="none"
    />
  </svg>
);

const Tree = ({ nodes, depth, active }: { nodes: TreeNode[]; depth: number; active?: string }) => (
  <>
    {nodes.map((node) => (
      <div key={node.path}>
        <div
          style={{
            height: 26,
            display: "flex",
            alignItems: "center",
            gap: 4,
            paddingLeft: 12 + depth * 14,
            background: node.path === active ? vscode.listActive : undefined,
            outline: node.path === active ? `1px solid ${vscode.accent}` : undefined,
            outlineOffset: -1,
            color: vscode.fg,
          }}
        >
          {node.children.length > 0 ? <Chevron /> : <span style={{ width: 16 }} />}
          {node.children.length > 0 ? null : <FileIcon name={node.name} />}
          <span>{node.name}</span>
        </div>
        {node.children.length > 0 ? (
          <Tree nodes={node.children} depth={depth + 1} active={active} />
        ) : null}
      </div>
    ))}
  </>
);

const ActivityIcon = ({ children, active }: { children: ReactNode; active?: boolean }) => (
  <div
    style={{
      height: 56,
      display: "grid",
      placeItems: "center",
      borderLeft: `2px solid ${active ? vscode.fg : "transparent"}`,
      opacity: active ? 1 : 0.5,
    }}
  >
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke={vscode.fg}
      strokeWidth="1.5"
    >
      {children}
    </svg>
  </div>
);

const ActivityBar = () => (
  <div
    style={{
      width: ACTIVITY_BAR,
      background: vscode.chromeBg,
      borderRight: `1px solid ${vscode.border}`,
    }}
  >
    <ActivityIcon active>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </ActivityIcon>
    <ActivityIcon>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </ActivityIcon>
    <ActivityIcon>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8M18 10c0 4-6 3-11 6" />
    </ActivityIcon>
    <ActivityIcon>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </ActivityIcon>
  </div>
);

/** Merge neighbouring characters that share a colour into spans. */
const Line = ({ row }: { row: Row }) => {
  const spans: { text: string; color: string }[] = [];
  for (let i = 0; i < row.text.length; i++) {
    const color = row.colors[i] || vscode.fg;
    const last = spans.at(-1);
    if (last && last.color === color) last.text += row.text[i];
    else spans.push({ text: row.text[i]!, color });
  }
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} style={{ color: span.color }}>
          {span.text}
        </span>
      ))}
    </>
  );
};

const ADD_BG = "rgba(46, 160, 67, 0.22)";
const ADD_BAR = "#2ea043";
const DEL_BG = "rgba(248, 81, 73, 0.2)";
const DEL_BAR = "#f85149";

const Code = ({ state }: { state: EditorState }) => {
  const view = state.view!;
  const { show } = TIMING.patch;
  const t = state.local;
  const ease = (x: number) => 1 - (1 - x) ** 3;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const hasDel = view.rows.some((r) => r.kind === "del");
  const addedTotal = view.rows.filter((r) => r.kind === "add").length;
  // Removed lines collapse first.
  const p =
    t === Infinity || !hasDel
      ? 1
      : ease(interpolate(t, [show, show + TIMING.patchDelete], [0, 1], clamp));
  // Then added lines stream in one at a time, each at full size the moment it appears.
  const streamFrom = show + (hasDel ? TIMING.patchDelete : 0);
  const perLine = addedTotal
    ? Math.min(TIMING.patchPerLine, TIMING.patchStreamMax / addedTotal)
    : 0;
  const addIndex = new Map<Row, number>();
  view.rows.forEach((r) => {
    if (r.kind === "add") addIndex.set(r, addIndex.size);
  });
  const shown = (row: Row) =>
    t === Infinity || t >= streamFrom + (addIndex.get(row) ?? 0) * perLine + perLine ? 1 : 0;
  const scroll =
    t === Infinity
      ? state.scrollTo
      : interpolate(t, [0, show], [state.scrollFrom, state.scrollTo], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        });
  const heightOf = (row: Row) => (row.kind === "del" ? 1 - p : row.kind === "add" ? shown(row) : 1);
  // Pixel offset of the fractional scroll row, using the rows' current heights.
  let offset = 0;
  for (let i = 0; i < Math.floor(scroll) && i < view.rows.length; i++)
    offset += heightOf(view.rows[i]!);
  offset += (scroll % 1) * heightOf(view.rows[Math.floor(scroll)] ?? view.rows[0]!);
  const settled = t === Infinity;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: mono,
        fontSize: CODE.fontSize,
        lineHeight: `${CODE.lineHeight}px`,
        whiteSpace: "pre",
        paddingTop: 6,
        overflow: "hidden",
      }}
    >
      <div style={{ transform: `translateY(${-offset * CODE.lineHeight}px)` }}>
        {view.rows.map((row, i) => {
          const h = heightOf(row);
          if (h <= 0.001) return null;
          const added = row.kind === "add" && !settled;
          const removed = row.kind === "del";
          return (
            <div
              key={i}
              style={{
                height: CODE.lineHeight * h,
                overflow: "hidden",
                display: "flex",
                position: "relative",
                background: added ? ADD_BG : removed ? DEL_BG : undefined,
                boxShadow: added
                  ? `inset 3px 0 ${ADD_BAR}`
                  : removed
                    ? `inset 3px 0 ${DEL_BAR}`
                    : undefined,
                // Removed lines fade as they collapse; added lines appear whole.
                opacity: row.kind === "del" ? (1 - p) ** 2 : 1,
              }}
            >
              <span
                style={{
                  width: GUTTER,
                  paddingRight: 24,
                  textAlign: "right",
                  color: added ? "#7ee787" : removed ? "#ffa198" : vscode.lineNumber,
                  flex: "none",
                }}
              >
                {row.kind === "del" ? "−" : row.number}
              </span>
              <span
                style={{
                  textDecoration: removed && p > 0 ? "line-through" : undefined,
                  textDecorationColor: DEL_BAR,
                }}
              >
                <Line row={row} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const Editor = ({
  capture,
  plan,
  frame,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
}) => {
  const state = editorState(capture, plan, frame);
  const title = state.active
    ? `${state.active.split("/").pop()} — ${capture.project}`
    : capture.project;
  return (
    <Window title={title} background={vscode.editorBg}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          fontFamily: sans,
          fontSize: UI,
        }}
      >
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <ActivityBar />
          <div
            style={{
              width: SIDEBAR,
              background: vscode.chromeBg,
              borderRight: `1px solid ${vscode.border}`,
              color: vscode.fg,
            }}
          >
            <div
              style={{
                height: 40,
                display: "flex",
                alignItems: "center",
                padding: "0 20px",
                fontSize: 13,
                letterSpacing: 0.6,
                color: vscode.fgMuted,
              }}
            >
              EXPLORER
            </div>
            <div
              style={{
                height: 28,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 6px",
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: 0.4,
              }}
            >
              <Chevron />
              {capture.project.toUpperCase()}
            </div>
            <Tree nodes={buildTree(state.files)} depth={0} active={state.active} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div
              style={{
                height: TABS,
                display: "flex",
                background: vscode.chromeBg,
                borderBottom: `1px solid ${vscode.border}`,
              }}
            >
              {state.tabs.map((tab) => {
                const active = tab === state.active;
                return (
                  <div
                    key={tab}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0 18px 0 12px",
                      background: active ? vscode.editorBg : vscode.chromeBg,
                      borderTop: `2px solid ${active ? vscode.tabActiveBorder : "transparent"}`,
                      borderRight: `1px solid ${vscode.border}`,
                      color: active ? "#ffffff" : vscode.fgMuted,
                      marginBottom: active ? -1 : 0,
                    }}
                  >
                    <FileIcon name={tab} />
                    {tab.split("/").pop()}
                  </div>
                );
              })}
            </div>
            <div
              style={{
                height: BREADCRUMBS,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 20px",
                color: vscode.fgMuted,
                fontSize: 14,
              }}
            >
              {(state.active ?? "").split("/").map((part, i, all) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {i === all.length - 1 ? <FileIcon name={part} /> : null}
                  {part}
                  {i < all.length - 1 ? <span>›</span> : null}
                </span>
              ))}
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {state.view ? <Code state={state} /> : null}
            </div>
          </div>
        </div>
        <div
          style={{
            height: STATUS,
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "0 14px",
            background: vscode.chromeBg,
            borderTop: `1px solid ${vscode.border}`,
            color: vscode.fgMuted,
            fontSize: 13,
          }}
        >
          <span>⎇ main</span>
          <span>⊗ 0 ⚠ 0</span>
          <span style={{ marginLeft: "auto" }}>Spaces: 2</span>
          <span>UTF-8</span>
          <span>{state.active ? languageLabel(state.active) : ""}</span>
        </div>
      </div>
    </Window>
  );
};
