# Project settings

T3 Code reads shared project settings from `t3.json` at the root of the active checkout. Check in
this file if new worktrees must use the same settings. T3 Code does not merge an untracked file from
another checkout or the main checkout.

## Customize generated text

Use project prompts to control commit messages, pull request content, branch names, and thread
titles:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "textGeneration": {
    "prompts": {
      "commitMessage": "Use Conventional Commits with a short scope.",
      "changeRequest": "Start with the problem, then explain the fix and tests.",
      "branchName": "Return the full branch name. Use fix/<slug> for bugs and feat/<slug> for features.",
      "threadTitle": "Name the durable product goal in plain language."
    }
  }
}
```

Prompt values must contain text after trimming and can be at most 20,000 characters. Prompt changes
apply the next time T3 Code generates that text.

Each project prompt replaces the default T3 Code prompt and global writing rules for that task.
T3 Code still supplies the required JSON response shape and the source context, such as the diff,
commits, or thread messages. The selected text generation model does not change.

`threadTitle` applies to new and regenerated titles. Add `threadTitleRegeneration` to use different
instructions when T3 Code regenerates an existing title. If you delete `threadTitleRegeneration`,
regeneration uses `threadTitle`. Omit or delete the other prompts to restore their default behavior.

The branch prompt returns a full branch name, such as `fix/login`, not a fully qualified ref such as
`refs/heads/fix/login`. T3 Code does not force its standard prefix when this prompt is set. It keeps
valid names as written and rejects invalid or reserved branch names without renaming or creating a
branch. If the name conflicts with an existing ref namespace, T3 Code adds a numeric suffix to the
blocked path component.

T3 Code can still provide a detected pull request template as reference context when
`changeRequest` is set. The template does not force the generated format.

If `t3.json` is missing or invalid, T3 Code uses the default prompts. One invalid known value makes
the whole file invalid, so T3 Code also ignores its other settings. Project prompts do not have a
settings screen. Edit `t3.json` to set or reset them.

## Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.
