/** One finalized exchange, as a leaf summary pass sends it. A peer carries the seat that spoke. */
export type LeafMessage =
  | { readonly role: "user" | "assistant"; readonly text: string }
  | {
      readonly role: "peer";
      readonly text: string;
      readonly speaker: { readonly label: string; readonly model: string };
    };

export interface LeafCase {
  readonly id: string;
  readonly kind: "bad" | "control";
  readonly source: string;
  readonly messages: ReadonlyArray<LeafMessage>;
  /** Each regex must match some statement. */
  readonly mustMention: ReadonlyArray<string>;
  /** A statement matching `when` must also match `require`. */
  readonly attributed: ReadonlyArray<{ readonly when: string; readonly require: string }>;
  /** No statement may match these. */
  readonly mustNot: ReadonlyArray<string>;
}

/** Words that keep a choice open or point away from Postgres before it is named. */
const open = String.raw`(?:not|never|against|between|whether|if|or|wait|waiting|before|keep|keeping|rather than|instead of)`;
/** `target` within the clause, with no `open` word before it. */
const toward = (target: string) => String.raw`(?:(?!\b${open}\b)[^.;]){0,60}\b${target}\b`;

/**
 * Statements that hand the peer's Postgres proposal to the user or to the thread's agent, whom the
 * summarizer sees as `assistant`. Regexes, so they miss paraphrase; read the statements too.
 */
const misattributed = [
  String.raw`\buser asked to (?:drop Redis|use Postgres|keep Redis)`,
  String.raw`\buser\s+(?:(?:is|has|had|then|also|later|finally|ultimately|eventually|now)\s+)*(?:decided|chose|chosen|picked|selected|opted|wants|wanted|going with|went with|goes with|settled on|agreed|accepted|approved|adopted|endorsed|signed off)\b${toward("(?:Postgres|Astra|proposal|suggestion)")}`,
  String.raw`\buser's (?:decision|choice|pick|preference)\b${toward("Postgres")}`,
  String.raw`\b(?:per|according to) the user\b${toward("Postgres")}`,
  String.raw`\bPostgres\b[^.;]{0,60}(?:\b(?:per|according to|as (?:decided|requested|chosen|approved) by)\s+the user\b|\bat the user's (?:request|direction)\b)`,
  String.raw`\b(?:agent|assistant)\s+(?:(?:also|first|then|initially|had|has)\s+)*(?:propos(?:ed|es)|suggest(?:ed|s)|recommend(?:ed|s)|push(?:ed|es) for|answered|said|replied|argued|wants|wanted)\b${toward("Postgres")}`,
  String.raw`\b(?:agent|assistant)'s (?:proposal|suggestion|recommendation)\b${toward("Postgres")}`,
];

/** The leaf exchange: the user asks, Astra proposes, the agent disagrees. */
const peerProposal: ReadonlyArray<LeafMessage> = [
  { role: "user", text: "Where should sessions live? I have not decided." },
  {
    role: "peer",
    speaker: { label: "Astra", model: "gpt-6-astra" },
    text: "Drop Redis and use Postgres for sessions.",
  },
  {
    role: "assistant",
    text: "I disagree. Keep Redis for sessions. The choice is still open.",
  },
];

const peerProposalSource =
  'Group threads (ScriptedAlchemy/t3code#131): a seat model\'s published reply reached the summarizer as a plain assistant message with no name, and production summaries said "The assistant answered" for words the peer spoke.';

export const leafCases: ReadonlyArray<LeafCase> = [
  {
    id: "leaf-peer-proposal-is-not-a-user-decision",
    kind: "bad",
    source: peerProposalSource,
    messages: peerProposal,
    mustMention: ["Astra", "Postgres"],
    attributed: [
      {
        // A verb, not "the proposal", so a statement that credits no one stays open.
        when: `(?:propos|suggest|recommend)(?:ed|es|s)\\b${toward("Postgres")}|Postgres\\b[^.]{0,80}\\b(?:propos|suggest|recommend)ed\\b`,
        require: "Astra",
      },
    ],
    mustNot: misattributed,
  },
  {
    id: "leaf-ordinary-exchange-has-no-peer",
    kind: "control",
    source: "Control for peer attribution: an ordinary user and agent exchange with no peer.",
    messages: [
      { role: "user", text: "Add a README section on configuring the proxy." },
      {
        role: "assistant",
        text: "I added the README section with an example config. The link checker has not run yet.",
      },
    ],
    mustMention: ["README", "link checker|links"],
    attributed: [],
    mustNot: ["Astra"],
  },
];

