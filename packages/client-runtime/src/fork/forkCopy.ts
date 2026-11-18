// The fork does not translate: upstream files take the fork's English text from here.

export const WHILE_IDLE_COMPACTING_LABEL = "Compacting while idle…";
export const WHILE_IDLE_COMPACTION_TITLE = "Context automatically compacted while idle";

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function forkToolSummaryLabel(
  action: "rewrite-to-user" | "dashboard",
  count: number,
  done: boolean,
): string {
  const [did, tried, object] =
    action === "rewrite-to-user"
      ? ["Rewrote", "Tried to rewrite", `${counted(count, "message")} to the user`]
      : ["Used", "Tried to use", `the Dashboard ${counted(count, "time")}`];
  return `${done ? did : tried} ${object}`;
}
