---
name: scratchpad
description: Extract the JSDoc example nearest the active source selection or cursor into ./scratchpad as a TypeScript file. Use when the user asks to dump, copy, open, or try a source example in scratchpad.
---

Use this skill to create a scratchpad TypeScript file from the JSDoc `**Example**`
nearest the user's active source cursor or selection.

## Workflow

1. Determine the source path and line:
   - Use the IDE active file and selection/cursor line when present.
   - Use an explicit file and line when the user provides them.
   - If no line or selection is available, ask for it.
2. Run:

   ```sh
   node .agents/skills/scratchpad/scripts/extract-example.mjs <source-path> <line>
   ```

3. If the script exits with code 2 because there is no obvious runner, ask the
   user whether to preserve the example exactly, name an Effect value to run, or
   cancel.
   - To preserve exactly, rerun with `--mode preserve`.
   - To run a specific Effect value, rerun with `--runner <identifier>`.
4. Report the created path as a clickable file link. This is the deterministic
   way to open it in the code pane.
5. Do not run the scratchpad file unless the user explicitly asks.

## Behavior

- The script chooses the example whose `**Example**` section contains the line;
  otherwise it chooses the first following example; otherwise the nearest
  previous example.
- Filenames are derived from the source file and example title, for example
  `scratchpad/Schedule-retrying-and-repeating-effects.ts`.
- Existing files are not overwritten. The script appends a numeric suffix.
- In auto mode, if a top-level `program` binding exists, the script appends:

  ```ts
  Effect.runPromise(program).then(console.log, console.error)
  ```

- If the example already contains an Effect runner, the script preserves it.
