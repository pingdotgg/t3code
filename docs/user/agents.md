# Agents

The Agents view shows subagents and workflow members attached to a thread. It keeps running,
waiting, idle, completed, stopped, and failed agents together so large batches can be monitored
without expanding the thread's work log.

On mobile, open **Agents** from the thread and tap an agent to see its role, model, elapsed time,
token and tool usage, result or error, and recent activity. The activity list retains the latest six
entries and collapses consecutive duplicate summaries. When older entries have been dropped, the
detail view labels the list as truncated.

Direct links to an agent detail open the same live thread data as the Agents list. If the agent is no
longer present in retained activity, the detail view says that the agent is unavailable. A direct
link opened as the first screen also provides a way back to the threads list.

## Stopping background work

**Stop background work** interrupts the active provider turn and its background agents. The
request is checked against the provider-session state shown when Stop was pressed. If a newer turn
or session becomes active first, the newer work is left running and the app reports **Work already
changed**. While a Stop request is being resolved, another Stop request cannot be started.
