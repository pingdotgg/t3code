import * as AWS from "@/AWS";
import { Lexicon } from "@/AWS/Polly/Lexicon.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as polly from "@distilled.cloud/aws/polly";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

// Lexicon names must match [0-9A-Za-z]{1,20}.
const lexiconName = "alchemyTestLexicon";

// Checked-in W3C PLS fixtures — never generated at test time.
const plsDocument = (alias: string) => `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0"
      xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
      alphabet="ipa" xml:lang="en-US">
  <lexeme><grapheme>IaC</grapheme><alias>${alias}</alias></lexeme>
</lexicon>`;

const PLS_V1 = plsDocument("infrastructure as code");
const PLS_V2 = plsDocument("infrastructure as effects");

const unredact = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

const getLexicon = (name: string) =>
  polly
    .getLexicon({ Name: name })
    .pipe(
      Effect.catchTag("LexiconNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const waitForContent = (name: string, content: string) =>
  Effect.gen(function* () {
    let found: polly.GetLexiconOutput | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      found = yield* getLexicon(name);
      if (unredact(found?.Lexicon?.Content)?.includes(content)) return found;
      yield* Effect.sleep("250 millis");
    }
    return found;
  });

const waitUntilGone = (name: string) =>
  Effect.gen(function* () {
    let found: polly.GetLexiconOutput | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      found = yield* getLexicon(name);
      if (found === undefined) return found;
      yield* Effect.sleep("250 millis");
    }
    return found;
  });

test.provider(
  "lifecycle: create named lexicon, update content, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a named lexicon with the v1 PLS document.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Lexicon("TestLexicon", {
            lexiconName,
            content: PLS_V1,
          });
        }),
      );
      expect(deployed.lexiconName).toBe(lexiconName);
      expect(deployed.lexiconArn).toContain(`:lexicon/${lexiconName}`);
      expect(deployed.languageCode).toBe("en-US");
      expect(deployed.alphabet).toBe("ipa");
      expect(deployed.lexemesCount).toBe(1);

      // Out-of-band verification via distilled.
      const created = yield* waitForContent(
        lexiconName,
        "infrastructure as code",
      );
      expect(unredact(created?.Lexicon?.Content)).toContain(
        "infrastructure as code",
      );

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Lexicon);
      const all = yield* provider.list();
      expect(all.some((l) => l.lexiconName === lexiconName)).toBe(true);

      // Update — the PLS content is updatable in place (PutLexicon upsert).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Lexicon("TestLexicon", {
            lexiconName,
            content: PLS_V2,
          });
        }),
      );
      const updated = yield* waitForContent(
        lexiconName,
        "infrastructure as effects",
      );
      expect(unredact(updated?.Lexicon?.Content)).toContain(
        "infrastructure as effects",
      );

      // Destroy — the lexicon is gone.
      yield* stack.destroy();
      const after = yield* waitUntilGone(lexiconName);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);

test.provider(
  "generates a valid alphanumeric name when lexiconName is omitted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Lexicon("GeneratedName", { content: PLS_V1 });
        }),
      );
      // Polly constrains names to [0-9A-Za-z]{1,20}.
      expect(deployed.lexiconName).toMatch(/^[0-9A-Za-z]{1,20}$/);

      const created = yield* getLexicon(deployed.lexiconName);
      expect(created).toBeDefined();

      yield* stack.destroy();
      const after = yield* waitUntilGone(deployed.lexiconName);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
