import {
  cloneFileDiffMetadata,
  hydratePartialDiff,
  parseDiffFromFile,
  type CodeViewCreateEditorOptions,
  type CodeViewItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  readReviewDraft,
  reviewEditKey,
  reviewPublishKey,
  useReviewEdits,
  type ReviewEditTarget,
} from "./ReviewEdits";
import { StyledDiffCodeView, type StyledDiffCodeViewProps } from "./StyledDiffCodeView";

export type ReviewEditTargetResolver = (filePath: string) => ReviewEditTarget | null;

interface PreparedFile {
  key: string;
  fileDiff: FileDiffMetadata;
  pullRequestUrl: string | undefined;
  version: number | undefined;
}

export function EditableDiffCodeView<LAnnotation>({
  items,
  options,
  editing,
  viewerKey,
  renderHeaderFilenameSuffix,
  renderHeaderMetadata,
  ...props
}: Omit<StyledDiffCodeViewProps<LAnnotation>, "items" | "initialItems"> & {
  items: readonly CodeViewItem<LAnnotation>[];
  editing?: ReviewEditTargetResolver;
  viewerKey?: string;
}) {
  const edits = useReviewEdits();
  const [prepared, setPrepared] = useState<ReadonlyMap<string, PreparedFile>>(new Map());
  const preparing = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  const focusRequest = useRef<{ key: string; line: number; character: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editItems = useMemo<readonly CodeViewItem<LAnnotation>[]>(
    () =>
      items.map((item) => {
        if (item.type !== "diff" || !edits) return item;
        const target = editing?.(resolveFileDiffPath(item.fileDiff));
        if (!target) return item;
        const key = reviewEditKey(target);
        const draft = edits.drafts.get(key);
        if (!draft) return item;
        const file = prepared.get(item.id);
        if (target.readOnly) {
          const source = file?.key === key ? file.fileDiff : item.fileDiff;
          const readonlyDiff = source.isPartial
            ? null
            : parseDiffFromFile(
                source.type === "new"
                  ? null
                  : {
                      name: source.prevName ?? source.name,
                      contents: source.deletionLines.join(""),
                    },
                { name: source.name, contents: draft.contents },
              );
          if (!readonlyDiff?.hunks.length) {
            return {
              id: item.id,
              type: "file",
              file: { name: source.name, contents: draft.contents },
              ...(item.collapsed === undefined ? {} : { collapsed: item.collapsed }),
              edit: false,
              version: (item.version ?? 0) + 1,
            };
          }
          return {
            ...item,
            fileDiff: readonlyDiff,
            edit: false,
            version: (item.version ?? 0) + 1,
          };
        }
        if (
          !file ||
          key !== file.key ||
          target.pullRequestUrl !== file.pullRequestUrl ||
          item.version !== file.version
        )
          return item;
        const publishing =
          target.pullRequestUrl &&
          edits.publishing.has(reviewPublishKey(target.environmentId, target.pullRequestUrl));
        return {
          ...item,
          fileDiff: file.fileDiff,
          edit: !publishing,
          version: (item.version ?? 0) + 1,
        };
      }),
    [editing, edits, items, prepared],
  );
  const focus = edits?.focus;
  const createEditor = useCallback(
    (editorOptions: CodeViewCreateEditorOptions<LAnnotation>) => {
      let key: string | null = null;
      return new Editor<LAnnotation>({
        ...editorOptions,
        onAttach: (editor) => {
          const file = editor.getFile();
          const target = file && editing?.(resolveFileDiffPath(file));
          if (!target || target.readOnly) return;
          key = reviewEditKey(target);
          const request = focusRequest.current;
          if (request?.key !== key) return;
          focusRequest.current = null;
          const position = { line: request.line, character: request.character };
          editor.setSelections([{ start: position, end: position, direction: "none" }]);
          editor.focus({ preventScroll: true });
        },
        onFocus: () => {
          if (key) focus?.(key);
        },
        onBlur: () => focus?.(null),
      });
    },
    [editing, focus],
  );

  const prepare = (item: CodeViewItem<LAnnotation>, source?: FileDiffMetadata) => {
    if (item.type !== "diff" || !editing || !edits || item.fileDiff.type === "deleted") return;
    const filePath = resolveFileDiffPath(item.fileDiff);
    const target = editing(filePath);
    if (
      !target ||
      target.readOnly ||
      isWorkspaceAudioPreviewPath(filePath) ||
      isWorkspaceImagePreviewPath(filePath) ||
      isWorkspaceVideoPreviewPath(filePath)
    )
      return;
    const key = reviewEditKey(target);
    const cached = prepared.get(item.id);
    if (cached?.key === key && cached.version === item.version) return;
    const requestKey = JSON.stringify([key, item.id, item.version]);
    const pending = preparing.current.get(requestKey);
    if (pending) return pending;
    const promise = (async () => {
      const diff = source ?? item.fileDiff;
      let fileDiff =
        diff.isPartial && options?.loadDiffFiles
          ? hydratePartialDiff("clone", diff, await options.loadDiffFiles(diff))
          : cloneFileDiffMetadata(diff);
      if (fileDiff.isPartial) throw new Error("The full file must be available before editing.");
      const fresh = await readReviewDraft(
        target,
        target.pullRequestUrl ? fileDiff.additionLines.join("") : undefined,
      );
      if (!mounted.current) return;
      const draft = edits.begin(fresh);
      if (fileDiff.additionLines.join("") !== draft.contents) {
        fileDiff = parseDiffFromFile(
          fileDiff.type === "new"
            ? null
            : {
                name: fileDiff.prevName ?? fileDiff.name,
                contents: fileDiff.deletionLines.join(""),
              },
          { name: fileDiff.name, contents: draft.contents },
        );
        focusRequest.current = null;
      }
      setPrepared((previous) =>
        new Map(previous).set(item.id, {
          key,
          fileDiff,
          pullRequestUrl: target.pullRequestUrl,
          version: item.version,
        }),
      );
    })().finally(() => preparing.current.delete(requestKey));
    preparing.current.set(requestKey, promise);
    return promise;
  };

  return (
    <StyledDiffCodeView<LAnnotation>
      {...props}
      key={viewerKey}
      items={editItems}
      createEditor={createEditor}
      renderHeaderMetadata={(item) =>
        renderHeaderMetadata?.(
          item.type === "file" ? (items.find((source) => source.id === item.id) ?? item) : item,
        )
      }
      onItemEditChange={(item, file) => {
        const entry = prepared.get(item.id);
        if (entry) edits?.change(entry.key, file.contents);
      }}
      options={{
        ...options,
        onPostRender: (_node, _instance, _phase, context) => {
          if (context.type !== "diff" || context.item.edit || edits?.publishing.size) return;
          void prepare(context.item, context.instance.fileDiff)?.catch(() => {});
        },
        onLineClick: (line, context) => {
          if (
            !edits ||
            !editing ||
            context.type !== "diff" ||
            line.type !== "diff-line" ||
            line.numberColumn ||
            line.annotationSide === "deletions" ||
            context.item.fileDiff.type === "deleted" ||
            context.item.edit
          )
            return;
          const event = line.event;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          const filePath = resolveFileDiffPath(context.item.fileDiff);
          const target = editing(filePath);
          if (
            !target ||
            target.readOnly ||
            isWorkspaceAudioPreviewPath(filePath) ||
            isWorkspaceImagePreviewPath(filePath) ||
            isWorkspaceVideoPreviewPath(filePath)
          )
            return;
          const key = reviewEditKey(target);
          const root = line.lineElement.getRootNode();
          const caret = document.caretPositionFromPoint?.(
            event.clientX,
            event.clientY,
            root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined,
          );
          let character = 0;
          if (caret && line.lineElement.contains(caret.offsetNode)) {
            const range = document.createRange();
            range.selectNodeContents(line.lineElement);
            range.setEnd(caret.offsetNode, caret.offset);
            character = range.toString().length;
          }
          focusRequest.current = { key, line: line.lineNumber - 1, character };
          void prepare(context.item, context.instance.fileDiff)?.catch((cause) => {
            toastManager.add({
              type: "error",
              title: "Cannot edit this file",
              description: cause instanceof Error ? cause.message : "The file could not be loaded.",
            });
          });
        },
      }}
      renderHeaderFilenameSuffix={(item) => {
        const target = editing?.(
          item.type === "diff" ? resolveFileDiffPath(item.fileDiff) : item.file.name,
        );
        const draft = target && edits?.drafts.get(reviewEditKey(target));
        return (
          <>
            {renderHeaderFilenameSuffix?.(item)}
            {draft && draft.contents !== draft.savedContents && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label="Unsaved changes"
                      className="mx-1 inline-block size-2 shrink-0 rounded-full bg-primary"
                    />
                  }
                />
                <TooltipPopup>
                  {target.readOnly
                    ? "Unsaved changes · Pull request is read-only"
                    : "Unsaved changes · Cmd/Ctrl+S to save"}
                </TooltipPopup>
              </Tooltip>
            )}
          </>
        );
      }}
    />
  );
}