/** A roll-up input: four adjacent child summaries, oldest first, as the summary pass sends them. */
export interface CondensedCase {
  readonly id: string;
  readonly kind: "bad" | "control";
  readonly source: string;
  readonly summaries: ReadonlyArray<string>;
  /** Each regex must match some statement. */
  readonly mustMention: ReadonlyArray<string>;
  /** A statement matching `when` must also match `require`. */
  readonly attributed: ReadonlyArray<{ readonly when: string; readonly require: string }>;
  /** No statement may match these. */
  readonly mustNot: ReadonlyArray<string>;
}

export const condensedCases: ReadonlyArray<CondensedCase> = [
  {
    id: "condensed-four-sources-retain-reversal-and-unverified-claim",
    kind: "bad",
    source:
      "Roll-ups of long threads (feat/lcm-summary-rollup): a later reversal and an agent's unverified claim are the details a summary of summaries tends to flatten.",
    summaries: [
      [
        "- The user asked to move session storage to Redis to cut login latency, which p95 traces put at 480 ms, mostly in the sessions table lookup.",
        "- The agent read src/auth/SessionStore.ts and found three callers: the login handler, the refresh middleware and the admin impersonation route.",
        "- The agent planned a Redis adapter behind the SessionStore interface, with a 30-day TTL matching the current cookie lifetime.",
        "- The user asked that impersonation sessions never outlive 15 minutes, whatever the store.",
        "- The agent ran vp test run src/auth and reported 41 passing tests before any change.",
        "- The agent proposed ioredis as the client and a docker-compose service for local development.",
      ].join("\n"),
      [
        "- The user reversed the Redis decision: sessions stay in Postgres because ops will not run another stateful service.",
        "- The user said login latency must instead come from an index and from caching the user row for 60 seconds in process.",
        "- The agent deleted the redis-sessions branch and removed the ioredis dependency it had added to package.json.",
        "- The agent kept the SessionStore interface change, since it also simplifies the impersonation expiry rule.",
        "- The user asked for no new runtime dependencies in this work.",
        "- The agent noted that the in-process cache must be invalidated on password change and logout.",
      ].join("\n"),
      [
        "- The agent wrote migration 0042 adding an index on sessions.user_id and a partial index on unexpired sessions.",
        "- The agent said the session migration tests pass; no test output was shown.",
        "- The agent added the 60-second user-row cache with invalidation on password change and logout.",
        "- The user asked to measure p95 login latency again on staging before merging.",
        "- The agent reported that impersonation sessions now expire after 15 minutes, citing the new guard in SessionStore.",
        "- The user pointed out that migration 0042 locks the sessions table on large tenants and asked for CREATE INDEX CONCURRENTLY.",
      ].join("\n"),
      [
        "- The agent changed migration 0042 to CREATE INDEX CONCURRENTLY and split it out of the transaction.",
        "- The user asked for a rollback script for the index migration; it is still open.",
        "- The staging latency measurement has not been run yet.",
        "- The agent updated docs/auth/sessions.md to describe the cache and the new expiry rule.",
        "- The user asked the agent to keep the old Redis notes out of the docs.",
        "- The agent said the admin impersonation route now logs the expiry time.",
      ].join("\n"),
    ],
    mustMention: ["Postgres", "[Rr]ollback", "[Ss]taging|p95|latency"],
    attributed: [
      {
        // Only a sentence about where sessions live; "omit the old Redis notes" is not a decision.
        when: "Redis[^.]*[Ss]ession|[Ss]ession[^.]*Redis",
        require:
          "revers|instead|rather than|replac|no longer|drop|abandon|reject|ruled out|not |n't|chang|stay|kept|keep|delet|omit",
      },
      {
        when: "[Tt]ests?\\b",
        require:
          "[Aa]gent (\\w+ ){0,2}(said|says|claimed|claims|reported|reports|stated)|claimed|unverified|not verified|no (test )?output|without (test )?output|not shown",
      },
    ],
    mustNot: ["\\b(verified|confirmed) (that )?(the )?(session )?(migration )?tests"],
  },
  {
    id: "condensed-four-ordinary-sources",
    kind: "control",
    source: "Control for the roll-up rules: four ordinary child summaries of a docs task.",
    summaries: [
      "- The user asked for a README section on configuring the proxy.",
      "- The agent wrote the README section with an example config.",
      "- The user asked to add a screenshot of the settings page; the agent added it.",
      "- The user asked to run the link checker before merging; it has not run yet.",
    ],
    mustMention: ["README", "link checker|links"],
    attributed: [],
    mustNot: [],
  },
];
