# Model evaluations

Open **Settings → Labs → Zack · Model evaluations** and enable **Blind model evaluations** for the
environment where your agents run. It starts off because evaluating a task uses an additional
model call. Use **Judge model** to select the provider and model that scores tasks, independently
of the model doing the work. **Use default** returns it to the environment's text generation model.
Only providers that can judge without tools or access to the project are available.
The evaluator uses the same background generation system as thread titles, with its own optional
model choice. Claude and Pi can serve as judges when available. A supported judge can
evaluate work from any harness, including Codex; the harness that produced the work does not need
to support judging. Choose an available judge before enabling the setting.
The selected judge is used for new evaluations. If it is unavailable, the evaluation fails visibly
instead of switching to another model. Claude judges require a CLI that supports `--safe-mode`,
which keeps account authentication while disabling custom instructions and extensions.

After a task ends, T3 Code gives the judge the request, relevant conversation context, and available
outcome evidence with model and provider labels removed. The same process covers subagent threads
run through T3's orchestration. Model names mentioned inside free-form text may be harder to remove
completely, and tool output keeps its structure and any token, cost, or timing figures a tool
reports. Those can hint at which harness ran the task, so blind evaluation reduces identity cues
without guaranteeing anonymity.

The judge scores task completion, correctness, instruction following, and verification from 0 to 4.
When the evidence cannot establish a score, that dimension stays unscored. A claim that tests passed
is not the same as a recorded test result. Failed evaluation calls and insufficient evidence remain
visible in recent evaluations, instead of becoming poor performance scores for the evaluated model.

## Inspect and use guidance

Choose a project under **Learned guidance** to see its recent evaluations and accumulated strengths,
limitations, and prompting advice. Results stay within that project and environment. T3 keeps
separate groups for different model options, task categories, top-level versus subagent tasks,
judges, and scoring rubrics, so a change of judge does not silently mix two scales.

Guidance reflects up to 200 observations from the past 90 days. The displayed sample counts show
how much evidence supports each score. Small samples remain provisional, and all guidance is an
aid to judgment rather than a guarantee about future tasks. Observed prompt lengths describe past
requests; they do not measure a model's maximum context window or establish an ideal prompt length.

Agents using T3's orchestration can retrieve this guidance when choosing models and framing delegated
tasks. Your explicit model choice still wins. Turning evaluations off stops new evaluation calls
and use of the guidance while leaving saved history available to inspect. **Clear project history**
removes that project's scores and learned guidance; later tasks can collect new observations.
