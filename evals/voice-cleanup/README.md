# Dictation cleanup

Checks the shipped cleanup prompt and real text generation paths on synthetic transcripts. No microphone or audio service is used. Run from `evals/` with a configured provider login:

```sh
pnpm voice-cleanup --model <model> --out runs/voice
pnpm voice-cleanup --model <model> --out runs/voice-new --baseline runs/voice/results.json
pnpm voice-cleanup --provider opencode --model opencode/deepseek-v4.1-flash-free --out runs/voice-opencode
```

Codex is the default and enforces an output schema. `--provider opencode` requires OpenCode 2 and uses T3's production session adapter without schema enforcement. It starts a separate server in a temporary workspace, removes its sessions, and closes the server afterward. It uses the CLI's configured credentials without connecting to T3's live server or database.

Use `--case <id> --samples 1` for a smoke run. By default the five cases run three times each (15 short model calls). The two JSON cases cover default cleanup and custom instructions that ask for plain text. Run the same eval harness against the pre-fix and fixed source, using the same provider/model and `--baseline` to compare. Decode failures are recorded as failed samples rather than aborting the run. The decoded count measures response format only.

Read `review.json` against each rubric before opening the answer key. A case fails if half or more of its samples fail decoding or violate the rubric. Allow cosmetic punctuation differences; do not accept changed meaning or existing draft text copied into the result. Add cases to `cases.ts` when an actual cleanup failure exposes a missing behavior. The free OpenCode model needs no paid API calls; Codex cost depends on the configured model and account.
