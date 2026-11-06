---
title: "Agents sucked at UI (until today)"
description: "Follow Theo's T3 Code UI experiment: compare real screenshots, gather model critiques, revise the design, and distinguish review scores from user evidence."
updated: 2026-11-04
sources:
  - label: "Theo Browne: Agents Sucked At UI (Until Today)"
    url: "https://www.youtube.com/watch?v=xq0eB8vxeqk"
  - label: "Visual replies (docs/user/html-renders.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md"
  - label: "Messages, goals, and attachments (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Remote browser and mobile access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
faq:
  - question: "How does Theo get agents to improve the T3 Code UI?"
    answer: "Theo compares screenshots, asks several models for critique, applies changes, and repeats. T3 Code organizes the work, but the review criteria and reference images come from his experiment."
  - question: "Does T3 Code include Theo's council skill?"
    answer: "The video shows a skill Theo configures for his own workflow. It should not be treated as a built-in T3 Code design service or a required default."
  - question: "Can T3 Code show visual explanations in a thread?"
    answer: "Yes. T3 Code supports self-contained HTML visual replies, including diagrams, charts, and mockups. You can ask an agent for a visual explanation instead of relying on text alone."
video:
  id: "xq0eB8vxeqk"
  title: "Agents Sucked At UI (Until Today)"
  durationSeconds: 1905
  chapters:
    - time: "0:00"
      label: "Can agents improve T3 Code's design?"
    - time: "4:01"
      label: "Turn a design criticism into a task"
    - time: "6:00"
      label: "Define the council review loop"
    - time: "11:00"
      label: "Inspect the first design changes"
    - time: "13:00"
      label: "Add competing interfaces as references"
    - time: "17:01"
      label: "Sequence reviews and track improvements"
    - time: "19:01"
      label: "Raise the target and question the scores"
    - time: "21:02"
      label: "Inspect time and usage estimates"
    - time: "23:01"
      label: "Restore color and check readability"
    - time: "26:01"
      label: "Turn repeated failures into an evaluation"
    - time: "29:01"
      label: "Reduce context while preserving behavior"
---

T3 Code is both the workspace and the subject of Theo's experiment in improving UI with agents. He turns design criticism into repeated screenshot reviews, compares the results with other apps, and revises until he prefers the output. The video matters for users who need a repeatable way to judge visual work instead of accepting an agent's first design.

## What Theo covers: turn criticism into an observable task

The introduction starts with criticism of T3 Code's appearance. Theo accepts that the interface needs work and asks whether agents can help close the gap. The task becomes concrete when he supplies the criticism and asks for an improved result.

At 4:01, he explains how that request begins. The criticism names details such as fonts, radii, icons, and hierarchy. Those observations are more actionable than an instruction to make an app look better without saying what is wrong.

At 6:00, he defines an iterative process. Several models inspect screenshots and give feedback. The implementation changes, then the reviewers inspect the next version. A new pass is a new review, rather than an assumption that fixing a previous complaint earns approval automatically.

The useful pattern is to make the result observable. Reviewers need the rendered interface. Looking only at the source would make them infer visual relationships that a screenshot shows directly. A developer still needs to decide whether the screenshots cover the states that matter.

## What Theo covers: a score needs a reference

At 11:00, Theo looks at the first improvements. He asks the agent to explain the differences visually because the changes are difficult for him to identify at a glance. The resulting annotations connect observations to specific parts of the interface.

The changes include typography, labels, truncation, card shapes, and inline code styling. The important feature of this stage is that the reviews produce inspectable changes. A rising number alone would not show what became clearer or easier to read.

At 13:00, Theo decides the result still falls short after comparing it with other apps himself. He supplies those reference screenshots to the agents. Scores change when the comparison changes, even though the earlier review had already met its target.

This exposes a limit of a numerical design goal. The same reviewer may give a different score in another context. A useful review therefore needs reasons, examples, and comparable screenshots. The score can help track a conversation, but it cannot substitute for the evidence behind it.

## What Theo covers: spend review effort where it helps

At 17:01, Theo changes the order of reviews. One reviewer continues checking revisions before the others return. This reduces repeated calls to every model while the work still has known problems.

The reviewers also disagree. A design that receives a high score from one still receives a lower score from another. Theo uses that disagreement to continue improving consistency, contrast, and hierarchy, rather than treating the first favorable result as final.

At 19:01, he raises the target again and creates a separate worktree for further experimentation. That lets an already useful version remain available while he explores whether another pass improves it.

Around 20:00, Theo questions whether telling reviewers the target score influences their answers. He also observes that scores for unchanged reference images drift. Those admissions are central to understanding the experiment. Model review is useful feedback, but its numbers are not calibrated measurements of design quality.

## What Theo covers: preserve human judgment in the loop

At 21:02, Theo inspects time and usage estimates. His reported totals describe this particular run. Some figures depend on assumed model prices or subscription usage, so they are not a reliable budget for repeating the experiment.

At 23:01, he supplies another preference: restore color after the design becomes too gray. The next comparisons show changes he finds easier to read and understand. The improvement comes partly from a human identifying what the previous goal failed to express.

That sequence is useful when an agent optimizes the wrong quality. Instead of extending the same vague instruction forever, identify the missing criterion. Ask for evidence that the next change addresses it across the relevant screens and themes.

The video does not establish that model agreement guarantees a good design for your users. It demonstrates a way to generate and inspect alternatives. Your product's tasks, users, and constraints still determine what a successful interface needs to do.

## What Theo covers: turn repeated failures into an evaluation

At 26:01, the subject shifts from UI to T3 Code's agent-facing descriptions. Theo collects examples where agents choose the wrong operation, turns them into evaluation cases, and asks for changes that improve the results.

At 29:01, he adds another constraint: reduce description size while preserving successful behavior. That creates a more concrete optimization problem than asking whether a screen looks good. The cases define what should keep working while the implementation changes.

The connection between the two examples is the feedback loop. Define the outcome, expose evidence, change the input, and check again. The difference is how strong the check is. A behavior test can catch a specific regression; a design score remains an opinion that needs inspection.

## What it means for you in T3 Code

Use [visual replies](/learn/workspace/visual-replies) to ask for an annotated comparison or diagram. T3 Code can display self-contained HTML pages in the thread. The feature page has the current behavior, including support across web, desktop, and mobile.

Use [messages and context](/learn/threads/messages-and-context) to attach the screenshot and explain the part that needs attention. State the task the screen should help a user complete. A reference image is more useful when the agent knows which qualities you want to carry over.

Use [parallel agent work](/learn/concepts/run-agents-in-parallel) for independent critique, with one clear owner for implementation. A small review table can keep disagreements visible:

| Reviewer observation      | Evidence to request                                       |
| ------------------------- | --------------------------------------------------------- |
| Text is hard to read      | The same screen in the relevant theme and size            |
| Hierarchy is unclear      | An annotation showing what should attract attention first |
| A change regresses a flow | The affected state before and after the change            |

Use [source control](/learn/workspace/source-control) to inspect the change that produces the screenshots. Use [mobile access](/learn/remote/mobile-apps) when reviewing from a phone, while keeping execution on the host. Avoid copying the video's temporary design-toggle instructions as current setup.

## Next steps

Read [You're using AI agents wrong](/learn/videos/using-ai-agents-wrong) for Theo's broader verification workflow. Return to [Theo on T3 Code](/learn/videos) to choose another experiment or product walkthrough.
