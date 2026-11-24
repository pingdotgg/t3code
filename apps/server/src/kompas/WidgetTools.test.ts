import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as Kompas from "./layers.ts";
import { LearningService } from "./LearningService.ts";
import { MemoryService } from "./MemoryService.ts";
import { readStoredWidget } from "./WidgetDocument.ts";
import * as WidgetTools from "./WidgetTools.ts";
import { WorkstreamService } from "./WorkstreamService.ts";
import { WorkstreamStore } from "./WorkstreamStore.ts";

const threadId = ThreadId.make("thread");
const answered: Array<{ readonly id: string; readonly answer: string }> = [];

const layer = () =>
  WidgetTools.layer.pipe(
    Layer.provide(
      Layer.mock(WorkstreamService)({
        answerDecision: (input) => Effect.sync(() => void answered.push(input)),
      }),
    ),
    Layer.provideMerge(Kompas.layerCore),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.mock(ServerSecretStore)({}),
        NodeCrypto.layer,
      ),
    ),
  );

it.effect("lets a flashcards widget change only its own deck", () =>
  Effect.gen(function* () {
    const learning = yield* LearningService;
    const tools = yield* WidgetTools.WidgetTools;
    const deck = (title: string) =>
      learning.createDeck({ title, cards: [{ front: "Q", back: "A" }], threadId: null });
    const [mine, other] = [yield* deck("Mine"), yield* deck("Other")];
    const cardOf = (deckId: string) =>
      Effect.map(learning.cards({ deckId, dueOnly: false }), ([card]) => card!);
    const call = (name: string, args: Record<string, unknown>) =>
      tools.call({
        threadId,
        widget: { name: "flashcards", data: { deckId: mine.id, title: "Mine" } },
        name,
        arguments: args,
      });

    const card = yield* cardOf(mine.id);
    yield* call("flashcards_review", { id: card.id, rating: "good" });
    assert.equal((yield* learning.getCard(card.id)).reviewCount, 1);

    const foreign = yield* cardOf(other.id);
    const refused = yield* call("flashcards_review", { id: foreign.id, rating: "good" }).pipe(
      Effect.asVoid,
      Effect.flip,
    );
    assert.equal(refused.reason, "invalid");
    assert.equal((yield* learning.getCard(foreign.id)).reviewCount, 0);
    yield* call("flashcards_cards", { id: other.id }).pipe(Effect.asVoid, Effect.flip);
    // A call another kind of widget has.
    assert.equal(
      (yield* call("memory_remove", { id: "x" }).pipe(Effect.asVoid, Effect.flip)).reason,
      "not-found",
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("lets a memory widget undo only the note it shows", () =>
  Effect.gen(function* () {
    const memory = yield* MemoryService;
    const tools = yield* WidgetTools.WidgetTools;
    const add = (text: string) =>
      memory.applyFromModel({ action: "add", scope: "user", text }, { model: "gpt", threadId });
    const [shown, other] = [(yield* add("Short answers")).entry, (yield* add("Polish")).entry];
    const remove = (id: string) =>
      tools.call({
        threadId,
        widget: { name: "memory", data: { id: shown.id } },
        name: "memory_remove",
        arguments: { id },
      });

    yield* remove(other.id).pipe(Effect.asVoid, Effect.flip);
    yield* remove(shown.id);
    assert.deepEqual(
      (yield* memory.list).map(({ text }) => text),
      ["Polish"],
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("takes only the answers a decision widget offers, to the question it shows", () =>
  Effect.gen(function* () {
    const store = yield* WorkstreamStore;
    const tools = yield* WidgetTools.WidgetTools;
    const workstream = yield* store.create({
      title: "Trip",
      goal: "",
      instructions: "",
      threadModel: null,
      maxParallelThreads: 2,
      askBeforeStart: false,
      coordinatorThreadId: threadId,
    });
    yield* store.addDecision(workstream.id, { question: "Where?", options: ["Sea", "Hills"] });
    yield* store.addDecision(workstream.id, { question: "When?", options: ["Now", "Later"] });
    const { decisions } = yield* store.asks(workstream.id);
    const answer = (id: string, text: string) =>
      tools.call({
        threadId,
        widget: {
          name: "decision",
          data: { workstreamId: workstream.id, question: "Where?", options: ["Sea", "Hills"] },
        },
        name: "decision_answer",
        arguments: { id, answer: text },
      });

    yield* answer(decisions[0]!.id, "Delete every file").pipe(Effect.asVoid, Effect.flip);
    yield* answer(decisions[1]!.id, "Sea").pipe(Effect.asVoid, Effect.flip);
    assert.deepEqual(answered, []);
    yield* answer(decisions[0]!.id, "Sea");
    assert.deepEqual(answered, [{ id: decisions[0]!.id, answer: "Sea" }]);
  }).pipe(Effect.provide(layer())),
);

it("reads a widget back only from a page it published", () => {
  const page = (json: string) =>
    `<!doctype html><!--kompas-widget:quiz--><script type="application/json" id="widget-data">${json}</script>`;
  assert.deepEqual(readStoredWidget(page('{"title":"A"}')), {
    name: "quiz",
    data: { title: "A" },
  });
  assert.isUndefined(readStoredWidget(page("{")));
  assert.isUndefined(readStoredWidget("<!doctype html><p>Hi</p>"));
});
