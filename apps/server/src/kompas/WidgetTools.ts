import { KompasError, ReviewRating, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { kompasError } from "./KompasDatabase.ts";
import { LearningService } from "./LearningService.ts";
import { MemoryService } from "./MemoryService.ts";
import type { StoredWidget } from "./WidgetDocument.ts";
import { WorkstreamService } from "./WorkstreamService.ts";
import { WorkstreamStore } from "./WorkstreamStore.ts";

const READS = { readOnly: true };
const WRITES = { readOnly: false };

/** What each kind of widget may call. */
const CALLS: Record<string, Record<string, { readonly readOnly: boolean }>> = {
  flashcards: {
    flashcards_cards: READS,
    flashcards_review: WRITES,
    flashcards_edit: WRITES,
  },
  quiz: { quiz_record: WRITES, quiz_to_flashcards: WRITES },
  memory: { memory_state: READS, memory_remove: WRITES, memory_resolve: WRITES },
  decision: { project_asks: READS, decision_answer: WRITES },
  suggestions: { project_asks: READS, suggestion_resolve: WRITES },
};

export const widgetCall = (widget: string, name: string) =>
  Object.hasOwn(CALLS, widget) && Object.hasOwn(CALLS[widget]!, name)
    ? CALLS[widget]![name]
    : undefined;

/**
 * The calls Kompas's own widgets make. They run here instead of through the agent, so a widget
 * works after its agent stopped, on every provider, and costs the model no context. A widget
 * reaches only what it was published with: its deck, its note, its question.
 */
export class WidgetTools extends Context.Service<
  WidgetTools,
  {
    readonly call: (input: {
      readonly threadId: ThreadId;
      readonly widget: StoredWidget;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<unknown, KompasError>;
  }
>()("t3/kompas/WidgetTools") {}

const Id = Schema.Struct({ id: Schema.String });
const CardText = Schema.Struct({ front: Schema.String, back: Schema.String });

const DeckWidget = Schema.Struct({ deckId: Schema.String });
const QuizWidget = Schema.Struct({
  title: Schema.String,
  questions: Schema.Array(Schema.Struct({ question: Schema.String })),
});
const DecisionWidget = Schema.Struct({
  workstreamId: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
});
const SuggestionsWidget = Schema.Struct({
  workstreamId: Schema.String,
  threads: Schema.Array(Schema.Struct({ title: Schema.String, task: Schema.String })),
});
const ProjectWidget = Schema.Struct({ workstreamId: Schema.String });

/** Refuses a call about something other than what the widget shows. */
const own = (belongs: boolean) =>
  belongs ? Effect.void : Effect.fail(kompasError("invalid", "This widget cannot change that."));

const decode =
  <S extends Schema.Constraint>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((cause) => kompasError("invalid", "The widget sent unusable data.", cause)),
    );

const make = Effect.gen(function* () {
  const learning = yield* LearningService;
  const memory = yield* MemoryService;
  const workstreams = yield* WorkstreamService;
  const workstreamStore = yield* WorkstreamStore;

  const ownCard = Effect.fn("WidgetTools.ownCard")(function* (cardId: string, data: unknown) {
    const { deckId } = yield* decode(DeckWidget)(data);
    yield* own((yield* learning.getCard(cardId)).deckId === deckId);
  });

  const call: WidgetTools["Service"]["call"] = Effect.fn("WidgetTools.call")(function* (input) {
    const args = input.arguments;
    const { data } = input.widget;
    if (widgetCall(input.widget.name, input.name) === undefined) {
      return yield* kompasError("not-found", `This widget cannot call ${input.name}.`);
    }
    switch (input.name) {
      case "flashcards_cards": {
        const { id } = yield* decode(Id)(args);
        yield* own(id === (yield* decode(DeckWidget)(data)).deckId);
        return { cards: yield* learning.cards({ deckId: id, dueOnly: false }) };
      }
      case "flashcards_review": {
        const review = yield* decode(Schema.Struct({ id: Schema.String, rating: ReviewRating }))(
          args,
        );
        yield* ownCard(review.id, data);
        return { card: yield* learning.review(review) };
      }
      case "flashcards_edit": {
        const edit = yield* decode(
          Schema.Struct({
            ...Id.fields,
            ...CardText.fields,
            hint: Schema.NullOr(Schema.String),
          }),
        )(args);
        yield* ownCard(edit.id, data);
        return { card: yield* learning.editCard(edit) };
      }
      case "quiz_record": {
        const result = yield* decode(
          Schema.Struct({ title: Schema.String, correct: Schema.Int, total: Schema.Int }),
        )(args);
        const quiz = yield* decode(QuizWidget)(data);
        yield* own(
          result.title === quiz.title &&
            result.total === quiz.questions.length &&
            result.correct >= 0 &&
            result.correct <= result.total,
        );
        yield* learning.recordQuiz({ ...result, threadId: input.threadId });
        return {};
      }
      case "quiz_to_flashcards": {
        const { title, cards } = yield* decode(
          Schema.Struct({ title: Schema.String, cards: Schema.Array(CardText) }),
        )(args);
        const quiz = yield* decode(QuizWidget)(data);
        const asked = new Set(quiz.questions.map(({ question }) => question));
        yield* own(title === quiz.title && cards.every(({ front }) => asked.has(front)));
        const deck = yield* learning.createDeck({ title, cards, threadId: input.threadId });
        return { deck };
      }
      case "memory_state": {
        const { id } = yield* decode(Id)(args);
        yield* own(id === (yield* decode(Id)(data)).id);
        const entry = (yield* memory.list).find((candidate) => candidate.id === id);
        return { status: entry?.status ?? "removed" };
      }
      case "memory_remove": {
        const { id } = yield* decode(Id)(args);
        yield* own(id === (yield* decode(Id)(data)).id);
        yield* memory.remove(id);
        return {};
      }
      case "memory_resolve": {
        const answer = yield* decode(Schema.Struct({ id: Schema.String, approve: Schema.Boolean }))(
          args,
        );
        yield* own(answer.id === (yield* decode(Id)(data)).id);
        yield* memory.resolve(answer);
        return {};
      }
      case "project_asks": {
        const { id } = yield* decode(Id)(args);
        yield* own(id === (yield* decode(ProjectWidget)(data)).workstreamId);
        return yield* workstreamStore.asks(id);
      }
      case "decision_answer": {
        const answer = yield* decode(Schema.Struct({ id: Schema.String, answer: Schema.String }))(
          args,
        );
        const shown = yield* decode(DecisionWidget)(data);
        const { decisions } = yield* workstreamStore.asks(shown.workstreamId);
        yield* own(
          shown.options.includes(answer.answer) &&
            decisions.some(({ id, question }) => id === answer.id && question === shown.question),
        );
        yield* workstreams.answerDecision(answer);
        return {};
      }
      case "suggestion_resolve": {
        const answer = yield* decode(Schema.Struct({ id: Schema.String, approve: Schema.Boolean }))(
          args,
        );
        const shown = yield* decode(SuggestionsWidget)(data);
        const { suggestions } = yield* workstreamStore.asks(shown.workstreamId);
        yield* own(
          suggestions.some(
            (open) =>
              open.id === answer.id &&
              shown.threads.some(({ title, task }) => title === open.title && task === open.task),
          ),
        );
        yield* workstreams.resolveSuggestion(answer);
        return {};
      }
      default:
        return yield* kompasError("not-found", `This widget cannot call ${input.name}.`);
    }
  });

  return WidgetTools.of({ call });
});

export const layer = Layer.effect(WidgetTools, make);
