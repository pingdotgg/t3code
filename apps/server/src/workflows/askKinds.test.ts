import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { askedKinds } from "./askKinds.ts";
import * as WorkflowRuntime from "./WorkflowRuntime.ts";

it("finds the kinds a file's asks name outright, each with the workflow it is written in", () => {
  assert.deepStrictEqual(
    askedKinds(`const { workflow, ask: question } = T3;
const later = (name) => T3.ask(name, { kind: "partly", title: "Close?", choices: ["Yes"] });
workflow("sort", { version: 2, payload: Schema.Struct({}) }, Effect.fn(function* (payload) {
  yield* question("wanted", { kind: "feature", title: "Wanted?", choices: ["Yes"] });
  yield* T3.ask(\`meant\`, { title: "Meant?", choices: ["Yes"], "kind": \`intended\` });
  yield* T3.ask("either", { kind: payload.bug ? "bug" : "feature", title: "Fix?", choices: [] });
  // Worked out as the run goes, so left to ask itself.
  yield* T3.ask("computed", { kind: payload.kind, ["kind"]: "computed", title: "?", choices: [] });
}));
T3.workflow(\`other\`, { version: VERSION, payload: Schema.Struct({}) }, () =>
  T3.ask("one", { kind: "other", title: "?", choices: [] }),
);
`),
    [
      { kind: "partly", ask: undefined, workflow: undefined },
      { kind: "feature", ask: "wanted", workflow: { name: "sort", version: 2 } },
      { kind: "intended", ask: "meant", workflow: { name: "sort", version: 2 } },
      { kind: "bug", ask: "either", workflow: { name: "sort", version: 2 } },
      { kind: "feature", ask: "either", workflow: { name: "sort", version: 2 } },
      { kind: "other", ask: "one", workflow: { name: "other", version: undefined } },
    ],
  );
});

it("reads the file's syntax, so only a call of T3's own ask is an ask", () => {
  const kinds = (source: string) => askedKinds(source).map((asked) => asked.kind);
  assert.deepStrictEqual(
    kinds(`const { ask } = T3;
/* ask("example", { kind: "comment", title: "Wanted?", choices: ["Yes"] }) */
// ask("example", { kind: "line", title: "Wanted?", choices: ["Yes"] })
const brief = 'Then call ask("example", { kind: "string", title: "Wanted?" }).';
const template = \`ask("example", { kind: "template" }) \${brief}\`;
const pattern = /ask\\("example", \\{ kind: "pattern" \\}\\)/;
const shaped = { kind: "not-an-ask" };
ask("real", { title: template, choices: ["Yes"] });
`),
    [],
  );
  // A file's own \`ask\`, or another object's, is not T3's whatever it is given.
  assert.deepStrictEqual(
    kinds(`const ask = (name, options) => client.ask(name, { kind: "theirs", ...options });
ask("mine", { kind: "mine" });
`),
    [],
  );
  assert.deepStrictEqual(
    kinds(`const { ask } = T3;
const wrapped = (ask) => ask("shadowed", { kind: "shadowed" });
`),
    [],
  );
  // Type annotations are blanked out as Node does to run the file.
  assert.deepStrictEqual(
    kinds(`const name: string = "typed";
T3.ask(name as string, { kind: "typed", title: "?", choices: [] satisfies string[] });
`),
    ["typed"],
  );
  assert.deepStrictEqual(kinds("T3.ask('broken', { kind: 'never' "), []);
});

const definitions = (source: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ask-kinds-" });
    const file = path.join(directory, "asks.ts");
    yield* fileSystem.writeFileString(file, source);
    return yield* Effect.result(WorkflowRuntime.loadDefinitions(file));
  });

