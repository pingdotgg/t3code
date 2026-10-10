# Skills

Open **Settings → Skills** on web and desktop to see which skills your agents can use. The page
reads the environment and project chosen at the top of Settings, so with a remote environment you
see that machine's skills. You can turn each skill on or off for every agent, or for one agent at a
time, and choose which projects use it. To change what a skill says, edit its `SKILL.md` in your
editor or ask an agent.

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

## Turning skills on or off

A skill's switch turns it on or off for every agent. Open the skill to switch a single agent. The
switch on **This project**, **Global** or a group changes all of its skills at once, and asks
before turning many off.

Turning a skill on for an agent that reads a different folder makes a link in that agent's own
folder that points at the skill's real folder, so the files stay in one place. Turning it off
removes that link and nothing else.

- An agent that reads the skill's own folder directly has no link to remove. Claude, Codex and
  OpenCode (and Pi, for Global skills) have a setting for it, so turning the skill off writes that
  setting, and turning it on takes it away again. A project or organization setting can still
  decide, and T3 Code says so. Cursor, Grok and Antigravity have no such setting, so their switch is
  disabled and the skill stays on. To stop one using the skill, move the skill out of that folder
  yourself.
- Agents that read the same folder share one link, so turning a skill on or off for one can change
  it for the others. T3 Code says who else is affected.
- If something is already in the agent's folder under that name, such as a real folder, a file or
  a link to a different skill, T3 Code leaves it alone and says so. It never replaces anything.
- A project's links to skills inside the project are relative, so they keep working when the
  project moves. They show in `git status`; commit them to give everyone who clones the project
  the skill. On Windows, global links are junctions, and project links need Developer Mode or
  administrator rights.

Skills the installer recorded as coming from the same place, such as a GitHub repo, are grouped
together when there are two or more.

## Acting on several skills

Choose **Select** to act on several skills at once: turn them on or off for every agent, delete
them, or put them in projects with **Use in…**. Ticking a group ticks all of its skills.

## Using a skill in projects

**Use in…** chooses where a skill is used: **This project only**, **Globally**, or **Only these
projects**, which lists the projects of this environment. A skill used in only some projects is
still Global, with one copy, so an edit shows up in all of them. Each change asks first, and never
merges into or replaces a skill with the same name; T3 Code leaves both and says so. When git
tracks a project skill that leaves its project, the confirmation says you can undo it with git.

Such a skill is linked into each project that uses it, outside git, and into the worktrees T3 Code
makes for those projects. The agents that read `.agents/skills` have it in all of them. Turning on
an agent with a folder of its own, such as Claude, adds its link in each of those projects, never
in Global. If a moved skill's installer record can't go with it, T3 Code says the skill won't
update from its source any more.

**Delete** removes the skill's folder and the links to it, and can't be undone. Only a skill kept
in an agent's own skill folder can be deleted. One that is only linked there, such as a skill from
a synced folder, stays where it is.

Agents running in T3 Code can list skills and turn them on or off for agents too; they can't
move or delete them.

## Needs attention

**Needs attention** filters the list to skills that need a look. A skill is on it when:

- an installed and enabled agent doesn't use it. An agent loads one skill per name, the first it
  finds in its folders (Codex and OpenCode list every copy), so a copy that another folder shadows
  is not used by that agent. Claude doesn't use a skill that its own `skillOverrides` setting
  switches off either.
- the same name exists more than once with different text, in **This project**, in **Global**, or
  across them.
- Claude can't read the skill's header, the YAML between the `---` lines at the top of
  `SKILL.md`, so it skips the skill. Quote a value that contains a colon or brackets, for example
  a description.

## Limits

- Only a project's top folders are read, such as `<project>/.agents/skills`, not the folders
  above it that some agents also read.
- A skill's file list stops at 500 files, and `SKILL.md` isn't shown past 1 MB.
- A `SKILL.md` that is a link to a file outside the skill's folder isn't read.
