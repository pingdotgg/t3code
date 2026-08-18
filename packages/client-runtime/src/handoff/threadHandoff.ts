export interface ThreadHandoffInput {
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly modelSelection?:
      | {
          readonly instanceId: string;
          readonly model: string;
        }
      | null
      | undefined;
    readonly messages?:
      | ReadonlyArray<{
          readonly role: "user" | "assistant" | "system";
          readonly text: string;
          readonly attachments?:
            | ReadonlyArray<{
                readonly name?: string | undefined;
                readonly path?: string | undefined;
              }>
            | undefined;
        }>
      | undefined;
    readonly activities?:
      | ReadonlyArray<{
          readonly tone: string;
          readonly kind: string;
          readonly summary: string;
          readonly payload?: unknown | undefined;
        }>
      | undefined;
    readonly proposedPlans?:
      | ReadonlyArray<{
          readonly planMarkdown: string;
        }>
      | undefined;
    readonly checkpoints?:
      | ReadonlyArray<{
          readonly files: ReadonlyArray<{
            readonly path: string;
            readonly kind?: string | undefined;
            readonly additions?: number | undefined;
            readonly deletions?: number | undefined;
          }>;
        }>
      | undefined;
  };
  readonly targetModelSelection?: {
    readonly instanceId: string;
    readonly model: string;
  } | null;
}

export function buildThreadHandoffMarkdown(input: ThreadHandoffInput): string {
  const { thread, targetModelSelection } = input;
  const sections: string[] = [];

  const sourceModelLabel = thread.modelSelection
    ? `${thread.modelSelection.instanceId} (${thread.modelSelection.model})`
    : "previous model";
  const targetModelLabel = targetModelSelection
    ? `${targetModelSelection.instanceId} (${targetModelSelection.model})`
    : "new model";

  sections.push(
    `# Task Continuation Context\n` +
      `> Continuing from **${sourceModelLabel}** to **${targetModelLabel}**.\n` +
      `> Source thread: "${thread.title}" (ID: \`${thread.id}\`)`,
  );

  const messages = (thread.messages ?? []).filter(
    (m) => m.text.trim().length > 0 || (m.attachments && m.attachments.length > 0),
  );
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  if (userMessages.length > 0) {
    const firstMsg = userMessages[0];
    const originalGoal = firstMsg?.text.trim();
    const attachmentNames = (firstMsg?.attachments ?? [])
      .map((a) => a.name || a.path)
      .filter((n): n is string => Boolean(n));

    let goalContent = originalGoal || "";
    if (attachmentNames.length > 0) {
      goalContent += `\n\nAttachments: ${attachmentNames.map((n) => `\`${n}\``).join(", ")}`;
    }

    if (goalContent.trim().length > 0) {
      sections.push(`## 🎯 Original Goal & Instructions\n${goalContent.trim()}`);
    }
  }

  if (assistantMessages.length > 0) {
    const decisions: string[] = [];
    for (const msg of assistantMessages) {
      const text = msg.text.trim();
      if (text.length > 0) {
        decisions.push(text);
      }
    }
    if (decisions.length > 0) {
      const decisionSummary = decisions
        .map((d, index) => {
          if (decisions.length === 1) return d;
          return `### Step ${index + 1} Summary\n${d}`;
        })
        .join("\n\n");
      sections.push(`## 📝 Work Completed & Key Decisions\n${decisionSummary}`);
    }
  }

  const modifiedFiles = new Set<string>();
  if (thread.checkpoints) {
    for (const checkpoint of thread.checkpoints) {
      for (const file of checkpoint.files) {
        if (file.path) {
          modifiedFiles.add(file.path);
        }
      }
    }
  }
  if (thread.activities) {
    for (const activity of thread.activities) {
      if (activity.payload && typeof activity.payload === "object") {
        const payload = activity.payload as Record<string, unknown>;
        if (typeof payload.filePath === "string") {
          modifiedFiles.add(payload.filePath);
        } else if (typeof payload.path === "string") {
          modifiedFiles.add(payload.path);
        } else if (Array.isArray(payload.files)) {
          for (const f of payload.files) {
            if (typeof f === "string") modifiedFiles.add(f);
            else if (
              f &&
              typeof f === "object" &&
              typeof (f as { path?: unknown }).path === "string"
            ) {
              modifiedFiles.add((f as { path: string }).path);
            }
          }
        }
      }
    }
  }

  if (modifiedFiles.size > 0) {
    const fileList = Array.from(modifiedFiles)
      .sort()
      .map((f) => `- \`${f}\``)
      .join("\n");
    sections.push(`## 📂 Modified & Relevant Files\n${fileList}`);
  }

  if (thread.activities && thread.activities.length > 0) {
    const relevantCommands: string[] = [];
    for (const act of thread.activities) {
      if (
        act.kind === "terminal" ||
        act.tone === "tool" ||
        act.summary.toLowerCase().includes("run") ||
        act.summary.toLowerCase().includes("test")
      ) {
        relevantCommands.push(`- ${act.summary}`);
      }
    }
    if (relevantCommands.length > 0) {
      const deduped = Array.from(new Set(relevantCommands)).slice(-10);
      sections.push(`## ⚙️ Key Actions & Commands Executed\n${deduped.join("\n")}`);
    }
  }

  if (thread.proposedPlans && thread.proposedPlans.length > 0) {
    const latestPlan = thread.proposedPlans[thread.proposedPlans.length - 1];
    if (latestPlan && latestPlan.planMarkdown.trim().length > 0) {
      sections.push(`## 📋 Execution Plan\n${latestPlan.planMarkdown.trim()}`);
    }
  }

  if (userMessages.length > 0) {
    const latestUserMsg = userMessages[userMessages.length - 1];
    const latestText = latestUserMsg?.text.trim();
    if (latestText && (userMessages.length > 1 || !sections.some((s) => s.includes(latestText)))) {
      sections.push(`## ⏭️ Latest Request / Next Immediate Step\n${latestText}`);
    }
  }

  return sections.join("\n\n");
}
