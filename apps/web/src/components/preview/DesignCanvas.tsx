import { startDesignEditor } from "@t3tools/client-runtime/design/editor";
import { DESIGN_UI_ATTRIBUTE } from "@t3tools/client-runtime/design/document";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { readPreviewAnnotationTheme } from "~/browser/annotationTheme";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { useProject, useThread } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

export function DesignCanvas({
  threadRef,
  tabId,
  path,
  url,
  visible,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  path: string;
  url: string;
  visible: boolean;
}) {
  const thread = useThread(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? "";
  const file = useProjectFileQuery(threadRef.environmentId, cwd, path, Boolean(cwd));
  const refreshFile = file.refresh;
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus);
  const write = useAtomCommand(projectEnvironment.writeFile);
  const editor = useRef<ReturnType<typeof startDesignEditor>>(undefined);
  const queue = useRef(Promise.resolve());
  const saved = useRef<string | null>(null);
  const [contents, setContents] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const incoming = file.data?.truncated ? null : file.data?.contents;

  useEffect(() => {
    refreshFile();
  }, [refreshFile]);
  useEffect(() => {
    if (incoming !== undefined && incoming !== null && incoming !== saved.current && !dirty)
      setContents(incoming);
  }, [dirty, incoming]);
  useEffect(() => {
    editor.current?.setOpen(visible);
  }, [visible]);
  useEffect(() => () => editor.current?.flush(), []);
  useEffect(() => {
    const sync = () => editor.current?.setTheme(readPreviewAnnotationTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  const source = useMemo(() => {
    if (contents === null) return undefined;
    const document = new DOMParser().parseFromString(contents, "text/html");
    document
      .querySelectorAll('base, meta[http-equiv="refresh" i]')
      .forEach((element) => element.remove());
    const base = document.createElement("base");
    base.href = url;
    base.setAttribute(DESIGN_UI_ATTRIBUTE, "");
    document.head.prepend(base);
    return `<!doctype html>\n${document.documentElement.outerHTML}`;
  }, [contents, url]);

  const failure =
    error ??
    file.error ??
    (file.data?.truncated ? "This design is too large to edit safely." : null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {failure ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs"
        >
          <span>{failure}</span>
          <button
            type="button"
            onClick={() => {
              if (error) editor.current?.save();
              else file.refresh();
            }}
            className="shrink-0 underline"
          >
            {error ? "Retry save" : "Retry"}
          </button>
        </div>
      ) : null}
      {source ? (
        <iframe
          title="Design canvas"
          className="min-h-0 w-full flex-1 border-0"
          sandbox="allow-same-origin allow-downloads allow-modals"
          srcDoc={source}
          onLoad={(event) => {
            const frame = event.currentTarget.contentWindow;
            if (!frame || frame.location.href !== "about:srcdoc") return;
            editor.current = startDesignEditor(frame as Window & typeof globalThis, {
              url,
              theme: readPreviewAnnotationTheme(),
              onChange: (change) => {
                setDirty(true);
                const pending = queue.current
                  .catch(() => {})
                  .then(async () => {
                    const result = await write({
                      environmentId: threadRef.environmentId,
                      input: { cwd, relativePath: path, contents: change.html },
                    });
                    if (result._tag === "Failure") {
                      setError("Could not save. Your edits are still here. Press Save to retry.");
                      throw squashAtomCommandFailure(result);
                    }
                    saved.current = change.html;
                    if (change.annotation)
                      useComposerDraftStore
                        .getState()
                        .addPreviewAnnotation(threadRef, change.annotation);
                    setError(null);
                  });
                queue.current = pending;
                void pending.then(
                  () => {
                    if (queue.current === pending) setDirty(false);
                  },
                  () => {},
                );
                return pending;
              },
            });
            editor.current.setOpen(visible);
            void reportStatus({
              environmentId: threadRef.environmentId,
              input: {
                threadId: threadRef.threadId,
                tabId,
                navStatus: {
                  _tag: "Success",
                  url,
                  title: frame.document.title || path.split("/").at(-1) || "Design",
                },
                canGoBack: false,
                canGoForward: false,
              },
            });
          }}
        />
      ) : !failure ? (
        <div role="status" className="grid flex-1 place-items-center text-xs text-muted-foreground">
          Loading design…
        </div>
      ) : null}
    </div>
  );
}
