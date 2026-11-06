// @effect-diagnostics nodeBuiltinImport:off - the smoke speaks Node IPC, which effect/process does not expose.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CodeIntelligenceSmokeError extends Schema.TaggedError<CodeIntelligenceSmokeError>()(
  "CodeIntelligenceSmokeError",
  { command: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.command} __code-intelligence could not answer a code query: ${this.detail}`;
  }
}

const decodeReply = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      result: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
    Schema.Struct({ built: Schema.Struct({ changed: Schema.Boolean }) }),
    Schema.Struct({ error: Schema.String }),
  ]),
);
type Reply = Exclude<ReturnType<typeof decodeReply>, { readonly _tag: "None" }>["value"];

const GENERATION = ".codegraph-t3-g1";

/**
 * Builds an index generation and answers one `callers` query from it through
 * `<command> <args> __code-intelligence` on a throwaway checkout, the way the server does. A
 * packaged server passes only if its executable accepts its baked V8 flags, dispatches the
 * subcommand, and its worker loads the CodeGraph SDK.
 */
export const smokeCodeIntelligenceProcess = Effect.fn("smokeCodeIntelligenceProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const fail = (detail: string) => new CodeIntelligenceSmokeError({ command, detail });
  const ask = (message: object) =>
    Effect.callback<Reply, CodeIntelligenceSmokeError>((resume) => {
      const child = NodeChildProcess.spawn(command, [...args, "__code-intelligence"], {
        env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      let reply: Reply | undefined;
      child.on("message", (raw: unknown) => {
        const decoded = decodeReply(raw);
        if (decoded._tag === "Some") reply = decoded.value;
      });
      child.once("error", (error) => resume(Effect.fail(fail(error.message))));
      child.once("close", (code, signal) => {
        if (reply === undefined) resume(Effect.fail(fail(`exited with ${code ?? signal}`)));
        else if ("error" in reply) resume(Effect.fail(fail(reply.error)));
        else resume(Effect.succeed(reply));
      });
      child.send(message);
      return Effect.sync(() => child.kill("SIGKILL"));
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(fail("no answer within 60 seconds")),
      }),
    );
  const callers = yield* Effect.acquireUseRelease(
    Effect.promise(async () => {
      const checkout = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-smoke-"));
      const indexRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-code-smoke-index-"),
      );
      await NodeFSP.mkdir(NodePath.join(checkout, "src"));
      await NodeFSP.writeFile(
        NodePath.join(checkout, "src/a.ts"),
        "export function greet() { return 1; }\nexport function caller() { return greet(); }\n",
      );
      return { checkout, indexRoot };
    }),
    ({ checkout, indexRoot }) =>
      Effect.gen(function* () {
        const listing = {
          checkoutPath: checkout,
          indexRoot,
          files: ["src/a.ts"],
          filesListed: 1,
          listingTruncated: false,
        };
        const built = yield* ask({
          type: "build",
          input: { ...listing, from: null, to: GENERATION, generation: 1 },
        });
        if (!("built" in built)) return yield* fail("the build returned no outcome");
        const answer = yield* ask({
          type: "query",
          input: {
            ...listing,
            query: { operation: "callers", symbol: { name: "greet" } },
            indexDirectory: GENERATION,
          },
        });
        if (!("result" in answer)) return yield* fail("the query returned no result");
        return answer.result.nodes.map((node) => node.name);
      }),
    ({ checkout, indexRoot }) =>
      Effect.promise(async () => {
        await NodeFSP.rm(checkout, { recursive: true, force: true });
        await NodeFSP.rm(indexRoot, { recursive: true, force: true });
      }),
  );
  if (!callers.includes("caller")) {
    return yield* fail(`expected 'caller' among [${callers.join(", ")}]`);
  }
});
