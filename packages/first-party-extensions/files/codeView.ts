/**
 * Files row 18, read-only half: files the editor cannot open (past the edit
 * bound, binary-adjacent, non-UTF-8) render through the host's
 * `ClientHost.codeView.File` — the native read-only source preview with
 * shared-pool highlighting and virtualization — when the host offers it.
 * Hosts without the member keep the panel's own `<pre>`. Editable files use
 * the native host editor on compatible clients and remain read-only otherwise.
 */
import {
  resolveCodeView,
  resolveCodeEditor,
  type ClientHost,
  type CodeViewFileProps,
  type CodeViewEditorProps,
} from "@t3tools/extension-sdk/environment";
import { createElement, type ReactNode } from "react";

/** The read-only file body: the host's view when offered, else the panel's own. */
export function ReadOnlyFileBody(props: {
  readonly host: Pick<ClientHost, "codeView">;
  readonly path: string;
  readonly contents: string;
  /** Null when `t3.ui/preferences` is unavailable: the host's own setting applies. */
  readonly wordWrap: boolean | null;
  readonly reveal: { readonly line: number; readonly requestId: number } | null;
  readonly renderFallback: () => ReactNode;
}): ReactNode {
  const codeView = resolveCodeView(props.host);
  if (codeView === null) return props.renderFallback();
  const file: CodeViewFileProps = {
    path: props.path,
    contents: props.contents,
    ...(props.wordWrap === null ? {} : { wordWrap: props.wordWrap }),
    ...(props.reveal === null ? {} : { reveal: props.reveal }),
  };
  // Same frame as the own `<pre>`: a top rule, filling the panel's column.
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
      },
    },
    createElement(codeView.File, file),
  );
}

export function EditableFileBody(
  props: Omit<CodeViewEditorProps, "wordWrap" | "reveal"> & {
    readonly host: ClientHost;
    readonly wordWrap: boolean | null;
    readonly reveal: NonNullable<CodeViewFileProps["reveal"]> | null;
    readonly renderFallback: () => ReactNode;
  },
): ReactNode {
  const Editor = resolveCodeEditor(props.host);
  if (Editor === null) {
    return createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
      createElement(
        "div",
        { role: "status", style: { padding: "6px 10px", fontSize: 12 } },
        "Native code editor unavailable on this client — read only",
      ),
      createElement(ReadOnlyFileBody, props),
    );
  }
  return createElement(Editor, {
    documentId: props.documentId,
    path: props.path,
    contents: props.contents,
    onChange: props.onChange,
    ...(props.onSelectionChange === undefined
      ? {}
      : { onSelectionChange: props.onSelectionChange }),
    ...(props.wordWrap === null ? {} : { wordWrap: props.wordWrap }),
    ...(props.reveal === null ? {} : { reveal: props.reveal }),
  });
}
