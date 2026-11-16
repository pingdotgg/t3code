---
name: ak-help
description: |
  List every skill available here, from this repo's workflow skills and from whatever the
  harness provides, then say which ones apply to what is happening right now. Pass a task
  description to route that instead of the current conversation.
---

# ak-help: what is available, and what applies here

Answer two questions in one pass. What is available, and what should be used right now. The
second is the point; a bare inventory is something the user could read off a directory listing.

## Step 1: enumerate what is available

Two sources, and you need both.

**Workflow skills.** This fork ships its skills under `workflow/skills/<group>/<name>/SKILL.md`.
Read them from disk rather than from memory. From the T3 Code checkout (the main checkout is
`~/Projects/T3/t3code` when you are not already in one):

```bash
for f in workflow/skills/*/*/SKILL.md; do
  group=$(basename "$(dirname "$(dirname "$f")")")
  name=$(sed -n 's/^name:[[:space:]]*//p' "$f" | head -1)
  desc=$(sed -n 's/^description:[[:space:]]*//p' "$f" | head -1 | cut -c1-120)
  printf '%s\t%s\t%s\n' "$group" "${name:-$(basename "$(dirname "$f")")}" "$desc"
done | sort
```

A `description: |` line prints as `|`; read the next lines of that file when you need the text.

**Harness skills.** Your harness also reports skills in your context: built-ins, plugins, and
anything installed outside this repo. Add every one that the sweep above did not already list,
with its source as the harness names it. They vary by provider and version, so another machine
or provider may have a different set.

## Step 2: work out what the user is actually doing

With a task description from the user, route that task. Without one, read the conversation and
name the current task in one sentence before recommending anything. Getting this wrong makes every
recommendation wrong, so state it and let the user correct you.

Look for the concrete shape of the work, not its topic. "Working on auth" routes nowhere. "About
to restructure how auth state is stored, across about fifteen call sites" routes to a design skill,
a blast-radius check, and a principle about migrating callers.

## Step 3: recommend

At most five, ranked, most applicable first. Fewer is better than padding.

```
## Current task
[One sentence. What the user is doing right now.]

## Applies here

| Skill | Source | Why now | What it does to your work |
|-------|--------|---------|---------------------------|
| `x` | ak | [the specific trigger you saw, not a paraphrase of the description] | [what changes if they run it] |

## Also available, not for this
[One line per near-miss that the user might have expected to see, with why it does not fit.
Skip this section when there are no near misses.]
```

Rules for the recommendations:

- Point at the trigger you actually observed. "You are about to write a migration across many
  files" beats "this skill is for migrations."
- Say what running it changes. A skill that would tell them something they already decided is not
  a recommendation.
- Rank on fit, not on which group or source owns it. A harness skill that fits better than an
  `ak` one goes first.
- Never invent a name. Every skill you name must have come out of Step 1.
- Principle skills are reference material, not actions. Group them into one row rather than
  listing six.

## When nothing fits

Say so in one line and stop. "Nothing available fits this; it is a plain edit" is a useful answer
and the most common correct one for small work. Do not reach for the nearest-sounding skill to
avoid an empty table.

If the gap looks real and recurring, that is worth one line too, pointing at the `automate-me`
or `writing-for-agents` skill for capturing it as a new skill.

## Notes

- Read `workflow/skills/pstack/ATTRIBUTION.md` or `workflow/skills/mattpocock/ATTRIBUTION.md`
  when the user asks where a vendored skill came from or why a related one is missing.
