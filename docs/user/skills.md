# Skills

Open **Skills** from the shortcut at the bottom left to inspect the agent skills installed on the
selected environment. This works the same from the web and desktop clients. When you connect
remotely, the page shows skills from the remote environment, not the device displaying the page.

Choose an **Environment**, then a **Project** to inspect its skills alongside global skills.
Choose **Global skills only** to browse skills outside any project. The project list belongs to the
selected environment, and switching environments clears the selected project.

The catalog uses the `skills` CLI and includes both scopes:

- **Project** skills belong to the selected project's directory.
- **Global** skills belong to the server user's agent configuration directories.

Select a skill to read its `SKILL.md`, see its canonical path and source, and check which installed
agents can use it. A shared install may appear under many agents because the `skills` CLI keeps one
canonical copy and symlinks it into each agent's skill directory.

The page is read-only. Add, remove, or update skills in a terminal with the `skills` CLI, then use
**Refresh** to reload the catalog. For example:

```sh
npx skills add <package>
npx skills list --global
npx skills update
```

If the page cannot load, verify that `npx skills list --json` works in the selected project's directory on that environment.
