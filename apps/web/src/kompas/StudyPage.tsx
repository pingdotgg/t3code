import { dueCardCount, dueInLabel } from "@t3tools/client-runtime/state/kompas";
import type { Card, Deck, ReviewRating } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";
import { DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { requestConfirmDialog } from "../confirmDialog";
import { useStableCallback } from "../hooks/useStableCallback";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { formatDay, KompasPage, Panel, Progress } from "./KompasPage";
import {
  type Kompas,
  kompasEnvironment,
  useKompas,
  useReportFailure,
  useStartConversation,
} from "./state";

const RATINGS = ["again", "hard", "good", "easy"] as const;

function downloadCsv(fileName: string, csv: string) {
  // Excel reads a UTF-8 CSV as its local code page without the mark.
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function StudySession(props: {
  readonly kompas: Kompas;
  readonly deckId: string | undefined;
  readonly onClose: () => void;
}) {
  const { kompas, deckId } = props;
  const gt = useGT();
  const locale = useLocale();
  const startConversation = useStartConversation();
  const reportFailure = useReportFailure();
  const review = useAtomCommand(kompasEnvironment.reviewCard, { reportFailure: false });
  const { data } = useEnvironmentQuery(
    kompasEnvironment.cards({
      environmentId: kompas.environmentId,
      input: { ...(deckId === undefined ? {} : { deckId }), dueOnly: true },
    }),
  );
  const [total, setTotal] = useState<number | null>(null);
  const [done, setDone] = useState(0);
  // Which card shows its answer, and since when; the rating buttons count from it.
  const [flipped, setFlipped] = useState<{ readonly card: string; readonly at: number } | null>(
    null,
  );
  // Reviewed here already: the query may still list a card until the server's answer arrives.
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const cards = (data?.cards ?? []).filter((card) => reviewed.get(card.id) !== card.due);
  const card: Card | undefined = cards[0];
  // A review on another device can bring up the next card, which must not show its answer yet.
  const face = card === undefined ? "" : `${card.id}:${card.reviewCount}`;
  const flippedAt = flipped?.card === face ? flipped.at : null;
  const flip = () => setFlipped(flippedAt === null ? { card: face, at: Date.now() } : null);
  if (total === null && data !== null) setTotal(data.cards.length);

  const rate = async (rating: ReviewRating) => {
    if (card === undefined || busy) return;
    setBusy(true);
    const result = await review({
      environmentId: kompas.environmentId,
      input: { id: card.id, rating, reviewCount: card.reviewCount },
    });
    setBusy(false);
    if (!reportFailure(result)) return;
    setReviewed((current) => new Map(current).set(card.id, card.due));
    setDone((count) => count + 1);
  };
  const onKey = useStableCallback((event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
    if (event.key === "Escape") props.onClose();
    else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      flip();
    } else if (flippedAt !== null && /^[1-4]$/.test(event.key)) {
      void rate(RATINGS[Number(event.key) - 1]!);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the session's window-wide keyboard shortcuts
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const deck = kompas.snapshot.decks.find((entry) => entry.id === deckId);
  const ratingLabels: Record<ReviewRating, string> = {
    again: gt("Again", { $context: "flashcard rating" }),
    hard: gt("Hard", { $context: "flashcard rating" }),
    good: gt("Good", { $context: "flashcard rating" }),
    easy: gt("Easy", { $context: "flashcard rating" }),
  };
  const answered = Math.min(done + 1, Math.max(total ?? 0, done + cards.length));
  const size = Math.max(total ?? 0, done + cards.length);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden" role="main">
      <header className="flex items-center gap-4 border-border border-b px-5 py-3">
        <Button
          size="icon-xl"
          variant="outline"
          aria-label={gt("Close review")}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">
            {deck === undefined ? gt("Review") : deck.title}
          </h1>
          {card === undefined ? null : (
            <p className="truncate text-muted-foreground text-sm">{card.deckTitle}</p>
          )}
        </div>
        <div className="flex w-56 max-w-[40%] items-center gap-3">
          <Progress value={size === 0 ? 1 : done / size} label={gt("Review progress")} />
          <span className="shrink-0 font-medium text-sm">
            {size === 0 ? 0 : answered} / {size}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto scrollbar-gutter-both p-5">
        {data === null ? null : card === undefined ? (
          <div className="text-center">
            <h2 className="font-semibold text-2xl">
              <T>All done for now</T>
            </h2>
            <p className="mt-2 text-muted-foreground">
              {gt(
                "{count, plural, one {You reviewed {count} card.} other {You reviewed {count} cards.}}",
                { count: done },
              )}
            </p>
            <div className="mt-4">
              <Button onClick={props.onClose}>
                <T>Back to decks</T>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={flip}
              className="flex min-h-80 w-full max-w-2xl cursor-pointer flex-col items-center justify-center gap-4 rounded-3xl border border-border bg-card p-8 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                {flippedAt !== null ? <T>Answer</T> : <T>Question</T>}
              </span>
              <span className="whitespace-pre-wrap font-semibold text-2xl wrap-anywhere">
                {flippedAt !== null ? card.back : card.front}
              </span>
              {flippedAt !== null ? null : (
                <span className="text-muted-foreground">
                  {card.hint ?? <T>Click to see the answer</T>}
                </span>
              )}
            </button>
            <div className="flex min-h-11 flex-wrap justify-center gap-2">
              {flippedAt === null
                ? null
                : RATINGS.map((rating, index) => (
                    <Button
                      key={rating}
                      size="xl"
                      variant={rating === "good" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => void rate(rating)}
                    >
                      {ratingLabels[rating]}
                      <span className="text-xs opacity-70">
                        {index + 1} · {dueInLabel(card.nextDue[rating], flippedAt, locale)}
                      </span>
                    </Button>
                  ))}
            </div>
            <div className="flex flex-wrap justify-center gap-5 text-muted-foreground text-sm">
              <span className="max-sm:hidden">
                <T>Space: flip</T>
              </span>
              <span className="max-sm:hidden">
                <T>1–4: rate</T>
              </span>
              <button
                type="button"
                className="cursor-pointer text-primary hover:underline"
                onClick={() =>
                  void startConversation(
                    gt("Explain this flashcard: {front} ({back})", {
                      front: card.front,
                      back: card.back,
                    }),
                  )
                }
              >
                <T>Explain this card in a conversation</T>
              </button>
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function DeckEditor(props: {
  readonly kompas: Kompas;
  readonly deck: Deck;
  readonly onClose: () => void;
}) {
  const { kompas, deck } = props;
  const gt = useGT();
  const reportFailure = useReportFailure();
  const saveCard = useAtomCommand(kompasEnvironment.saveCard, { reportFailure: false });
  const removeCard = useAtomCommand(kompasEnvironment.removeCard, { reportFailure: false });
  const saveDeck = useAtomCommand(kompasEnvironment.saveDeck, { reportFailure: false });
  const { data } = useEnvironmentQuery(
    kompasEnvironment.cards({
      environmentId: kompas.environmentId,
      input: { deckId: deck.id, dueOnly: false },
    }),
  );
  const [title, setTitle] = useState(deck.title);
  const [draft, setDraft] = useState<{
    id?: string;
    front: string;
    back: string;
    hint: string;
  } | null>(null);
  const save = async () => {
    if (draft === null) return;
    const { id, front, back, hint } = draft;
    const result = await saveCard({
      environmentId: kompas.environmentId,
      input: {
        ...(id === undefined ? {} : { id }),
        deckId: deck.id,
        front,
        back,
        hint: hint.trim() === "" ? null : hint,
      },
    });
    if (reportFailure(result)) setDraft(null);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{deck.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Input
              aria-label={gt("Deck name")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                if (title.trim() !== "" && title !== deck.title) {
                  void saveDeck({
                    environmentId: kompas.environmentId,
                    input: { id: deck.id, title },
                  }).then(reportFailure);
                }
              }}
            />
            {draft === null ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => setDraft({ front: "", back: "", hint: "" })}
                >
                  <PlusIcon />
                  <T>Add card</T>
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
                <Textarea
                  autoFocus
                  rows={2}
                  placeholder={gt("Question")}
                  value={draft.front}
                  onChange={(event) => setDraft({ ...draft, front: event.target.value })}
                />
                <Textarea
                  rows={2}
                  placeholder={gt("Answer")}
                  value={draft.back}
                  onChange={(event) => setDraft({ ...draft, back: event.target.value })}
                />
                <Input
                  placeholder={gt("Hint (optional)")}
                  value={draft.hint}
                  onChange={(event) => setDraft({ ...draft, hint: event.target.value })}
                />
                <div className="flex gap-2">
                  <Button
                    disabled={draft.front.trim() === "" || draft.back.trim() === ""}
                    onClick={() => void save()}
                  >
                    <T>Save</T>
                  </Button>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    <T>Cancel</T>
                  </Button>
                </div>
              </div>
            )}
            <ul className="divide-y divide-border">
              {(data?.cards ?? []).map((card) => (
                <li key={card.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium wrap-anywhere">{card.front}</p>
                    <p className="text-muted-foreground text-sm wrap-anywhere">{card.back}</p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={gt("Edit card")}
                    onClick={() =>
                      setDraft({
                        id: card.id,
                        front: card.front,
                        back: card.back,
                        hint: card.hint ?? "",
                      })
                    }
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost-destructive"
                    aria-label={gt("Delete card")}
                    onClick={() =>
                      void removeCard({
                        environmentId: kompas.environmentId,
                        input: { id: card.id },
                      }).then(reportFailure)
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            <T>Close</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeckList({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const locale = useLocale();
  const navigate = useNavigate();
  const reportFailure = useReportFailure();
  const startConversation = useStartConversation();
  const saveDeck = useAtomCommand(kompasEnvironment.saveDeck, { reportFailure: false });
  const removeDeck = useAtomCommand(kompasEnvironment.removeDeck, { reportFailure: false });
  const exportDeck = useAtomCommand(kompasEnvironment.exportDeck, { reportFailure: false });
  const [editing, setEditing] = useState<string | null>(null);
  const { decks } = kompas.snapshot;
  const due = dueCardCount(decks);
  const { data: stats } = useEnvironmentQuery(
    kompasEnvironment.studyStats({ environmentId: kompas.environmentId, input: {} }),
  );
  const editingDeck = decks.find((deck) => deck.id === editing);
  const study = (session: string) => void navigate({ to: "/study", search: { session } });

  return (
    <KompasPage
      title={gt("Study")}
      description={gt("Your decks, and what to review today.")}
      actions={
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void saveDeck({
                environmentId: kompas.environmentId,
                input: { title: gt("New deck") },
              }).then((result) => {
                if (reportFailure(result) && result._tag === "Success") setEditing(result.value.id);
              })
            }
          >
            <PlusIcon />
            <T>New deck</T>
          </Button>
          <Button disabled={due === 0} onClick={() => study("all")}>
            {gt("Review {count}", { count: due })}
          </Button>
        </div>
      }
    >
      {stats === null ? null : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            [
              gt("Streak"),
              gt("{count, plural, one {{count} day} other {{count} days}}", {
                count: stats.streakDays,
              }),
            ],
            [gt("Today"), String(stats.reviewsToday)],
            [gt("Reviews in total"), String(stats.reviewsTotal)],
            [gt("Due now"), String(stats.dueCount)],
          ].map(([label, value]) => (
            <Panel key={label}>
              <p className="text-muted-foreground text-sm">{label}</p>
              <p className="font-semibold text-xl">{value}</p>
            </Panel>
          ))}
        </div>
      )}
      {decks.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <T>No decks yet</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Ask in a conversation for flashcards, and they appear here.</T>
            </EmptyDescription>
            <div className="mt-4">
              <Button
                onClick={() => void startConversation(`${gt("Make flashcards from my notes")}: `)}
              >
                <T>Make flashcards</T>
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {decks.map((deck) => (
            <Panel key={deck.id} className="flex flex-wrap items-center gap-3">
              <div className="min-w-40 flex-1">
                <h2 className="truncate font-semibold">{deck.title}</h2>
                <p className="text-muted-foreground text-sm">
                  {gt("{count, plural, one {{count} card} other {{count} cards}}", {
                    count: deck.cardCount,
                  })}
                  {" · "}
                  {formatDay(deck.createdAt, locale)}
                </p>
              </div>
              <Button disabled={deck.dueCount === 0} onClick={() => study(deck.id)}>
                {gt("Review {count}", { count: deck.dueCount })}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={gt("Edit deck")}
                onClick={() => setEditing(deck.id)}
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={gt("Export CSV")}
                onClick={() =>
                  void exportDeck({
                    environmentId: kompas.environmentId,
                    input: { id: deck.id },
                  }).then((result) => {
                    if (reportFailure(result) && result._tag === "Success") {
                      downloadCsv(result.value.fileName, result.value.csv);
                    }
                  })
                }
              >
                <DownloadIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost-destructive"
                aria-label={gt("Delete deck")}
                onClick={() =>
                  void Promise.resolve(
                    requestConfirmDialog(
                      gt("Delete {title} and its review history?", { title: deck.title }),
                    ),
                  ).then((confirmed) => {
                    if (confirmed !== true) return;
                    void removeDeck({
                      environmentId: kompas.environmentId,
                      input: { id: deck.id },
                    }).then(reportFailure);
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </Panel>
          ))}
        </div>
      )}
      {editingDeck === undefined ? null : (
        <DeckEditor
          key={editingDeck.id}
          kompas={kompas}
          deck={editingDeck}
          onClose={() => setEditing(null)}
        />
      )}
    </KompasPage>
  );
}

/** `session` is a deck's id, or `all` for everything due. */
export function StudyPage({ session }: { readonly session: string | undefined }) {
  const kompas = useKompas();
  const navigate = useNavigate();
  if (kompas === null) return <SidebarInset className="h-dvh" />;
  return session === undefined ? (
    <DeckList kompas={kompas} />
  ) : (
    <StudySession
      key={session}
      kompas={kompas}
      deckId={session === "all" ? undefined : session}
      onClose={() => void navigate({ to: "/study", search: {} })}
    />
  );
}
