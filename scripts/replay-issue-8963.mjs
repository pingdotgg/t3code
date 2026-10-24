import fixture from "./fixtures/issue-8963.json" with { type: "json" };

// Supply T3 Browser-panel tools from the owning agent session. No separate browser
// driver or server is created, and all mutations go through the app UI.
// Begin on a fresh UI-created draft in Proof workspace with legacy Plan mode
// enabled in Settings. Narrow captures require a paired 1440px Stop client.
export async function replayR1(
  tools,
  { tabId, stopTabId = tabId, width, theme, expected, frozenTime },
) {
  const call = async (name, input) => {
    const result = await tools[`mcp__t3_code__${name}`](input);
    if (result.isError) throw new Error(JSON.stringify(result));
    return result.structuredContent;
  };
  const fresh = await call("preview_evaluate", {
    tabId,
    expression:
      "location.pathname.startsWith('/draft/') && !document.querySelector('[role=textbox][aria-label=Message]')?.textContent",
  });
  if (!fresh.value) throw new Error("Create a fresh empty thread through the UI first");
  await call("preview_resize", { tabId, mode: "freeform", width: 1440, height: 900 });
  await call("preview_set_appearance", { tabId, colorScheme: theme });
  const mode = await call("preview_evaluate", {
    tabId,
    expression: `Boolean(document.querySelector('button[aria-label="Default mode — click to enter plan mode"]'))`,
  });
  if (mode.value)
    await call("preview_click", {
      tabId,
      locator: 'role=button[name="Default mode — click to enter plan mode"]',
    });
  await call("preview_resize", { tabId, mode: "freeform", width, height: 900 });
  await call("preview_type", {
    tabId,
    locator: 'role=textbox[name="Message"]',
    text: fixture.r1.prompt,
    clear: true,
  });
  await call("preview_press", { tabId, key: "Enter" });
  await call("preview_wait_for", { tabId, selector: "[data-pending-user-input-toggle]" });
  await call("preview_click", { tabId, selector: "button:has(h2)" });
  await call("preview_click", { tabId, locator: 'role=button[name="Rename thread"]' });
  await call("preview_type", {
    tabId,
    locator: 'role=textbox[name="Thread title"]',
    text: "Proof A",
    clear: true,
  });
  await call("preview_press", { tabId, key: "Enter" });
  if (stopTabId !== tabId) {
    const route = await call("preview_evaluate", { tabId, expression: "location.href" });
    await call("preview_navigate", { tabId: stopTabId, url: route.value });
  }
  await call("preview_wait_for", {
    tabId: stopTabId,
    locator: 'role=button[name="Stop generation"]',
  });
  if (frozenTime !== undefined) {
    await call("preview_evaluate", {
      tabId,
      expression: `(() => { const OriginalDate = globalThis.Date; globalThis.__proofOriginalDate ??= OriginalDate; const NativeDate = globalThis.__proofOriginalDate; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${frozenTime}])); } static now() { return ${frozenTime}; } }; })()`,
    });
  }
  const settle = () =>
    call("preview_evaluate", {
      tabId,
      awaitPromise: true,
      expression: "new Promise(resolve => setTimeout(resolve, 2500))",
    });
  let recording;
  let recordingActive = false;
  let failed = false;
  let before;
  let after;
  let video;
  // A failed replay must not leave the tab recording or on the frozen clock, and
  // cleanup errors must not hide the failure that triggered them.
  try {
    recording = await call("preview_recording_start", { tabId });
    recordingActive = true;
    await call("preview_type", {
      tabId,
      locator: 'role=textbox[name="Message"]',
      text: fixture.r1.answer,
      clear: true,
    });
    await settle();
    before = await call("preview_snapshot", { tabId, save: true });
    await call("preview_click", {
      tabId: stopTabId,
      locator: 'role=button[name="Stop generation"]',
    });
    await call("preview_wait_for", {
      tabId,
      selector: 'body:not(:has(button[aria-label="Stop generation"]))',
    });
    await call("preview_wait_for", {
      tabId,
      selector: "body:not(:has([data-pending-user-input-toggle]))",
    });
    const result = await call("preview_evaluate", {
      tabId,
      expression: 'document.querySelector(\'[role="textbox"][aria-label="Message"]\')?.textContent',
    });
    if (result.value !== expected)
      throw new Error(`Composer contained ${JSON.stringify(result.value)}`);
    await settle();
    after = await call("preview_snapshot", { tabId, save: true });
    if (expected) {
      await call("preview_type", {
        tabId,
        locator: 'role=textbox[name="Message"]',
        text: fixture.r1.editedAnswer,
        clear: true,
      });
    }
    await settle();
    recordingActive = false;
    video = await call("preview_recording_stop", { tabId });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Only a failed replay can still be recording here.
    if (recordingActive) await call("preview_recording_stop", { tabId }).catch(() => {});
    if (frozenTime !== undefined)
      await call("preview_evaluate", {
        tabId,
        expression: "globalThis.Date = globalThis.__proofOriginalDate",
      }).catch((error) => {
        if (!failed) throw error;
      });
  }
  const environment = await call("preview_evaluate", {
    tabId,
    expression:
      "({threadId: location.pathname.split('/').pop(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent, font: getComputedStyle(document.body).fontFamily})",
  });
  return {
    recording,
    before,
    after,
    video,
    environment: environment.value,
    remoteStop: stopTabId !== tabId,
  };
}

export async function seedContextThread(tools, { tabId, letter }) {
  if (!["B", "C"].includes(letter)) throw new Error("Expected B or C");
  for (const [name, args] of [
    ["preview_click", { locator: 'role=button[name="New thread in Proof workspace"]' }],
    [
      "preview_type",
      {
        locator: 'role=textbox[name="Message"]',
        text: `Proof ${letter} fixture. Reply only: Synthetic context ${letter}. Do not inspect or edit files.`,
        clear: true,
      },
    ],
    ["preview_press", { key: "Enter" }],
  ]) {
    const result = await tools[`mcp__t3_code__${name}`]({ tabId, ...args });
    if (result.isError) throw new Error(JSON.stringify(result));
  }
  const wait = await tools.mcp__t3_code__preview_wait_for({
    tabId,
    selector: 'body:not(:has(button[aria-label="Stop generation"]))',
  });
  if (wait.isError) throw new Error(JSON.stringify(wait));
  for (const [name, args] of [
    ["preview_click", { selector: "button:has(h2)" }],
    ["preview_click", { locator: 'role=button[name="Rename thread"]' }],
    [
      "preview_type",
      { locator: 'role=textbox[name="Thread title"]', text: `Proof ${letter}`, clear: true },
    ],
    ["preview_press", { key: "Enter" }],
  ]) {
    const result = await tools[`mcp__t3_code__${name}`]({ tabId, ...args });
    if (result.isError) throw new Error(JSON.stringify(result));
  }
}
