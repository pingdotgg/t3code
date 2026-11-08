import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { LinearMessage, LinearPager } from "./LinearControls";
import type { LinearMutate } from "./linearTypes";
export function LinearInbox({
  environmentId,
  onOpen,
  onProject,
  onDocument,
  mutate,
  canWrite,
}: {
  environmentId: EnvironmentId;
  onOpen: (id: string) => void;
  onProject: (id: string) => void;
  onDocument: (id: string) => void;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string>>([]);
  const [folder, setFolder] = useState("inbox");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const after = cursors.at(-1);
  const inbox = useEnvironmentQuery(
    linearEnvironment.inbox({
      environmentId,
      input: {
        ...(after ? { after } : {}),
        unreadOnly,
        archived: folder === "archive",
        snoozed: folder === "snoozed",
      },
    }),
  );
  return (
    <>
      <div className="flex flex-wrap gap-2 border-b px-5 py-3">
        {[
          ["inbox", "Inbox"],
          ["snoozed", "Snoozed"],
          ["archive", "Archived"],
        ].map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={folder === id ? "secondary" : "ghost"}
            onClick={() => {
              setFolder(id!);
              setCursors([]);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <label className="flex items-center gap-2 border-b px-5 py-3 text-sm">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(event) => {
            setUnreadOnly(event.target.checked);
            setCursors([]);
          }}
        />
        Unread only
      </label>
      {inbox.error ? (
        <LinearMessage retry={inbox.refresh}>{inbox.error}</LinearMessage>
      ) : inbox.isPending && !inbox.data ? (
        <LinearMessage>Loading inbox…</LinearMessage>
      ) : null}
      <ScrollArea scrollbarGutter>
        <div className="divide-y">
          {inbox.data?.nodes.map((notification) => (
            <article key={notification.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  if (notification.issue) onOpen(notification.issue.id);
                  else if (notification.documentId) onDocument(notification.documentId);
                  else if (notification.project) onProject(notification.project.id);
                  if (!notification.readAt && canWrite)
                    void mutate({
                      kind: "notificationUpdate",
                      id: notification.id,
                      input: { readAt: new Date().toISOString() },
                    });
                }}
              >
                <span
                  className={`block text-sm ${notification.readAt ? "text-muted-foreground" : "font-medium"}`}
                >
                  {!notification.readAt && "● "}
                  {notification.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {notification.issue?.identifier} {notification.subtitle}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite}
                onClick={() =>
                  void mutate({
                    kind: "notificationUpdate",
                    id: notification.id,
                    input: { readAt: notification.readAt ? null : new Date().toISOString() },
                  })
                }
              >
                {notification.readAt ? "Mark unread" : "Mark read"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite}
                onClick={() =>
                  void mutate({
                    kind: "notificationUpdate",
                    id: notification.id,
                    input: {
                      snoozedUntilAt:
                        folder === "snoozed"
                          ? null
                          : new Date(Date.now() + 86_400_000).toISOString(),
                    },
                  })
                }
              >
                {folder === "snoozed" ? "Unsnooze" : "Snooze 1 day"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite}
                onClick={() =>
                  void mutate({
                    kind: notification.archivedAt ? "notificationUnarchive" : "notificationArchive",
                    id: notification.id,
                  })
                }
              >
                {notification.archivedAt ? "Restore" : "Archive"}
              </Button>
            </article>
          ))}
          {inbox.data?.nodes.length === 0 && (
            <LinearMessage>
              {inbox.data.pageInfo.hasNextPage
                ? "No matching notifications on this page. Continue to the next page."
                : "You're all caught up."}
            </LinearMessage>
          )}
        </div>
      </ScrollArea>
      <LinearPager
        after={after}
        pending={inbox.isPending}
        hasNextPage={inbox.data?.pageInfo.hasNextPage ?? false}
        onPrevious={() => setCursors((values) => values.slice(0, -1))}
        onNext={() => {
          const cursor = inbox.data?.pageInfo.endCursor;
          if (cursor) setCursors((values) => [...values, cursor]);
        }}
      />
    </>
  );
}
