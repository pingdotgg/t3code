# pstack

pstack is [Lauren Tan's](https://github.com/cursor/plugins/tree/main/pstack) set of rigorous agent
workflows, such as `architect`, `arena`, `how`, `why`, and `poteto-mode`. T3 Code ships it built in
and runs it through its orchestration tools across supported providers. Its multi-model steps can mix providers. For example,
one `$pstack:architect` can run an Opus runner and a GPT runner side by side, whichever provider
your thread uses.

## Turn it off

pstack is on by default. To turn it off, open **Settings → Labs → Zack** and turn off **pstack**. The
setting applies to one environment. Turning it off removes the `pstack:` skills from the composer
and keeps your model choices.

## Choose models once

Run `$pstack:setup-pstack` in any thread. It reads the providers and models this environment offers,
asks for a reasoning budget, shows every pstack role with its models, and saves your choices for every
provider's threads on this machine. Run it again to change them, or after you enable or add a
provider. Until you run it, pstack matches its defaults to models advertised by this environment's
available providers, including models offered through another harness. Models without a reasoning
setting keep their own defaults.

List several models on a role to give pstack a pool that picks one per spawn. Arena runners,
architect runners, and interrogate reviewers are panels that run every model listed.

## Run a workflow

Type `$` or `/` in the composer and pick a `pstack:` skill, for example `$pstack:architect design the
cache layer`. Start rigorous work with `$pstack:poteto-mode`; it picks the other skills as it goes.
Helper agents appear under the thread as tasks you can open, follow, or stop.
Use `$pstack:automate-maintainer` or `$pstack:automate-team` to capture a maintainer’s or team’s engineering conventions.
Mentioning pstack without a skill, such as “use pstack principles”, points the agent at T3 Code’s copy so it can read the skills, but runs no workflow.

When a model becomes unavailable, pools use their remaining choices; if none remain, they use your
thread’s model. Panels keep every seat, using your thread’s model for unavailable entries. The reply
explains each unavailable choice with `Fallback: …`; run `$pstack:setup-pstack` to change it.
If your thread's provider cannot start a child either, pstack reports the unavailable seat and checks
the current capabilities before choosing another target.

## Good to know

- pstack runs on the machine the thread runs on. A linked machine needs pstack on and its own
  `$pstack:setup-pstack`, since its providers differ.
- OpenCode sessions using an external **Server URL** do not expose T3's orchestration tools. Leave
  that setting blank to let T3 manage the server before running a pstack workflow.
- Long-running workflows use T3 Code's scheduled tasks and pull request watching. Remove schedules you
  no longer need from the scheduled tasks list.
- Steps that need a Cursor-only feature, such as Bugbot setup or a Cursor cloud machine, are skipped
  with a one-line note in the reply.
- If you also installed pstack as a Codex or Claude Code plugin, T3 Code turns that plugin off in
  the sessions it starts while pstack is on, so agents see one copy. Your own Codex and Claude Code
  sessions outside T3 Code keep it. A Cursor install is only replaced in the composer. Only the
  T3 Code skills can mix providers.
