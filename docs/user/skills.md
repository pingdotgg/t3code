# Skills

Open **Settings → Skills** on web and desktop to see which skills your agents can use. The page
reads the environment and project chosen at the top of Settings, so with a remote environment you
see that machine's skills. It is read-only: edit skills in your editor, or ask an agent.

The agents are your enabled provider instances. Two Claude instances show as two agents, each
with its own config folder.

## Where skills live

Keep a repo's skills in `.agents/skills` and your own in `~/.agents/skills`. Codex, Cursor,
OpenCode and Pi read both folders, and Grok reads the global one. Other agents read their own
folders instead, such as Claude's `.claude/skills` and `~/.claude/skills`. Antigravity reads the
project's `.agents/skills`, but not the global `~/.agents/skills`; its global folder is
`~/.gemini/config/skills`. A skill reaches an agent that doesn't read the shared folder through a
link or a copy in the folder it does read. The page follows links to the real folder and shows
where each agent reads a skill from.

Each instance's config folder follows its settings: a Claude instance's config directory (or
`CLAUDE_CONFIG_DIR`), `CODEX_HOME` and `GROK_HOME`. A skill in a folder that none of your enabled
agents reads isn't listed. If a folder exists but can't be read, the page says so above the list
instead of showing it as empty.

## Needs attention

**Needs attention** filters the list to skills that need a look. A skill is on it when:

- an installed and enabled agent doesn't use it. Hover the icons to see which agent. An agent
  loads one skill per name, the first it finds in its folders (Codex and OpenCode list every
  copy), so a copy that another folder shadows is not used by that agent. Claude doesn't use a
  skill that its own `skillOverrides` setting switches off either.
- the same name exists more than once with different text, in **This project**, in **Global**, or
  across them. These rows have a **Conflict** badge.
- Claude can't read the skill's header, the YAML between the `---` lines at the top of
  `SKILL.md`, so it skips the skill. Quote a value that contains a colon or brackets, for example
  a description.

## Limits

- Only a project's top folders are read, such as `<project>/.agents/skills`, not the folders
  above it that some agents also read.
- A skill's file list stops at 500 files, and `SKILL.md` isn't shown past 1 MB.
- A `SKILL.md` that is a link to a file outside the skill's folder isn't read.
