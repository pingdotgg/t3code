export const selection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

export async function seedComposerOptionFallback(rpc, workspaceRoot) {
  const call = async (tag, payload) => {
    const exit = await rpc(tag, payload);
    if (exit._tag !== "Success") throw new Error(JSON.stringify(exit));
    return exit.value;
  };
  await call("server.updateSettings", {
    patch: { defaultModelSelection: { ...selection, options: [{ id: "effort", value: "high" }] } },
  });
  await call("projects.mutate", {
    type: "project.create",
    commandId: "proof-project-create",
    projectId: "proof-project",
    title: "Synthetic proof",
    workspaceRoot,
  });
  for (const row of ["V1", "V2", "V3", "V4", "A2", "B"]) {
    await call("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: `proof-create-${row}`,
      createdBy: "agent",
      creationSource: "mcp",
      threadId: `proof-${row}`,
      projectId: "proof-project",
      title: "Option fallback proof",
      modelSelection: {
        ...selection,
        ...(row === "A2"
          ? { options: [] }
          : row === "B"
            ? { options: [{ id: "effort", value: "low" }] }
            : {}),
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  }
}
