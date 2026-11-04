// Approves exactly `git status`, denies `rm` commands, waits on "hold" until
// the server cancels the call, and abstains from everything else, including
// compound commands that start with `git status`.
export function activate(context) {
  context.proposed.handle("t3.approval.decide", (request, { signal }) => {
    const prompt = request.prompt ?? "";
    if (prompt === "hold")
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    if (prompt === "git status") return { decision: "approve", reason: "Read-only git command." };
    if (prompt.startsWith("rm ")) return { decision: "deny", reason: "Deletes files." };
    return { decision: "abstain" };
  });
}
