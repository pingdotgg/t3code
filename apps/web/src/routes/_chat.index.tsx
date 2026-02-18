import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { createThread } from "../threadFactory";
import { truncateTitle } from "../truncateTitle";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const { state, dispatch } = useStore();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const defaultProject = state.projects[0] ?? null;
  const canCreateThread = defaultProject !== null;

  const placeholder = useMemo(() => {
    if (!canCreateThread) {
      return "Add a project in the sidebar to start chatting.";
    }
    return "Start with a goal, bug report, or implementation idea...";
  }, [canCreateThread]);

  const onCreateThread = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!defaultProject) return;

    const threadTitle = truncateTitle(draft);
    const thread = createThread(
      defaultProject.id,
      threadTitle
        ? { model: defaultProject.model, title: threadTitle }
        : { model: defaultProject.model },
    );

    dispatch({
      type: "ADD_THREAD",
      thread,
    });

    setDraft("");

    void navigate({
      to: "/$threadId",
      params: { threadId: thread.id },
    });
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-5 py-6">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-foreground">New chat</h1>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Create a thread and continue in the full chat workspace.
          </p>
        </div>

        <form onSubmit={onCreateThread} className="space-y-3">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            className="min-h-36 resize-y"
            disabled={!canCreateThread}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground/60">
              {canCreateThread
                ? "Create a thread first, then send your first prompt."
                : "Projects are required before creating threads."}
            </p>
            <Button type="submit" disabled={!canCreateThread}>
              Create thread
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
