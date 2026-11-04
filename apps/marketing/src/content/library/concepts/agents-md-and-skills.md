---
title: "AGENTS.md and skills for coding agents"
description: "Write focused agent instructions and reusable skills for T3 Code workflows, with Theo's guidance on triggers, examples, and provider setup."
updated: 2026-11-04
sources:
  - label: "Theo distinguishes project instructions from a README"
    url: "https://www.youtube.com/watch?v=e1snsuY4lTI&t=1441s"
  - label: "Theo explains skill descriptions and concrete examples"
    url: "https://www.youtube.com/watch?v=e1snsuY4lTI&t=720s"
  - label: "Theo explains repeated workflows and skill scope"
    url: "https://www.youtube.com/watch?v=5Bmp9cz1JN8&t=0s"
  - label: "Theo discusses memory and current code"
    url: "https://www.youtube.com/watch?v=Jf54k7tFeEc&t=180s"
  - label: "Theo discusses asking for information"
    url: "https://www.youtube.com/watch?v=m-B3jIMMmUE&t=360s"
  - label: "Repository instructions and glossary"
    url: "https://github.com/pingdotgg/t3code/blob/main/AGENTS.md"
  - label: "Commands and skills"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Claude skills and configuration"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Cursor configuration"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
faq:
  - question: "Does T3 Code have its own universal skills folder?"
    answer: "T3 Code lists skills for the selected environment and provider. Configure skills where that provider expects them rather than assuming one installation makes them available to every agent."
  - question: "What should I put in AGENTS.md?"
    answer: "For T3 Code workflows, Theo recommends instructions that help an agent change the project: constraints, terminology, verification, and concrete examples of desired behavior."
  - question: "How do I invoke a skill in T3 Code?"
    answer: "Type $ in the T3 Code composer to select a skill from the current environment and provider. Skills can also appear in the slash menu when that setting is enabled."
  - question: "Why does a new skill not appear?"
    answer: "Check the T3 Code environment, provider, skill location, and enabled state. After changing skills, plugins, or MCP servers, use Restart agent session on web or desktop."
---

T3 Code exposes skills from the selected environment and provider, so your instructions need to match the agent running the task. Theo Browne recommends project instructions that explain how to change the codebase and skills that capture workflows you repeat. His examples are patterns to adapt to your project and observed failures.

## What belongs in AGENTS.md instead of a README?

At 24:01 in his AGENTS.md and SKILLS.md breakdown, Theo distinguishes the audience and purpose of these files. A README helps someone understand a project and decide whether to use it. Agent instructions should help the agent make changes correctly and communicate with the developer.

Some project context still belongs in instructions. The useful question is what the agent needs before editing. A glossary, a constraint that must survive a change, or the correct verification command can prevent a concrete mistake.

The T3 Code repository's own `AGENTS.md` illustrates that approach. It defines terms such as provider, client, environment, and thread. It also identifies the project's priorities and explains how to verify changes. Treat this as an example of project-specific instructions, not a template to copy into unrelated repositories.

| Information you need to express             | Suggested home                      |
| ------------------------------------------- | ----------------------------------- |
| A constraint for changes across the project | Project agent instructions          |
| A term the agent should use consistently    | A short glossary                    |
| A repeatable workflow needed for some tasks | A focused skill                     |
| A requirement unique to the current task    | The current request                 |
| A fact discoverable in current source       | Ask the agent to inspect the source |

## How do you write a skill the agent can select?

Theo's advice at 12:00 to 15:00 centers on triggers and examples. He treats the description as a signal for when the model should load the skill. A long explanation of every step can obscure that signal.

Start with a workflow you already repeat. In his three-skills video, Theo says his skills grew from behaviors he kept using. That gives you a concrete reason for the file to exist and something to test it against.

1. Name the recurring task you want the skill to handle.
2. State when the skill should be invoked.
3. Write the steps the agent needs for that task.
4. Add a short example of a previous failure and the desired result.
5. Try it on a bounded task and inspect what the agent does.
6. Remove instructions that repeat existing rules or expand the task unnecessarily.

For example, a pull-request description skill can show a confusing implementation-heavy opening and a clear problem-and-result opening. Theo uses this kind of contrast to explain his preference. The value comes from a specific correction the agent can apply.

## How much work should a skill trigger?

Theo cautions against turning ordinary tasks into automatic multi-agent panels. In [You're using AI agents wrong](/learn/videos/using-ai-agents-wrong), his prompts establish priorities and give the agent room to investigate. His instruction-file breakdown adds explicit file ownership when several agents do work in parallel.

His review-loop skill also has a stopping point. At 5:01 in the three-skills video, he warns that repeated reviews can expand scope. He recommends keeping the original goal clear and challenging feedback that would make the change unnecessarily large.

Adapt that principle to your workflow: define the result, permitted scope, verification, and stopping condition. A skill should make the repeated task predictable enough to review.

## Where do skills load from in T3 Code?

T3 Code's composer lists skills for the selected provider and environment. Type `$` to choose one. The slash menu also includes skills unless you disable `Settings → Chat → Show skills in slash menu` under Advanced.

For Claude, skills come from the configured Claude directory's `skills` folder and the project's `.claude/skills` folder. If both define the same name, the config-directory copy wins. Skills disabled in Claude settings do not appear in the composer. The [Claude provider guide](/learn/providers/claude-code) covers configuration-specific details.

After adding or changing skills, plugins, or MCP servers, use `Restart agent session` from the command palette on web or desktop. The conversation continues, and the next message starts the agent with the new setup.

If a skill is missing, first check the environment and provider. [The harness explanation](/learn/concepts/what-is-a-harness) covers why a Claude skill does not automatically become a Codex skill. Cursor likewise reads configuration from its environment machine; its guide documents its own configuration locations and restart requirement.

## Should memory replace project instructions?

Theo argues against treating hidden coding memories as a second source of truth in his memory video. He agrees with the concern that stale descriptions can steer agents away from the current code. That is his position on maintaining coding context, not a claim that T3 Code disables provider memory.

Use the practical test behind his argument: can the agent verify the fact in current source, and will an extra instruction become stale? Keep durable constraints clear, then let the agent inspect the repository for facts that change.

## Next steps

Review [the provider and harness distinction](/learn/concepts/what-is-a-harness), then use [thread context](/learn/threads/messages-and-context) for the current task's requirements.

Return to [Ideas behind T3 Code](/learn/concepts) for the broader workflow, or [download T3 Code](/download) to try an installed provider's skills.
