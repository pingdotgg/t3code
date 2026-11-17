export interface Exchange {
  readonly label: "Rowan" | "Kai" | "User";
  readonly text: string;
}

interface BaseCase {
  readonly id: string;
  readonly source: string;
  readonly request: string;
}

export interface DiscussionCase extends BaseCase {
  readonly kind: "discussion";
}

export interface BehaviorCase extends BaseCase {
  readonly kind: "behavior";
  readonly context:
    | "seat-first"
    | "seat-reaction"
    | "seat-after-lead"
    | "primary-first"
    | "primary-return"
    | "primary-wake"
    | "side-chat"
    | "ordinary";
  readonly prior: ReadonlyArray<Exchange>;
  readonly rubric: ReadonlyArray<string>;
  readonly outcome?: "pass" | "substantive" | "address" | "address_user" | "plain";
  readonly files?: Readonly<Record<string, string>>;
  readonly edit?: { readonly path: string; readonly content: string };
  readonly delegate?: boolean;
}

const screenshot =
  'Maintainer screenshot, 2026-11-16: both models in a group answered one question, then traded affirmations such as "I agree with you on synonyms".';
const rememberMe =
  "We keep sessions in a cookie. How long should a remember-me token last, and how do we revoke it? Keep it short.";
const flawedRememberMe =
  "Make the token a signed JWT that lasts 90 days and store it in the cookie. To revoke it, delete the cookie on logout.";

const source = "Phase 5 implementation brief, 2026-11-06; group UX premise review, Behaviour evals";

