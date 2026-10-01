/**
 * D10: highlighting and virtualization are host-rendered through the
 * optional `ClientHost.codeView` member (p11a "The renderer decision").
 * The package's own rows stay the renderer when the host has no member
 * (mobile, older hosts) and while line comments are open — version 1 of the
 * member has no line annotations, so D9 comments live on own rows until a
 * version 2 adds them.
 */
import {
  resolveCodeView,
  type ClientCodeView,
  type ClientHost,
  type CodeViewDiffProps,
} from "@t3tools/extension-sdk/environment";
import { createElement, type ReactNode } from "react";
import type { DiffFileRow, DiffLayout } from "./viewModel.js";

export type DiffRenderer =
  | { readonly kind: "host"; readonly codeView: ClientCodeView }
  | { readonly kind: "rows"; readonly reason: "host-unavailable" | "commenting" };

/** Picks the renderer for the file diffs. */
export function diffRenderer(
  host: Pick<ClientHost, "codeView">,
  commenting: boolean,
): DiffRenderer {
  const codeView = resolveCodeView(host);
  if (codeView === null) return { kind: "rows", reason: "host-unavailable" };
  return commenting ? { kind: "rows", reason: "commenting" } : { kind: "host", codeView };
}

export const DIFF_FILE_ACTIONS = [
  { id: "open", label: "Open" },
  { id: "copy", label: "Copy path" },
] as const;
export type DiffFileActionId = (typeof DIFF_FILE_ACTIONS)[number]["id"];

/**
 * The host view's props for the rows the panel already parsed. The panel's
 * state stays keyed by row key; the member speaks paths, so both directions
 * are mapped here.
 */
export function hostDiffProps(options: {
  readonly patch: string;
  readonly files: readonly DiffFileRow[];
  readonly collapsedKeys: ReadonlySet<string>;
  readonly layout: DiffLayout;
  readonly wrap: boolean;
  readonly reveal: { readonly key: string; readonly requestId: number } | null;
  readonly onToggleCollapsed: (key: string) => void;
  readonly onFileAction: (action: DiffFileActionId, row: DiffFileRow) => void;
  /** Absent where full-file contents cannot be served (turn diffs). */
  readonly loadContents?: (
    row: DiffFileRow,
  ) => Promise<{ oldContents: string; newContents: string }>;
}): CodeViewDiffProps {
  const { files, collapsedKeys, reveal, loadContents } = options;
  const byPath = new Map(files.map((row) => [row.path, row]));
  const revealRow = reveal === null ? undefined : files.find((row) => row.key === reveal.key);
  return {
    patch: options.patch,
    layout: options.layout,
    wordWrap: options.wrap,
    collapsedPaths: files.filter((row) => collapsedKeys.has(row.key)).map((row) => row.path),
    onToggleCollapsed: (path) => {
      const row = byPath.get(path);
      if (row) options.onToggleCollapsed(row.key);
    },
    fileActions: DIFF_FILE_ACTIONS,
    onFileAction: (actionId, path) => {
      const row = byPath.get(path);
      const action = DIFF_FILE_ACTIONS.find((candidate) => candidate.id === actionId);
      if (row && action) options.onFileAction(action.id, row);
    },
    ...(revealRow && reveal
      ? { reveal: { path: revealRow.path, requestId: reveal.requestId } }
      : {}),
    ...(loadContents
      ? {
          loadContents: (path: string) => {
            const row = byPath.get(path);
            return row
              ? loadContents(row)
              : Promise.reject(new Error(`${path} is not part of this diff`));
          },
        }
      : {}),
  };
}

/** Host view when offered, else the panel's own rows. */
export function DiffFileBodies(props: {
  readonly renderer: DiffRenderer;
  readonly renderHostProps: () => CodeViewDiffProps;
  readonly renderRows: () => ReactNode;
}): ReactNode {
  return props.renderer.kind === "host"
    ? createElement(props.renderer.codeView.Diff, props.renderHostProps())
    : props.renderRows();
}
