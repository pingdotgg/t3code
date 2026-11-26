---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research (in T3 Code: `delegate_task`, which runs in the background by default), so you keep working while it reads. Start it with a fresh context window. When you already are that agent, as a `wayfinder` research subagent is, do the job yourself instead of starting another.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the caller says, such as `wayfinder`'s throwaway `research/<name>` branch. Otherwise save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
