# Skill Picker QA

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`

## Scope

Manual QA for the rebuilt composer skill picker using Computer Use on the local dev app.

## Environment

- Local dev app: `http://127.0.0.1:5736`
- Server: `http://127.0.0.1:13776`
- Browser used for final pass: Google Chrome

## Result

Passed.

## What I verified

- Opened the command palette with `Cmd+K` and confirmed the new `Open skills` action was present with shortcut hint `Cmd+Shift+K`.
- Selected `Open skills` from the command palette and confirmed the dedicated `Skills` dialog opened.
- Confirmed the dialog loaded real skill results from Codex home and showed the count banner (`50 skills (truncated)` in this environment).
- Filtered the dialog by typing `skill-picker-qa` and confirmed the result narrowed to the temporary QA skill.
- Selected the filtered skill result and confirmed the composer was populated with the expected reference block:
  - `## Use skill: skill-picker-qa-home`
  - description line
  - blank line
  - `Read the full instructions from: ...`
- Reopened the picker directly with `Cmd+Shift+K` from the composer and confirmed the shortcut opened the dialog again.
- Pressed `Esc` and confirmed the dialog visually dismissed back to the composer.

## Notes

- Safari could open the flow, but its accessibility tree became stale around the modal, so I switched to Chrome for the final evidence.
- I also verified the backend search logic directly from the branch-local server module, which returned both workspace and Codex-home skills for the current repo cwd.
- Temporary QA-only skills were created for this pass and removed afterward, so they are not part of the committed feature diff.
