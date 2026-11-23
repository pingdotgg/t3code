import { dueCardCount, dueInLabel } from "@t3tools/client-runtime/state/kompas";
import type { Card as Flashcard, Deck, ReviewRating } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { T, useGT, useLocale, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Bar, Card, KompasPage } from "./KompasPage";
import {
  type Kompas,
  kompasEnvironment,
  reportFailure,
  useKompas,
  useStartConversation,
} from "./state";

const RATINGS = ["again", "hard", "good", "easy"] as const;
const SWIPE_DISTANCE = 110;

function Stats({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const { data } = useEnvironmentQuery(
    kompasEnvironment.studyStats({ environmentId: kompas.environmentId, input: {} }),
  );
  if (data === null) return null;
  return (
    <View className="flex-row gap-3">
      {[
        [
          gt("Streak"),
          gt("{count, plural, one {{count} day} other {{count} days}}", {
            count: data.streakDays,
          }),
        ],
        [gt("Today"), String(data.reviewsToday)],
        [gt("Due now"), String(data.dueCount)],
      ].map(([label, value]) => (
        <View key={label} className="flex-1 rounded-2xl border border-border bg-card p-3">
          <Text className="text-xs text-foreground-muted">{label}</Text>
          <Text className="font-t3-bold text-lg">{value}</Text>
        </View>
      ))}
    </View>
  );
}

function DeckCard(props: { readonly kompas: Kompas; readonly deck: Deck }) {
  const { deck } = props;
  const { environmentId } = props.kompas;
  const gt = useGT();
  const navigation = useNavigation();
  const removeDeck = useAtomCommand(kompasEnvironment.removeDeck, { reportFailure: false });
  const exportDeck = useAtomCommand(kompasEnvironment.exportDeck, { reportFailure: false });
  const share = async () => {
    const result = await exportDeck({ environmentId, input: { id: deck.id } });
    if (!reportFailure(result) || result._tag !== "Success") return;
    const file = new FileSystem.File(FileSystem.Paths.cache, result.value.fileName);
    file.create({ overwrite: true });
    // Excel reads a UTF-8 CSV as its local code page without the mark.
    file.write(`﻿${result.value.csv}`);
    await Sharing.shareAsync(file.uri, { mimeType: "text/csv" });
  };
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate("KompasDeck", { deckId: deck.id })}
      >
        <Text className="font-t3-medium text-base">{deck.title}</Text>
        <Text className="text-sm text-foreground-muted">
          {gt("{count, plural, one {{count} card} other {{count} cards}}", {
            count: deck.cardCount,
          })}
        </Text>
      </Pressable>
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <Button
            tone="primary"
            size="compact"
            disabled={deck.dueCount === 0}
            label={gt("Review {count}", { count: deck.dueCount })}
            onPress={() => navigation.navigate("KompasReview", { deckId: deck.id })}
          />
        </View>
        <IconButton
          icon="square.and.arrow.up"
          accessibilityLabel={gt("Export CSV")}
          onPress={() => void share()}
        />
        <IconButton
          icon="trash"
          accessibilityLabel={gt("Delete deck")}
          onPress={() =>
            Dialog.confirm({
              title: gt("Delete {title} and its review history?", { title: deck.title }),
              confirmText: gt("Delete"),
              destructive: true,
              onConfirm: () =>
                void removeDeck({ environmentId, input: { id: deck.id } }).then(reportFailure),
            })
          }
        />
      </View>
    </Card>
  );
}

export function StudyScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const startConversation = useStartConversation();
  return (
    <KompasPage title={gt("Study")} tab>
      {(kompas) => {
        const { decks } = kompas.snapshot;
        const due = dueCardCount(decks);
        return (
          <>
            <Stats kompas={kompas} />
            {decks.length === 0 ? (
              <EmptyState
                variant="plain"
                title={gt("No decks yet")}
                detail={gt("Ask in a conversation for flashcards, and they appear here.")}
                actionLabel={gt("Make flashcards")}
                onAction={() =>
                  void startConversation(kompas, `${gt("Make flashcards from my notes")}: `)
                }
              />
            ) : (
              <>
                <Button
                  tone="primary"
                  fullWidth
                  disabled={due === 0}
                  label={gt("Review {count}", { count: due })}
                  onPress={() => navigation.navigate("KompasReview", {})}
                />
                {decks.map((deck) => (
                  <DeckCard key={deck.id} kompas={kompas} deck={deck} />
                ))}
              </>
            )}
          </>
        );
      }}
    </KompasPage>
  );
}

