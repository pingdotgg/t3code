import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { HttpClientRequest } from "effect/unstable/http";

import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import { dedent } from "alchemy/Util";

export const code = AI.Parameter("code")(S.String)`
The JavaScript code to evaluate. 
Must be a valid module with a default export function accepting no arguments.
Can return any value, including a Promise.`;

export class Eval extends AI.Tool<Eval>()("eval")`
Evaluate JavaScript ${code}` {}

export const EvalLive = Layer.effect(
  Eval,
  Effect.gen(function* () {
    const vm = yield* Cloudflare.WorkerLoader("Eval");

    return ({ code }) =>
      vm
        .load({
          mainModule: "index.js",
          compatibilityDate: "2026-01-28",
          modules: {
            "code.js": code,
            "index.js": dedent`
              import util from "node:util";
              import code from "./code.js";
              const lines: string[] = [];
              console.log = (...args) => lines.push(util.formatWithOptions({ depth: null }, ...args));
              export default {
                fetch: async () => {
                  const output = await code();
                  return Response(lines.join("\\n") + "\\n" + util.inspect(output, { depth: null }));
                }
              }`,
          },
        })
        .pipe(
          Effect.flatMap((worker) =>
            worker.fetch(HttpClientRequest.get("https://worker/")),
          ),
          Effect.flatMap((response) => response.text),
          Effect.catch((e) =>
            Effect.succeed({
              error: e,
            }),
          ),
        );
  }),
);
