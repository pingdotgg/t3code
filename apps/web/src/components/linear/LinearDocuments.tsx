import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ScrollArea } from "../ui/scroll-area";
import { LinearMarkdown, LinearMessage, LinearPager } from "./LinearControls";
import { LinearUpload, linearFileMarkdown } from "./LinearUpload";
import type { LinearSearch } from "./linearSearch";
import type { LinearMutate } from "./linearTypes";

export function LinearDocuments({
  environmentId,
  search,
  change,
  mutate,
  canWrite,
  projectId,
}: {
  environmentId: EnvironmentId;
  search: LinearSearch;
  change: (patch: Partial<LinearSearch>) => void;
  mutate: LinearMutate;
  canWrite: boolean;
  projectId?: string;
}) {
  const [cursors, setCursors] = useState<Array<string>>([]);
  const after = cursors.at(-1);
  const documents = useEnvironmentQuery(
    linearEnvironment.documents({
      environmentId,
      input: {
        ...(after ? { after } : {}),
        ...(projectId ? { projectId } : search.team ? { teamId: search.team } : {}),
      },
    }),
  );
  const selected = useEnvironmentQuery(
    search.document
      ? linearEnvironment.document({ environmentId, input: { id: search.document } })
      : null,
  );
  const [editor, setEditor] = useState<{ id?: string; title: string; content: string } | null>(
    null,
  );
  const [preview, setPreview] = useState(false);
  return (
    <>
      <ScrollArea scrollbarGutter>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {search.team ? "Team documents" : "Workspace documents"}
            </p>
            <Button
              size="sm"
              disabled={!canWrite || (!search.team && !projectId)}
              onClick={() => {
                setEditor({ title: "", content: "" });
                setPreview(false);
              }}
            >
              New document
            </Button>
          </div>
          {!search.team && !projectId && (
            <p className="text-xs text-muted-foreground">Select a team to create a document.</p>
          )}
          {(selected.error || documents.error) && (
            <LinearMessage
              retry={() => {
                selected.refresh();
                documents.refresh();
              }}
            >
              {selected.error ?? documents.error}
            </LinearMessage>
          )}
          {editor ? (
            <form
              className="flex flex-col gap-3 rounded-lg border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(
                  editor.id
                    ? {
                        kind: "documentUpdate",
                        id: editor.id,
                        input: { title: editor.title, content: editor.content },
                      }
                    : {
                        kind: "documentCreate",
                        input: {
                          title: editor.title,
                          content: editor.content,
                          ...(projectId
                            ? { projectId }
                            : search.team
                              ? { teamId: search.team }
                              : {}),
                        },
                      },
                ).then((result) => {
                  if (result) {
                    setEditor(null);
                    change({ document: result.id ?? undefined });
                  }
                });
              }}
            >
              <Input
                aria-label="Document title"
                required
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
              />
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPreview(!preview)}>
                  {preview ? "Write Markdown" : "Preview"}
                </Button>
                <LinearUpload
                  environmentId={environmentId}
                  disabled={!canWrite}
                  onUploaded={(file) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            content: `${current.content}\n\n${linearFileMarkdown(file)}`,
                          }
                        : null,
                    )
                  }
                />
              </div>
              {preview ? (
                <LinearMarkdown text={editor.content} />
              ) : (
                <Textarea
                  aria-label="Document content"
                  rows={16}
                  value={editor.content}
                  onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                />
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditor(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!canWrite || !editor.title.trim()}>
                  Save document
                </Button>
              </div>
            </form>
          ) : selected.data ? (
            <article className="flex flex-col gap-4 rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <h2 className="flex-1 text-xl font-semibold">{selected.data.title}</h2>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() => {
                    if (selected.data) {
                      setEditor({
                        id: selected.data.id,
                        title: selected.data.title,
                        content: selected.data.content ?? "",
                      });
                      setPreview(false);
                    }
                  }}
                >
                  Edit document
                </Button>
                <Button size="sm" variant="ghost" onClick={() => change({ document: undefined })}>
                  Close
                </Button>
              </div>
              <LinearMarkdown text={selected.data.content} />
            </article>
          ) : null}
          {documents.isPending && !documents.data && (
            <LinearMessage>Loading documents…</LinearMessage>
          )}
          {documents.data?.nodes.map((doc) => (
            <button
              type="button"
              key={doc.id}
              className="rounded-lg border p-4 text-left hover:bg-accent"
              onClick={() => {
                setEditor(null);
                change({ document: doc.id });
              }}
            >
              <strong className="text-sm">{doc.title}</strong>
              <p className="mt-1 text-xs text-muted-foreground">
                Updated {new Date(doc.updatedAt).toLocaleDateString()}
              </p>
            </button>
          ))}
          {documents.data?.nodes.length === 0 && (
            <LinearMessage>No documents in this view.</LinearMessage>
          )}
        </div>
      </ScrollArea>
      <LinearPager
        after={after}
        pending={documents.isPending}
        hasNextPage={documents.data?.pageInfo.hasNextPage ?? false}
        onPrevious={() => setCursors((values) => values.slice(0, -1))}
        onNext={() => {
          const cursor = documents.data?.pageInfo.endCursor;
          if (cursor) setCursors((values) => [...values, cursor]);
        }}
      />
    </>
  );
}
