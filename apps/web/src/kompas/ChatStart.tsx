import { dueCardCount, waitingForUser } from "@t3tools/client-runtime/state/kompas";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { Panel } from "./KompasPage";
import { useKompas } from "./state";

export function ChatStartHeadline() {
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col items-center px-4 text-center">
      <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
        <T>What would you like to learn today?</T>
      </h1>
      <p className="mt-2 text-muted-foreground">
        <T>Ask, drop in your notes, or ask for flashcards, a chart or a map.</T>
      </p>
    </div>
  );
}

/** Under an empty conversation's composer: first prompts, and what waits today. */
export function ChatStartExtras(props: { readonly draftId: DraftId | null }) {
  const gt = useGT();
  const navigate = useNavigate();
  const kompas = useKompas();
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const [dismissed, setDismissed] = useState(false);
  const { draftId } = props;
  if (draftId === null) return null;

  const prompts = [
    gt("Make flashcards from my notes"),
    gt("Explain it with a chart"),
    gt("Show it on a map"),
    gt("Quiz me on a topic"),
  ];
  const decks = kompas?.snapshot.decks ?? [];
  const due = dueCardCount(decks);
  const waiting = (kompas?.snapshot.workstreams ?? [])
    .map((workstream) => ({ workstream, count: waitingForUser(workstream) }))
    .find(({ count }) => count > 0);

  return (
    <div className="pointer-events-auto mx-auto mt-6 flex w-full max-w-(--chat-content-max-width) flex-col gap-6 px-4">
      {dismissed ? null : (
        <div className="flex flex-wrap justify-center gap-2">
          {prompts.map((prompt) => (
            <Button
              key={prompt}
              variant="outline"
              size="sm-pill"
              onClick={() => {
                setPrompt(draftId, `${prompt}: `);
                setDismissed(true);
              }}
            >
              {prompt}
            </Button>
          ))}
        </div>
      )}
      {due === 0 && waiting === undefined ? null : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {due === 0 ? null : (
            <Panel>
              <p className="text-muted-foreground text-sm">
                <T>For today</T>
              </p>
              <p className="mt-1 font-semibold text-lg">
                {gt(
                  "{count, plural, one {{count} card to review} other {{count} cards to review}}",
                  {
                    count: due,
                  },
                )}
              </p>
              <p className="mt-1 truncate text-muted-foreground text-sm">
                {decks
                  .filter((deck) => deck.dueCount > 0)
                  .slice(0, 3)
                  .map((deck) => `${deck.title}: ${deck.dueCount}`)
                  .join(" · ")}
              </p>
              <div className="mt-3">
                <Button onClick={() => void navigate({ to: "/study", search: { session: "all" } })}>
                  <T>Start reviewing</T>
                </Button>
              </div>
            </Panel>
          )}
          {waiting === undefined || kompas === null ? null : (
            <Panel>
              <p className="truncate text-muted-foreground text-sm">{waiting.workstream.title}</p>
              <p className="mt-1 font-semibold text-lg">
                {gt(
                  "{count, plural, one {{count} thing is waiting for you} other {{count} things are waiting for you}}",
                  { count: waiting.count },
                )}
              </p>
              <div className="mt-3">
                <Button
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(
                          kompas.environmentId,
                          waiting.workstream.coordinatorThreadId,
                        ),
                      ),
                    })
                  }
                >
                  <T>Open project</T>
                </Button>
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
