---
name: technical-writing
description: "Layered technical-writing standard: Diátaxis structure, Google developer style sentences, STE instruction rules, Global English syntax. Use for $pstack:technical-writing or when writing or reviewing docs, RFCs, readmes, PR descriptions, or commit messages."
disable-model-invocation: true
---

# Technical writing

Write so a tired engineer understands on the first read.

- Cut every word that does no work.
- Use the short, everyday word: "use", not "utilize".
- When a rule makes a sentence worse, fix the sentence another way or leave it alone.
- Write the real symbol, file, flag, or command name, not a synonym or a description of it.
- Don't invent jargon. Use the words a developer would say out loud. Say what a named pattern means the first time.

## Vary the rhythm

- Mix sentence lengths. Split the sentence that carries two thoughts. Keep the long sentence that carries one.
- Have a view in explanation. Keep reference dry.
- Be specific. Not "schema changes can cause issues" but "a column rename fails the build".

## Pick the mode first (Diátaxis)

One document, one mode. Don't mix modes. Split and link instead.

- **Tutorial: learning by doing.** Say what the learner will build. Every step produces a visible result, and you say what they should see. Explanation gets one clause and a link.
- **How-to: steps to a goal.** Solve the reader's problem. Assume competence. Action only. Allow forks. Name the guide by the task.
- **Reference: facts for lookup.** Only describe. Be dry, complete, and sure. Mirror the structure of the thing described.
- **Explanation: understanding and why.** One bounded topic. Give context: design decisions, history, constraints, alternatives. Opinion is allowed here and nowhere else.

## Write sentences to the reader (Google developer style)

- Talk to the reader as "you", in the present tense.
- Say who does what. Passive is fine only when the actor is unknown or beside the point.
- Write instructions as commands. Put the condition before the instruction and the common case first.
- No buzzwords, no figurative language, no "please", and never "simply", "easy", or "quickly" in a procedure.
- Don't pre-announce, and don't start consecutive sentences with the same phrase.
- Link with words that say where the link goes.
- Headings carry the point, in sentence case. One h1 per page, no skipped levels.
- Numbered lists for sequences, bullets for everything else. Introduce a list with a complete sentence. Keep items parallel.
- Code goes in code font. UI elements go in bold. Use serial commas. Drop "etc.".

## Make statements load one at a time (STE rules)

- One instruction per sentence. One thought per sentence everywhere else.
- Split instructions longer than about 20 words and other sentences longer than about 25.
- Put the warning or condition before the step it guards.
- Keep "the" and "a".
- Give each word one meaning, and pick one word per action.
- Write procedures as direct commands, never as narration and never in the passive.
- Avoid "-ing" words where you can.

## Leave no sentence open to two readings (Global English)

- Keep words like "only" and "not" next to the word they change.
- Break up long noun strings.
- Make every "it", "they", and "this" point at one obvious thing. Never use "this" or "which" to point at a whole clause.
- Don't drop verbs, or the small words that show structure, such as "that".
- Repeat the article in a series when it prevents a misread. Say which parts "and" or "or" joins.
- Use periods, not semicolons or em dashes. No slashes, and no "(s)". Make text in parentheses a full grammatical unit.
- Call each thing by one name, everywhere.
- Skip idioms, colloquialisms, Latin abbreviations, and metaphors.

## Voice and repo specifics

- Apply the **unslop** skill to every doc this skill touches. That skill owns the slop-pattern catalog: AI vocabulary, filler, hedging, formatting tells.
- PR descriptions and commit messages are writing too. Every layer except Diátaxis applies to them. A PR body is a briefing that a reviewer can read in under a minute. Do not paste swarm logs, SHA lists, or metric tables. Link them.
- Product UI strings are not documentation. Use your product's copy guidelines for those.
- Indent code snippets with tabs. Write real paths. Make every count or tree claim true at the commit that lands it, and include the command that regenerates it.
