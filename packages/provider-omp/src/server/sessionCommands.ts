import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export const ompSessionCommands = [
  { name: "omp:queue", description: "Show Oh My Pi's native steering and follow-up queue" },
  {
    name: "omp:follow-up",
    description: "Queue a native follow-up using Steer now while Oh My Pi is running",
    input: { hint: "<message>" },
  },
  {
    name: "omp:queue-remove",
    description: "Remove a native queue entry using Steer now",
    input: { hint: "<steering|followUp> <exact queued text>" },
  },
  {
    name: "omp:queue-promote",
    description: "Move a native follow-up to the steering queue using Steer now",
    input: { hint: "<exact queued text>" },
  },
  {
    name: "omp:queue-deliver",
    description:
      "Interrupt the current Oh My Pi response and deliver its native queue using Steer now",
  },
  {
    name: "omp:queue-mode",
    description: "Set how Oh My Pi delivers queued messages for this session",
    input: { hint: "<steering|followUp> <all|one-at-a-time>" },
  },
  {
    name: "omp:interrupt-mode",
    description: "Set when incoming steering interrupts Oh My Pi tools",
    input: { hint: "<immediate|wait>" },
  },
  {
    name: "omp:fast",
    description: "Set fast mode for the current Oh My Pi model",
    input: { hint: "<on|off>" },
  },
  {
    name: "omp:slow",
    description: "Set slow mode for the current Oh My Pi model",
    input: { hint: "<on|off>" },
  },
  {
    name: "omp:auto-compact",
    description: "Toggle native automatic context compaction",
    input: { hint: "<on|off>" },
  },
  {
    name: "omp:auto-retry",
    description: "Toggle native automatic request retry",
    input: { hint: "<on|off>" },
  },
  {
    name: "omp:cache-warming",
    description: "Set Oh My Pi's native cache warming mode",
    input: { hint: "<off|streaming|idle>" },
  },
  { name: "omp:todos", description: "Show Oh My Pi's current todo list" },
  {
    name: "omp:todos-set",
    description: "Replace Oh My Pi's todo list with a Markdown checklist",
    input: { hint: "<Markdown checklist>" },
  },
  { name: "omp:todos-clear", description: "Clear Oh My Pi's todo list" },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;

function parseTodoChecklist(text: string) {
  const phases: Array<{
    name: string;
    tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  }> = [];
  let current: (typeof phases)[number] | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(line.trim())?.[1];
    if (heading) {
      if (current?.tasks.length === 0) return undefined;
      current = { name: heading, tasks: [] };
      phases.push(current);
      continue;
    }
    const task = /^[-*]\s+\[([ xX~])\]\s+(.+)$/u.exec(line.trim());
    if (!task?.[2]) return undefined;
    if (!current) {
      current = { name: "Todos", tasks: [] };
      phases.push(current);
    }
    current.tasks.push({
      content: task[2],
      status: task[1] === " " ? "pending" : task[1] === "~" ? "in_progress" : "completed",
    });
  }
  return current?.tasks.length ? phases : undefined;
}

export function readSessionCommand(text: string) {
  const command = /^\/omp:([\w-]+)(?:\s+([\s\S]+))?$/u.exec(text.trim());
  const name = command?.[1];
  if (!name || !ompSessionCommands.some((entry) => entry.name === `omp:${name}`)) return undefined;
  const args = command?.[2] ?? "";
  switch (name) {
    case "queue":
      if (!args) return { type: "show_queue" } as const;
      break;
    case "follow-up":
      if (args) return { type: "follow_up", message: args } as const;
      break;
    case "queue-remove": {
      const parsed = /^(steering|followUp)\s+([\s\S]+)$/u.exec(args);
      if (parsed?.[1] && parsed[2]) {
        return { type: "remove_queued_message", queue: parsed[1], message: parsed[2] } as const;
      }
      break;
    }
    case "queue-promote":
      if (args) return { type: "promote_queued_message", message: args } as const;
      break;
    case "queue-deliver":
      if (!args) return { type: "abort_and_deliver_queue" } as const;
      break;
    case "queue-mode": {
      const queueMode = /^(steering|followUp)\s+(all|one-at-a-time)$/u.exec(args);
      if (queueMode?.[2]) {
        return {
          type:
            queueMode[1] === "steering"
              ? ("set_steering_mode" as const)
              : ("set_follow_up_mode" as const),
          mode: queueMode[2],
        };
      }
      break;
    }
    case "interrupt-mode":
      if (args === "immediate" || args === "wait") {
        return { type: "set_interrupt_mode", mode: args } as const;
      }
      break;
    case "fast":
    case "slow":
    case "auto-compact":
    case "auto-retry": {
      if (args !== "on" && args !== "off") break;
      const types = {
        fast: "set_fast_mode",
        slow: "set_slow_mode",
        "auto-compact": "set_auto_compaction",
        "auto-retry": "set_auto_retry",
      } as const;
      return { type: types[name], enabled: args === "on" } as const;
    }
    case "cache-warming":
      if (args === "off" || args === "streaming" || args === "idle") {
        return { type: "set_cache_warming", mode: args } as const;
      }
      break;
    case "todos":
      if (!args) return { type: "show_todos" } as const;
      break;
    case "todos-set": {
      const phases = parseTodoChecklist(args);
      if (phases) return { type: "set_todos", phases } as const;
      break;
    }
    case "todos-clear":
      if (!args) return { type: "set_todos", phases: [] } as const;
      break;
  }
  return { type: "invalid_session_command" } as const;
}
