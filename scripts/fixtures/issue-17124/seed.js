// Run in the isolated dev app's preview_evaluate context. Never sends a turn.
export const fixtures = {
  A: ["1. parent\n2. ch|ild", "10. parent\n11. ch|ild"],
  B: ["2. parent\n   1. sibling\n      1. grandchild\n3. ch|ild"],
  C: ["1. parent\n   1. child\n      1. |"],
  D: ["7. solo|", "1. parent\n\n2. ch|ild", "10. parent\n|11. child"],
  E: [
    "- parent\n- ch|ild",
    "- [x] parent\n- [ ] ch|ild",
    "1. parent\n   09) sibling\n2) ch|ild",
    "1. parent\n   09) sibling\n2. ch|ild",
  ],
};

export async function seed(marked) {
  const { buildDocJson, serializeEditorDoc } = await import("/src/composer-rich-text-doc.ts");
  const element = document.querySelector('[data-testid="composer-editor"]');
  if (!element?.editor) throw new Error("Open an empty synthetic ChatComposer first");
  const editor = element.editor;
  const rich = element.dataset.composerRichText === "true";
  const offset = marked.indexOf("|");
  const text = marked.replace("|", "");
  const doc = editor.schema.nodeFromJSON(buildDocJson(text, () => null, { styling: rich }));
  editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content));
  const map = serializeEditorDoc(editor.state.doc);
  // Structural rich markers have no editable prefix position. Use content start.
  const run =
    map.runs.find(
      (r) => r.kind === "text" && offset >= r.mdStart && offset <= r.mdStart + r.mdLen,
    ) ??
    map.runs.find((r) => r.mdStart >= offset && r.kind !== "prefix") ??
    map.runs.at(-1);
  const pos = Math.min(
    editor.state.doc.content.size - 1,
    run ? run.pmPos + Math.max(0, Math.min(run.docLen, offset - run.mdStart)) : 1,
  );
  editor.view.dispatch(
    editor.state.tr.setSelection(editor.state.selection.constructor.create(editor.state.doc, pos)),
  );
  editor.view.focus();
  return { requested: text, canonical: map.value, requestedOffset: offset, pmPos: pos, rich };
}

export async function observe() {
  const { serializeEditorDoc } = await import("/src/composer-rich-text-doc.ts");
  const editor = document.querySelector('[data-testid="composer-editor"]').editor;
  return {
    text: serializeEditorDoc(editor.state.doc).value,
    selection: editor.state.selection.toJSON(),
  };
}

export async function installRpc(environmentId) {
  const { createEnvironmentRpcCommand } =
    await import("../../../packages/client-runtime/src/state/runtime.ts");
  const { connectionAtomRuntime } = await import("/src/connection/runtime.ts");
  const { appAtomRegistry } = await import("/src/rpc/atomRegistry.ts");
  return (input) =>
    createEnvironmentRpcCommand(connectionAtomRuntime, {
      label: "Isolated composer list evidence",
      tag: "orchestration.dispatchCommand",
    }).run(appAtomRegistry, { environmentId, input: { commandId: crypto.randomUUID(), ...input } });
}

export async function createFixtureThread(rpc, projectId, worktreePath) {
  const threadId = `list-evidence-${crypto.randomUUID()}`;
  const result = await rpc({
    type: "thread.create",
    threadId,
    projectId,
    title: "Composer list evidence",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix/issue-17124",
    worktreePath,
    createdBy: "user",
    creationSource: "web",
  });
  if (result._tag !== "Success") throw new Error(JSON.stringify(result));
  return threadId;
}

export async function stageRenderedFixture(rpc, threadId) {
  const { text } = await observe();
  const dispatched = await rpc({
    type: "message.dispatch",
    threadId,
    messageId: crypto.randomUUID(),
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "defer_start" },
  });
  if (dispatched._tag !== "Success") throw new Error(JSON.stringify(dispatched));
  // defer_start emits no provider-turn.start effect. Never release this run.
  const interrupted = await rpc({
    type: "run.interrupt",
    threadId,
    runId: `run:thread:${threadId}:ordinal:1`,
    holdQueue: true,
    reason: "Fixture only: never release provider start",
  });
  if (interrupted._tag !== "Success") throw new Error(JSON.stringify(interrupted));
  return { text, dispatched: dispatched.value, interrupted: interrupted.value };
}
