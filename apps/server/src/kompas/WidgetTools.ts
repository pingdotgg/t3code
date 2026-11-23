import { KompasError, ReviewRating, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { kompasError } from "./KompasDatabase.ts";
import { LearningService } from "./LearningService.ts";
import { MemoryService } from "./MemoryService.ts";
import { WorkstreamService } from "./WorkstreamService.ts";
import { WorkstreamStore } from "./WorkstreamStore.ts";

/**
 * The calls Kompas's own widgets make. They run here instead of through the agent, so a widget
 * works after its agent stopped, on every provider, and costs the model no context.
 */
export class WidgetTools extends Context.Service<
  WidgetTools,
  {
    readonly call: (input: {
      readonly threadId: ThreadId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<unknown, KompasError>;
  }
>()("t3/kompas/WidgetTools") {}

const Id = Schema.Struct({ id: Schema.String });
const CardText = Schema.Struct({ front: Schema.String, back: Schema.String });

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

  const call: WidgetTools["Service"]["call"] = Effect.fn("WidgetTools.call")(function* (input) {
    const args = input.arguments;
    switch (input.name) {
      case "flashcards_cards": {
        const { id } = yield* decode(Id)(args);
        return { cards: yield* learning.cards({ deckId: id, dueOnly: false }) };
      }
      case "flashcards_review": {
        const review = yield* decode(
          Schema.Struct({ id: Schema.String, rating: ReviewRating }),
        )(args);
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
        return { card: yield* learning.editCard(edit) };
      }
      case "quiz_record": {
        const result = yield* decode(
          Schema.Struct({ title: Schema.String, correct: Schema.Int, total: Schema.Int }),
        )(args);
        yield* learning.recordQuiz({ ...result, threadId: input.threadId });
        return {};
      }
      case "quiz_to_flashcards": {
        const { title, cards } = yield* decode(
          Schema.Struct({ title: Schema.String, cards: Schema.Array(CardText) }),
        )(args);
        const deck = yield* learning.createDeck({ title, cards, threadId: input.threadId });
        return { deck };
      }
      case "memory_state": {
        const { id } = yield* decode(Id)(args);
        const entry = (yield* memory.list).find((candidate) => candidate.id === id);
        return { status: entry?.status ?? "removed" };
      }
      case "memory_remove": {
        const { id } = yield* decode(Id)(args);
        yield* memory.remove(id);
        return {};
      }
      case "memory_resolve": {
        const answer = yield* decode(
          Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
        )(args);
        yield* memory.resolve(answer);
        return {};
      }
      case "project_asks": {
        const { id } = yield* decode(Id)(args);
        return yield* workstreamStore.asks(id);
      }
      case "decision_answer": {
        const answer = yield* decode(
          Schema.Struct({ id: Schema.String, answer: Schema.String }),
        )(args);
        yield* workstreams.answerDecision(answer);
        return {};
      }
      case "suggestion_resolve": {
        const answer = yield* decode(
          Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
        )(args);
        yield* workstreams.resolveSuggestion(answer);
        return {};
      }
      default:
        return yield* kompasError("not-found", `Widgets cannot call ${input.name}.`);
    }
  });

  return WidgetTools.of({ call });
});

export const layer = Layer.effect(WidgetTools, make);