function SwipeCard(props: {
  readonly card: Flashcard;
  readonly flipped: boolean;
  readonly onFlip: () => void;
  readonly onRate: (rating: ReviewRating) => void;
}) {
  const gt = useGT();
  const { width } = useWindowDimensions();
  const offset = useSharedValue(0);
  const { flipped, onRate } = props;
  const gesture = usePanGesture({
    enabled: flipped,
    activeOffsetX: [-15, 15],
    failOffsetY: [-15, 15],
    onUpdate: (event) => {
      offset.set(event.translationX);
    },
    onDeactivate: (event) => {
      if (event.canceled || Math.abs(event.translationX) < SWIPE_DISTANCE) {
        offset.set(withTiming(0, { duration: 160 }));
        return;
      }
      const rating = event.translationX > 0 ? "good" : "again";
      offset.set(
        withTiming(Math.sign(event.translationX) * width, { duration: 160 }, (finished) => {
          if (finished) runOnJS(onRate)(rating);
        }),
      );
    },
  });
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }, { rotateZ: `${offset.value / 40}deg` }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ flex: 1 }, style]}>
        <Pressable
          accessibilityRole="button"
          accessibilityHint={
            flipped ? gt("Swipe right for good, left for again") : gt("Shows the answer")
          }
          onPress={props.onFlip}
          className="flex-1 items-center justify-center gap-4 rounded-3xl border border-border bg-card p-6"
        >
          <Text className="font-t3-bold text-xs uppercase text-foreground-muted">
            {flipped ? <T>Answer</T> : <T>Question</T>}
          </Text>
          <Text className="text-center font-t3-bold text-2xl">
            {flipped ? props.card.back : props.card.front}
          </Text>
          {flipped ? null : (
            <Text className="text-center text-base text-foreground-muted">
              {props.card.hint ?? gt("Tap to see the answer")}
            </Text>
          )}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

