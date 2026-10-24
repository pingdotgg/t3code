#!/usr/bin/env node
// Run the emitted expression using T3 preview_evaluate in a privately paired tab.
// Stable command IDs make reseeding idempotent. No provider turn is requested.
// Reset each navigation segment with a full document navigation to root, wait
// for the app, then click A, B, Settings, Back/Escape, Back, Forward, Forward.
// Use identical actions on base/head; report divergences without changing them.
import * as NodeFS from "node:fs";
const fixture = JSON.parse(NodeFS.readFileSync(new URL("./issue-16542.json", import.meta.url)));
console.log(
  `(${async function seed(f) {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?orchestrationProtocol=2&clientSurface=web`,
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const rpc = (tag, payload) =>
      new Promise((resolve, reject) => {
        const requestId = String(++id);
        const listener = (event) => {
          const messages = JSON.parse(event.data);
          for (const message of Array.isArray(messages) ? messages : [messages]) {
            if (message._tag !== "Exit" || String(message.requestId) !== requestId) continue;
            socket.removeEventListener("message", listener);
            if (message.exit._tag === "Success") resolve(message.exit.value);
            else reject(new Error(JSON.stringify(message.exit)));
          }
        };
        socket.addEventListener("message", listener);
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: requestId,
            tag,
            payload,
            headers: [],
            traceId: "0".repeat(32),
            spanId: "0".repeat(16),
            sampled: false,
          }),
        );
      });
    try {
      await rpc("projects.mutate", {
        type: "project.create",
        commandId: "proof-16542-project-create",
        projectId: f.projectId,
        title: f.title,
        workspaceRoot: f.workspaceRoot,
        createWorkspaceRootIfMissing: true,
      });
      for (const thread of f.threads)
        await rpc("orchestration.dispatchCommand", {
          type: "thread.create",
          commandId: `proof-16542-create-${thread.id}`,
          threadId: thread.id,
          projectId: f.projectId,
          title: thread.title,
          modelSelection: f.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      return {
        seeded: f.threads.map((t) => t.id),
        clock: "server-assigned creation times; display clock must be controlled separately",
      };
    } finally {
      socket.close();
    }
  }})(${JSON.stringify(fixture)})`,
);
