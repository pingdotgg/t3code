# Task graphs

A task graph splits one request into agent tasks that run in parallel. Ask an
agent something like "audit auth, billing and uploads for security issues and
fix what you find", and it can plan a graph: one node per area, then a node
that combines their work. Each node runs as its own thread in its own git
worktree, and starts as soon as the nodes it depends on have succeeded.

The graph appears above the composer of the thread that planned it. Open a
node to watch its thread, or open the editor to change the plan.

## Running or reviewing first

By default a graph starts as soon as the agent proposes it. To review plans
first, turn off **Settings → General → Run task graphs automatically**; graphs
then wait as drafts until you choose **Run**. Your wording wins over the
setting in either direction: "show me the plan first" gets a draft, and "just
do it" runs straight away.

**Task graph nodes at once** in the same section limits how many nodes run on
this machine at the same time. Nodes also wait while the machine is nearly out
of CPU or memory.

## Changing a graph

In the editor you can add tasks, edit or delete tasks that have not started,
and drag between tasks to add a dependency. While the graph runs:

- **Cancel branch** stops a task and everything that depends on it.
- **Retry** reruns a task that failed or was cancelled, along with the tasks
  that were skipped because of it.
- **Cancel graph** stops everything that is still running.

You can also ask the agent to change the graph in chat, such as "drop the
billing branch" or "add a docs task after the merge". Mobile shows the graph
and offers Run, Cancel, Cancel branch and Retry.

## Branches and pull requests

A task with no dependencies branches from the thread's branch. A task with one
dependency branches from that task's branch. A task with several dependencies
starts from the first one's branch and merges the others; its agent resolves
any merge conflicts.

When a task succeeds, its work is committed. Tasks that nothing depends on
also push and open a pull request, so each end of the tree becomes one pull
request. When the whole graph finishes, the thread that planned it gets a
summary with each task's result and pull request.

## Running tasks on other machines

A graph can spread its tasks across your other T3 Code machines. On the other
machine, create a pairing link (see [Remote access](./remote-access.md)). On
this machine, paste it under **Settings → Connections → Task graph machines**.
Both machines need the project open from the same repository.

This machine only gets permission to start, watch and stop threads and push
branches there. It cannot read files, open terminals or change settings. To
unpair, remove the machine here, then revoke the session from the other
machine's connected clients.

Tasks go to whichever machine has the most free CPU and memory, adjusted by
each machine's preference (**Prefer**, **Normal**, **Less often** or **Manual
only**). With a machine paired, task branches are pushed to your remote so the
other machines can build on them. Tasks on another machine run in the same
permission mode as the thread that planned the graph.
