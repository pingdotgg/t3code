import * as polly from "@distilled.cloud/aws/polly";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetLexicon } from "./GetLexicon.ts";
import type { Lexicon } from "./Lexicon.ts";

// GetLexicon is one of the few Polly actions with resource-level IAM (the
// `lexicon` resource type), so the grant is scoped to the lexicon's ARN
// rather than `*` — that's why this binding is bespoke instead of a
// makePollyHttpBinding thin call.
export const GetLexiconHttp = Layer.effect(
  GetLexicon,
  Effect.gen(function* () {
    const getLexicon = yield* polly.getLexicon;

    return Effect.fn(function* <L extends Lexicon>(lexicon: L) {
      const Name = yield* lexicon.lexiconName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Polly.GetLexicon(${lexicon}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["polly:GetLexicon"],
                Resource: [lexicon.lexiconArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Polly.GetLexicon(${lexicon.LogicalId})`)(
        function* () {
          return yield* getLexicon({ Name: yield* Name });
        },
      );
    });
  }),
);