it.effect("an ask of a kind its own workflow does not declare fails the file as it loads", () =>
  Effect.gen(function* () {
    const sorted = yield* definitions(`const { workflow, ask } = T3;
workflow(
  "sort",
  { version: 1, payload: Schema.Struct({}), asks: { feature: "Feature wanted?", intended: "Bug or intended?" } },
  Effect.fn(function* () {
    yield* ask("wanted", { kind: "feature", title: "Wanted?", choices: ["Yes", "No"] });
    yield* ask("meant", { kind: "intended", title: "Meant?", choices: ["Yes", "No"] });
    yield* ask("plain", { title: "Go on?", choices: ["Yes", "No"] });
  }),
);
`);
    assert.deepStrictEqual(sorted._tag === "Success" ? sorted.success[0]?.asks : sorted, {
      feature: "Feature wanted?",
      intended: "Bug or intended?",
    });

    // Another workflow in the file declaring the misspelt kind does not make it this one's.
    const borrowed = yield* definitions(`const { workflow, step, ask } = T3;
workflow(
  "triage",
  { version: 1, payload: Schema.Struct({}), asks: { feature: "Feature wanted?" } },
  Effect.fn(function* () {
    yield* step("look", { returns: Schema.Void }, Effect.void);
    yield* ask("decide", { kind: "feture", title: "Wanted?", choices: ["Yes"] });
  }),
);
workflow(
  "other",
  { version: 1, payload: Schema.Struct({}), asks: { feture: "Feture?" } },
  Effect.fn(function* () {
    yield* ask("decide", { kind: "feture", title: "Wanted?", choices: ["Yes"] });
  }),
);
`);
    assert.include(
      borrowed._tag === "Failure" ? String(borrowed.failure.cause) : "it loaded",
      'Workflow triage asks "decide" of kind "feture", which it does not declare. It declares `feature`.',
    );

    const undeclared =
      yield* definitions(`T3.workflow("bare", { version: 1, payload: Schema.Struct({}) }, () =>
  T3.ask("decide", { kind: "feature", title: "Wanted?", choices: ["Yes"] }),
);
`);
    assert.include(
      undeclared._tag === "Failure" ? String(undeclared.failure.cause) : "it loaded",
      'Workflow bare asks "decide" of kind "feature", which it does not declare. It declares none.',
    );

    // Outside any definition, an ask is the file's only workflow's.
    const helped = yield* definitions(`const { workflow, ask } = T3;
const decide = () => ask("decide", { kind: "feture", title: "Wanted?", choices: ["Yes"] });
workflow("alone", { version: 1, payload: Schema.Struct({}), asks: { feature: "Feature wanted?" } }, decide);
`);
    assert.include(
      helped._tag === "Failure" ? String(helped.failure.cause) : "it loaded",
      'Workflow alone asks "decide" of kind "feture", which it does not declare.',
    );

    const unlabelled = yield* definitions(
      `T3.workflow("bare", { version: 1, payload: Schema.Struct({}), asks: ["feature"] }, () => Effect.void);\n`,
    );
    assert.include(
      unlabelled._tag === "Failure" ? String(unlabelled.failure.cause) : "it loaded",
      'workflow("bare")\'s asks is each kind with its label',
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a file from before kinds loads as it did, whatever its comments and strings say", () =>
  Effect.gen(function* () {
    const loaded = yield* definitions(`const { workflow, ask, agent } = T3;
/* An example for later: ask("example", { kind: "feature", title: "Wanted?", choices: ["Yes"] }) */
workflow("old", { version: 1, payload: Schema.Struct({}) }, Effect.fn(function* () {
  /*
   * ask("example", { kind: "feature", title: "Wanted?", choices: ["Yes"] })
   */
  // ask("example", { kind: "feature", title: "Wanted?", choices: ["Yes"] })
  yield* agent("brief", {
    project: "/home/user/app",
    brief: 'Do not call ask("example", { kind: "feature", title: "Wanted?", choices: ["Yes"] }).',
  });
  yield* ask("real", { title: \`Is ask("x", { kind: "feature" }) wanted?\`, choices: ["Yes"] });
}));
`);
    assert.deepStrictEqual(
      loaded._tag === "Success"
        ? loaded.success.map((definition) => [definition.name, definition.asks])
        : String(loaded.failure.cause),
      [["old", {}]],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
