# Exploro

Exploro is an open-source agent harness for manual QA engineers. You give it a
website and a testing goal; an agent explores the site in a real browser, and you watch, take
over, and keep the evidence.

Exploro is a fork of [T3 Code](https://github.com/pingdotgg/t3code). We keep T3's provider
sessions, streaming, approvals and clients, and build the QA experience on top. `AGENTS.md`
still describes the T3 codebase and applies here; this file only adds what is different.

## Decisions

- **Browser: T3's built-in browser.** Agents drive it through the `preview_*` MCP tools that
  every MCP-capable provider already receives from the `t3-code` server. Tabs belong to a thread,
  and screenshots, recordings, console and network capture already exist. Do not add a second
  browser tool or provider-specific browser wiring without a reason that issue tracking records.
- **No second agent loop.** Exploro adds QA workflow and UI around T3's orchestration. It does
  not add its own planner, model bridge or verifier.
- **Prompt text is not enforcement.** Limits such as which sites a session may visit belong in
  the server.
- **QA engineers only.** Where T3 shows developer workflow (editors, project scripts, git,
  branches, pull requests, dev servers), Exploro shows the QA workflow instead. Hide those
  features in the UI, together with their keybindings and command palette entries; do not delete
  upstream code, so T3 merges stay easy.
- **Evidence is server-owned.** Each QA run writes `<home>/userdata/qa-runs/<thread>/<run>/`
  (`run.json`, `report.md`, a self-contained `report.html`, `evidence/`). Runs are kept until
  the user deletes them. A verdict without a screenshot is stored as INCONCLUSIVE, whatever the
  agent asked for.

## Develop

Follow the toolchain in `AGENTS.md` (`vp i`, Node pinned in `package.json`). In this main
checkout, always give the dev server its own state outside the repository:

```bash
vp run dev --home-dir ~/.exploro/dev
```

Without `--home-dir` the main checkout uses the shared `~/.t3/dev`. A state directory inside
the repository turns off threads without a project, which the QA start screen needs.

On Linux hosts that restrict user namespaces, the browser needs a one-time setup that the
developer runs themselves:

```bash
cd apps/server && sudo env "PATH=$PATH" node src/bin.ts browser setup --base-dir ~/.exploro/dev
```

## QA skill

`skills/exploro-qa/SKILL.md` is the QA method agents follow. Exploro sends it to every agent that has
the browser tools, as part of its built-in instructions, so nothing needs installing and users don't
have to name the skill. The agents get the copy in
`packages/provider-core/src/server/exploroQaInstructions.ts`. When you edit the skill, copy its body
there too. A test fails until the two match.

To use the skill outside Exploro, copy it to `~/.claude/skills/` (Claude) or `~/.agents/skills/`
(Codex). Inside Exploro those copies aren't needed.

## Workflow

- Work is tracked as GitHub issues on `imavinashsingh/exploro`: one issue per user story with
  acceptance criteria, labelled `story` + `sprint-N`, or `backlog`.
- One branch per story (`exploro/<story>`), reviewed before merging to `main`.
- A story is done only when its acceptance criteria are shown working in the real app, not
  only in unit tests.
- Upstream T3 Code is merged in periodically. Keep Exploro changes small and close to the
  feature that needs them so those merges stay easy.

## License

T3 Code is MIT licensed. Keep its `LICENSE` and copyright notices.