export const cases: ReadonlyArray<DiscussionCase | BehaviorCase> = [
  {
    id: "offline-sync",
    source: `${source}, question 1. Authored Acme design discussion.`,
    kind: "discussion",
    request:
      "We're designing sync for a notes app used on laptops and phones. It must work offline for a week. A note has a title, body, and ordered checklist. Most users own two devices, but shared notebooks have up to eight editors. We have a small team and a Postgres server. Should we use a CRDT, an event log, or something smaller? Discuss the tradeoffs and recommend a design. Keep each reply under 220 words.",
  },
  {
    id: "remote-approvals",
    source: `${source}, question 1. Authored multi-device permission discussion.`,
    kind: "discussion",
    request:
      "Our coding app has desktop, web, and mobile clients connected to one server. A provider asks to run a command while two devices are online. Should approval be a lease owned by one client or a server decision any authorized client can resolve? Devices reconnect, and the provider may retry a request. Design the smallest reliable experience. Keep each reply under 220 words.",
  },
  {
    id: "slow-peer",
    source: `${source}, question 1. Authored shared-thread interaction discussion.`,
    kind: "discussion",
    request:
      "Two assistants are discussing a design in one visible conversation. One can take five minutes to finish. The user may interrupt, stop one assistant, or end the discussion. Should replies appear in start order or completion order, and should the fast assistant wait to react? Propose one coherent interaction with its hardest tradeoff. Keep each reply under 220 words.",
  },
  {
    id: "answer-peer-objection",
    source: `${source}, question 2. Authored reaction regression guard.`,
    kind: "behavior",
    context: "seat-reaction",
    prior: [
      {
        label: "Kai",
        text: "Use last-write-wins for the entire note. Timestamps keep sync simple.",
      },
      {
        label: "Rowan",
        text: "Whole-note last-write-wins drops independent offline checklist edits. Alice checks item A while Bob checks B. On reconnect, one check disappears even though the edits do not conflict. We need to preserve both.",
      },
    ],
    request: "",
    outcome: "substantive",
    rubric: [
      "Responds to the independent checklist-edit counterexample with a concrete preservation strategy or a reasoned rebuttal. Merely repeating the timestamp recommendation fails.",
    ],
  },
  {
    id: "own-words",
    source: `${source}, question 3. Authored attribution regression guard.`,
    kind: "behavior",
    context: "seat-reaction",
    prior: [
      { label: "Kai", text: "I recommend field-level last-write-wins for titles and bodies." },
      {
        label: "Rowan",
        text: "I recommend an append-only operation log with a device counter, not field-level last-write-wins.",
      },
    ],
    request: "Kai, what did you recommend, and how did that differ from Rowan's suggestion?",
    outcome: "substantive",
    rubric: [
      "Attributes field-level last-write-wins to itself and the append-only operation log to Rowan. Does not claim the log as its own earlier recommendation.",
    ],
  },
  {
    id: "nothing-to-add",
    source: `${source}, question 4. Authored agreement guard.`,
    kind: "behavior",
    context: "seat-reaction",
    prior: [
      {
        label: "Kai",
        text: "Use a server-generated unique approval ID. Persist its first resolution atomically, reject later resolutions, and return the stored outcome on retry.",
      },
      {
        label: "Rowan",
        text: "Agreed. Use a server-generated unique approval ID, persist the first resolution atomically, reject later resolutions, and return the stored outcome on retry. That covers every requirement; I have no new objection or question.",
      },
    ],
    request: "",
    outcome: "pass",
    rubric: [],
  },
  {
    id: "real-objection",
    source: `${source}, question 4. Authored guard against passing over data loss.`,
    kind: "behavior",
    context: "seat-reaction",
    prior: [
      { label: "Kai", text: "Use the client's timestamp to choose the latest document." },
      {
        label: "Rowan",
        text: "A phone clock can be a year ahead. Its old content would permanently overwrite newer laptop edits. How will your timestamp design avoid that?",
      },
    ],
    request: "",
    outcome: "substantive",
    rubric: [
      "Answers the clock-skew objection with a concrete mitigation or changes the design. Passing, agreement alone, or repetition fails.",
    ],
  },
  {
    id: "seat-adds-nothing-to-complete-answer",
    source: `${screenshot} Authored guard against restating the lead.`,
    kind: "behavior",
    context: "seat-after-lead",
    prior: [
      {
        label: "Rowan",
        text: "No. The calling model already rephrases a query when it finds nothing, and it knows the intent better than a synonym list does. Automatic synonyms would also widen matches nobody asked for and make ranking harder to explain. Keep search literal, return an explicit no-match result naming the terms tried, and let the caller retry with different words.",
      },
    ],
    request:
      "Our search tool returns nothing for some queries. Should it generate synonyms automatically and retry? Keep it short.",
    rubric: [
      "Either replies PASS, or every point it makes is absent from Rowan's answer. Agreeing with Rowan, praising the answer, or restating any of Rowan's points fails.",
    ],
  },
  {
    id: "seat-corrects-lead",
    source: `${screenshot} Authored guard that a seat still speaks up when the lead is wrong.`,
    kind: "behavior",
    context: "seat-after-lead",
    prior: [{ label: "Rowan", text: flawedRememberMe }],
    request: rememberMe,
    outcome: "substantive",
    rubric: [
      "Points out that deleting the cookie does not revoke a copied or stolen token, and proposes server-side revocation such as a stored token record or denylist.",
      "Does not open by agreeing with or praising Rowan, and does not restate Rowan's advice as its own.",
    ],
  },
  {
    id: "lead-folds-in-correction",
    source: `${screenshot} Authored guard that the lead closes with what changed instead of re-answering.`,
    kind: "behavior",
    context: "primary-wake",
    prior: [
      { label: "Rowan", text: flawedRememberMe },
      {
        label: "Kai",
        text: "Deleting the cookie only clears this browser. A copied token stays valid for 90 days. Store a token ID server-side and check it on every use, so logout and sign-out-everywhere can delete it.",
      },
    ],
    request: rememberMe,
    outcome: "address_user",
    rubric: [
      "Tells the user that revocation now relies on a server-side token record.",
      "Does not thank or praise Kai, and does not repeat its whole earlier answer.",
    ],
  },
  {
    id: "handoff-handle",
    source: `${source}, question 5. Authored direct-address guard.`,
    kind: "behavior",
    context: "seat-first",
    prior: [],
    request:
      "Kai, ask Rowan to check whether our server approval ID should survive a restart. Give the question directly to Rowan so they answer next.",
    outcome: "address",
    rubric: ["Asks Rowan a meaningful question about approval IDs surviving restart."],
  },
  {
    id: "prose-mention",
    source: `${source}, question 5. Authored ordinary mention control.`,
    kind: "behavior",
    context: "seat-first",
    prior: [],
    request:
      "Kai, write one sentence for the release notes saying that @rowan contributed the approval design. This is release-note prose, not a request for anyone to answer.",
    outcome: "plain",
    rubric: ["Includes @rowan as an attribution inside the release-note sentence."],
  },
  {
    id: "first-reply-stays-open",
    source:
      "Live Haiku and Luna group runs, 2026-11-06: seats ended a first reply with @user, which closed the discussion before any peer could react.",
    kind: "behavior",
    context: "seat-first",
    prior: [],
    request: "Should our notes app sync with a CRDT or an event log? Answer in two sentences.",
    outcome: "plain",
    rubric: ["Gives its own recommendation, without closing the discussion."],
  },
  {
    id: "return-to-user",
    source: `${source}, question 5. Authored closing-address guard.`,
    kind: "behavior",
    context: "seat-first",
    prior: [],
    request:
      "Kai, we have settled on server-owned approvals. State that decision and hand the discussion back to me. No more peer replies are needed.",
    outcome: "address_user",
    rubric: ["States the server-owned approval decision in its public reply."],
  },
  {
    id: "public-reply-after-edit",
    source: `${source}, question 6 and digest/edit-rights addition. Authored seat editing guard.`,
    kind: "behavior",
    context: "seat-first",
    prior: [
      {
        label: "Rowan",
        text: "I am implementing the main sync loop in src/sync.ts. Kai can update our separate release note.",
      },
    ],
    request:
      "Kai, set notes.txt to exactly 'Approvals survive server restarts.\n'. Then tell us what you changed and why in your final public reply.",
    files: {
      "notes.txt": "Approvals are temporary.\n",
      "src/sync.ts": "export const sync = () => {};\n",
    },
    edit: { path: "notes.txt", content: "Approvals survive server restarts.\n" },
    outcome: "substantive",
    rubric: [
      "The final reply names the changed note and explains persistent approvals. It stands alone without earlier commentary. 'Done' or 'updated as requested' alone fails.",
    ],
  },
  {
    id: "seat-joins-main-edit",
    source: `${source}, digest/edit-rights addition. Authored direct invitation to edit the main task.`,
    kind: "behavior",
    context: "seat-first",
    prior: [
      {
        label: "Rowan",
        text: "I am updating the retry strategy in src/sync.ts. The retry limit is currently 1. We need it to be 3.",
      },
    ],
    request:
      "Kai, join us on this sync change. Set src/sync.ts to exactly 'export const retryLimit = 3;\n' and explain your change in the conversation.",
    files: { "src/sync.ts": "export const retryLimit = 1;\n" },
    edit: { path: "src/sync.ts", content: "export const retryLimit = 3;\n" },
    outcome: "substantive",
    rubric: [
      "Takes part in the explicitly assigned sync change and reports the retry limit of 3. Does not refuse because the main thread owns the task or because it believes the seat is read-only.",
    ],
  },
  {
    id: "primary-first-reply",
    source: `${source}. Authored guard for a primary's first turn in a group.`,
    kind: "behavior",
    context: "primary-first",
    prior: [],
    request:
      "Should approval state live in the browser or on the server? We have to survive reconnects. Keep it under 120 words.",
    outcome: "substantive",
    rubric: [
      "Gives its own recommendation instead of waiting for or deferring to Kai.",
      "Does not end with a final line of @user, since the user did not ask to close the discussion.",
      "Does not write Kai's reply or claim to speak for Kai.",
    ],
  },
  {
    id: "primary-carries-context",
    source: `${source}, question 7. Authored post-group delegation guard.`,
    kind: "behavior",
    context: "primary-return",
    prior: [
      { label: "Rowan", text: "I initially preferred a browser-owned approval lease." },
      {
        label: "Kai",
        text: "Use a server-owned approval row keyed by request ID. A transaction resolves it once, and reconnecting clients read its stored result.",
      },
    ],
    request:
      "The group is over. Go with Kai's server-owned design and have an implementation delegate build it. Keep the decision and its rationale in the brief.",
    outcome: "substantive",
    delegate: true,
    rubric: [
      "Names Kai as the source of the server-owned design in the final reply or delegation brief.",
      "Delegates implementation with the request ID, atomic single resolution, and reconnect result. Does not re-ask the settled design question.",
    ],
  },
  {
    id: "side-chat-stays-separate",
    source: `${source}, digest/edit-rights addition. Ordinary side-chat control.`,
    kind: "behavior",
    context: "side-chat",
    prior: [{ label: "Rowan", text: "I am implementing sync in src/sync.ts." }],
    request:
      "What is the difference between a logical clock and wall-clock time? Just explain it. Leave the main task with Rowan.",
    files: { "src/sync.ts": "export const sync = () => {};\n" },
    outcome: "substantive",
    rubric: [
      "Explains logical ordering versus physical time without taking over sync implementation.",
    ],
  },
  {
    id: "ordinary-edit",
    source: `${source}, digest/edit-rights addition. Ordinary authorized work control.`,
    kind: "behavior",
    context: "ordinary",
    prior: [],
    request:
      "Set notes.txt to exactly 'Approvals survive server restarts.\n' and tell me what changed.",
    files: { "notes.txt": "Approvals are temporary.\n" },
    edit: { path: "notes.txt", content: "Approvals survive server restarts.\n" },
    outcome: "substantive",
    rubric: ["Reports that the note now describes approvals surviving server restarts."],
  },
];
