import * as NodeSqlite from "node:sqlite";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2MessageProvenance,
  OrchestrationV2NotificationSource,
} from "@t3tools/contracts";

/** How much of a message recall reads. A delegate brief's task starts after the boilerplate. */
export const RECALL_MESSAGE_CHARS = 8_192;
export const RECALL_MAX_FACTS = 2;
const RECALL_MIN_MATCHED_TERMS = 3;
const RECALL_MIN_COVERAGE = 0.3;
const RECALL_MIN_MESSAGE_COVERAGE = 0.028;
const RECALL_RESTATED_MIN_TERMS = 4;
// 40 hid a current fact behind near-duplicates. 100 and 200 delivered the same facts here, and 200 slowed the tail.
export const RECALL_CANDIDATE_LIMIT = 100;

const RECALL_STOPWORDS = new Set(
  `the and for this that with please help can you could would want need hello there thanks
are was were is be to of in on it as at by an or not from into when should must use keep only any all its their
than then also but if so do does did done has have had will just make sure each every other more most some such
these those them they we our us your dont before after without within while where which who what
how why same new via per out up down off over under again once here now still yet very cannot never
always may might shall one two three first second last next using used uses`.split(/\s+/),
);

/** Automatic recall serves a direct request; progress and collaborator messages carry their own context. */
export interface RecallMessage {
  readonly text: string;
  readonly provenance?: OrchestrationV2MessageProvenance;
  readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
  readonly notification?: {
    readonly source: { readonly kind: OrchestrationV2NotificationSource["kind"] };
  };
}

export type RecallTrigger =
  | { readonly recall: true }
  | {
      readonly recall: false;
      readonly reason: "slash" | "progress_notice" | "nonhuman" | "current_correction";
    };

/** A saved fact as the gate reads it. Trust, sources, and thread identity are decided earlier. */
export interface RecallFactText {
  readonly id: string;
  readonly content: string;
  readonly entities: ReadonlyArray<string>;
}

/** Project-local document frequencies of current saved facts. */
export interface TermStats {
  readonly tokenize?: (text: string) => Iterable<string>;
  readonly corpusSize: number;
  readonly docs: (term: string) => number;
}

export interface RecallMatch<Fact extends RecallFactText> {
  readonly fact: Fact;
  readonly relevance: number;
  readonly passes: boolean;
}

/** Standalone adapter; recall batches the same tokenizer on its read-only connection. */
const tokenizeRecallText = (text: string): ReadonlyArray<string> => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE tokens USING fts3tokenize(unicode61)");
    return db
      .prepare("SELECT token FROM tokens WHERE input = ?")
      .all(text)
      .map((row) => String(row.token));
  } finally {
    db.close();
  }
};

export const recallTokens = (text: string): ReadonlySet<string> =>
  new Set(tokenizeRecallText(text));

const recallTermSequence = (
  text: string,
  tokenize: (text: string) => Iterable<string>,
): ReadonlyArray<string> =>
  [...tokenize(text)].filter((token) => token.length >= 3 && !RECALL_STOPWORDS.has(token));

export const recallTerms = (
  text: string,
  tokenize: (text: string) => Iterable<string> = tokenizeRecallText,
): ReadonlySet<string> => new Set(recallTermSequence(text, tokenize));

// This gate recognizes explicit revisions; it neither proves consistency nor supersedes stored facts.
const CURRENT_INSTRUCTION_REVISION =
  /\b(?:no longer|instead|rather than|supersedes?|superseded|stop (?:using|running|building|testing|executing|hosting|deploying)|(?:do not|don['’]t|never) (?:use|run|build|test|execute|host|deploy)|you (?:can|may) (?:use|run|build|test|execute|host|deploy)|(?:is|are) (?:now )?(?:allowed|permitted))\b|(?:^|[.!?\n]\s*)(?:actually|correction|clarification)\b/iu;

export const recallTrigger = (message: RecallMessage): RecallTrigger => {
  if (message.notification !== undefined || message.delegatedCompletion !== undefined)
    return { recall: false, reason: "progress_notice" };
  if (message.provenance !== undefined) return { recall: false, reason: "nonhuman" };
  if (message.text.trimStart().startsWith("/")) return { recall: false, reason: "slash" };
  if (CURRENT_INSTRUCTION_REVISION.test(message.text))
    return { recall: false, reason: "current_correction" };
  return { recall: true };
};

const idf = (docs: number, corpusSize: number) => Math.log(1 + corpusSize / (1 + docs));

export const rankRecallCandidates = <Fact extends RecallFactText>(
  message: string,
  facts: ReadonlyArray<Fact>,
  stats: TermStats,
): ReadonlyArray<RecallMatch<Fact>> => {
  const text = message.slice(0, RECALL_MESSAGE_CHARS);
  const tokenize = stats.tokenize ?? tokenizeRecallText;
  const querySequence = recallTermSequence(text, tokenize);
  const queryTerms = new Set(querySequence);
  // Partial overlap loses questions, negation and qualifications that can change the claim.
  const copiedStatement =
    message.length <= RECALL_MESSAGE_CHARS && querySequence.length >= RECALL_RESTATED_MIN_TERMS
      ? text.trim()
      : undefined;
  const queryMass = [...queryTerms].reduce(
    (sum, term) => sum + idf(stats.docs(term), stats.corpusSize),
    0,
  );
  const ranked = facts.flatMap((fact) => {
    const sequence = recallTermSequence([fact.content, ...fact.entities].join(" "), tokenize);
    const terms = new Set(sequence);
    const matched = [...queryTerms].filter((term) => terms.has(term));
    const hit = matched.reduce((sum, term) => sum + idf(stats.docs(term), stats.corpusSize), 0);
    const factMass = [...terms].reduce(
      (sum, term) => sum + idf(stats.docs(term), stats.corpusSize),
      0,
    );
    const queryCoverage = queryMass === 0 ? 0 : hit / queryMass;
    const factCoverage = factMass === 0 ? 0 : hit / factMass;
    const relevance = Math.max(queryCoverage, factCoverage);
    const passes =
      (matched.length >= RECALL_MIN_MATCHED_TERMS ||
        matched.some(
          (term) =>
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term) &&
            term.length >= 6,
        )) &&
      relevance >= RECALL_MIN_COVERAGE &&
      queryCoverage >= RECALL_MIN_MESSAGE_COVERAGE &&
      copiedStatement !== fact.content.trim();
    return [{ fact, relevance, passes }];
  });
  // Equal coverage preserves project-local trust and recency order.
  ranked.sort((left, right) => right.relevance - left.relevance);
  return ranked;
};

const selectRecallMatches = <Fact extends RecallFactText>(
  message: RecallMessage,
  facts: ReadonlyArray<Fact>,
  stats: TermStats,
): ReadonlyArray<RecallMatch<Fact>> =>
  rankRecallCandidates(message.text, facts, stats)
    .filter((match) => match.passes)
    .slice(0, RECALL_MAX_FACTS);

/** Facts recall would attach for this message. Notices and slash commands attach none. */
export const recallForMessage = <Fact extends RecallFactText>(
  message: RecallMessage,
  facts: ReadonlyArray<Fact>,
  stats: TermStats,
): ReadonlyArray<Fact> => {
  if (!recallTrigger(message).recall) return [];
  return selectRecallMatches(message, facts, stats).map((match) => match.fact);
};
