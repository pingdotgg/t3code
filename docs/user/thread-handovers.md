# Thread handovers

When a thread reaches its configured context-token limit, create a compact handover to continue in a new thread. With an enabled Codex instance, **Handover to new thread** uses GPT 5.6 Luna with high reasoning to summarize the thread and opens a new draft in the same checkout. Review the draft and choose its model and reasoning level before sending. Saved handovers remain available after a failed navigation or capability change. Without generation support, start a new thread manually.