function ReviewBody(props: { readonly kompas: Kompas; readonly deckId: string | undefined }) {
  const { kompas, deckId } = props;
  const gt = useGT();
  const locale = useLocale();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const startConversation = useStartConversation();
  const review = useAtomCommand(kompasEnvironment.reviewCard, { reportFailure: false });
  const { data } = useEnvironmentQuery(
    kompasEnvironment.cards({
      environmentId: kompas.environmentId,
      input: { ...(deckId === undefined ? {} : { deckId }), dueOnly: true },
    }),
  );
  const [done, setDone] = useState(0);
  // When the answer was shown; the rating buttons count from it.
  const [flippedAt, setFlippedAt] = useState<number | null>(null);
  // Reviewed here already: the query may still list a card until the server's answer arrives.
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const cards = (data?.cards ?? []).filter((card) => reviewed.get(card.id) !== card.due);
  const card = cards[0];
  const total = done + cards.length;

  const rate = async (rating: ReviewRating) => {
    if (card === undefined || busy) return;
    setBusy(true);
    void Haptics.selectionAsync();
    const result = await review({
      environmentId: kompas.environmentId,
      input: { id: card.id, rating },
    });
    setBusy(false);
    if (!reportFailure(result)) return;
    setReviewed((current) => new Map(current).set(card.id, card.due));
    setFlippedAt(null);
    setDone((count) => count + 1);
  };
  const ratingLabels: Record<ReviewRating, string> = {
    again: gt("Again", { $context: "flashcard rating" }),
    hard: gt("Hard", { $context: "flashcard rating" }),
    good: gt("Good", { $context: "flashcard rating" }),
    easy: gt("Easy", { $context: "flashcard rating" }),
  };

  return (
    <View
      className="flex-1 gap-4 bg-screen px-5"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
    >
      <View className="flex-row items-center gap-3">
        <IconButton
          icon="xmark"
          accessibilityLabel={gt("Close review")}
          onPress={() => navigation.goBack()}
        />
        <Bar value={total === 0 ? 1 : done / total} label={gt("Review progress")} />
        <Text className="font-t3-medium text-sm">
          {Math.min(done + 1, total)} / {total}
        </Text>
      </View>
      {data === null ? null : card === undefined ? (
        <EmptyState
          variant="plain"
          title={gt("All done for now")}
          detail={gt(
            "{count, plural, one {You reviewed {count} card.} other {You reviewed {count} cards.}}",
            { count: done },
          )}
          actionLabel={gt("Back to decks")}
          onAction={() => navigation.goBack()}
        />
      ) : (
        <>
          <SwipeCard
            key={`${card.id}:${card.due}`}
            card={card}
            flipped={flippedAt !== null}
            onFlip={() => setFlippedAt(flippedAt === null ? Date.now() : null)}
            onRate={(rating) => void rate(rating)}
          />
          {flippedAt === null ? (
            <Button
              tone="primary"
              fullWidth
              label={gt("Show answer")}
              onPress={() => setFlippedAt(Date.now())}
            />
          ) : (
            <View className="flex-row gap-2">
              {RATINGS.map((rating) => (
                <Pressable
                  key={rating}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void rate(rating)}
                  className={
                    rating === "good"
                      ? "min-h-14 flex-1 items-center justify-center rounded-2xl bg-primary active:opacity-70"
                      : "min-h-14 flex-1 items-center justify-center rounded-2xl border border-border bg-card active:opacity-70"
                  }
                >
                  <Text
                    className={
                      rating === "good"
                        ? "font-t3-medium text-sm text-primary-foreground"
                        : "font-t3-medium text-sm"
                    }
                  >
                    {ratingLabels[rating]}
                  </Text>
                  <Text
                    className={
                      rating === "good"
                        ? "text-xs text-primary-foreground"
                        : "text-xs text-foreground-muted"
                    }
                  >
                    {dueInLabel(card.nextDue[rating], flippedAt, locale)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <View className="items-center">
            <Button
              tone="text"
              size="compact"
              label={gt("Explain this card")}
              onPress={() => {
                navigation.goBack();
                void startConversation(
                  kompas,
                  gt("Explain this flashcard: {front} ({back})", {
                    front: card.front,
                    back: card.back,
                  }),
                );
              }}
            />
          </View>
        </>
      )}
    </View>
  );
}

/** Reviews what is due, in one deck or in all of them. */
export function ReviewScreen({ route }: StaticScreenProps<{ readonly deckId?: string }>) {
  const kompas = useKompas();
  return kompas === null ? (
    <View className="flex-1 bg-screen" />
  ) : (
    <ReviewBody kompas={kompas} deckId={route.params.deckId} />
  );
}

function DeckBody(props: { readonly kompas: Kompas; readonly deck: Deck }) {
  const { deck } = props;
  const { environmentId } = props.kompas;
  const gt = useGT();
  const saveCard = useAtomCommand(kompasEnvironment.saveCard, { reportFailure: false });
  const removeCard = useAtomCommand(kompasEnvironment.removeCard, { reportFailure: false });
  const { data } = useEnvironmentQuery(
    kompasEnvironment.cards({ environmentId, input: { deckId: deck.id, dueOnly: false } }),
  );
  const [draft, setDraft] = useState<{ id?: string; front: string; back: string } | null>(null);
  const save = async () => {
    if (draft === null) return;
    const { id, front, back } = draft;
    const hint = data?.cards.find((card) => card.id === id)?.hint ?? null;
    const result = await saveCard({
      environmentId,
      input: { ...(id === undefined ? {} : { id }), deckId: deck.id, front, back, hint },
    });
    if (reportFailure(result)) setDraft(null);
  };
  return (
    <>
      {draft === null ? (
        <Button
          label={gt("Add card")}
          icon="plus"
          onPress={() => setDraft({ front: "", back: "" })}
        />
      ) : (
        <Card>
          <TextInput
            multiline
            placeholder={gt("Question")}
            value={draft.front}
            onChangeText={(front) => setDraft({ ...draft, front })}
          />
          <TextInput
            multiline
            placeholder={gt("Answer")}
            value={draft.back}
            onChangeText={(back) => setDraft({ ...draft, back })}
          />
          <View className="flex-row gap-2">
            <Button
              tone="primary"
              size="compact"
              label={gt("Save")}
              disabled={draft.front.trim() === "" || draft.back.trim() === ""}
              onPress={() => void save()}
            />
            <Button
              tone="text"
              size="compact"
              label={gt("Cancel")}
              onPress={() => setDraft(null)}
            />
          </View>
        </Card>
      )}
      {(data?.cards ?? []).map((card) => (
        <Card key={card.id}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={gt("Edit card")}
            onPress={() => setDraft({ id: card.id, front: card.front, back: card.back })}
          >
            <Text className="font-t3-medium text-base">{card.front}</Text>
            <Text className="text-sm text-foreground-muted">{card.back}</Text>
          </Pressable>
          <Button
            tone="text"
            size="compact"
            label={gt("Delete card")}
            onPress={() =>
              void removeCard({ environmentId, input: { id: card.id } }).then(reportFailure)
            }
          />
        </Card>
      ))}
    </>
  );
}

export function DeckScreen({ route }: StaticScreenProps<{ readonly deckId: string }>) {
  const gt = useGT();
  const deck = useKompas()?.snapshot.decks.find((entry) => entry.id === route.params.deckId);
  return (
    <KompasPage title={deck?.title ?? gt("Deck")}>
      {(kompas) =>
        deck === undefined ? (
          <Text className="text-foreground-muted">
            <T>
              This deck was <Var>{gt("deleted")}</Var>.
            </T>
          </Text>
        ) : (
          <DeckBody kompas={kompas} deck={deck} />
        )
      }
    </KompasPage>
  );
}
