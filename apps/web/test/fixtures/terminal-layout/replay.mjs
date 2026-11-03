// The driver invokes only T3 preview tools. Each checkpoint saves the whole viewport.
export async function replay(driver, { mode, width, shellPath, threadRef, threadKey }) {
  const owner = mode === "RP" ? "right-panel" : "drawer";
  const surface = `[data-terminal-owner="${owner}"]`;
  const action = (name) => `${surface} button[aria-label^="${name}"]`;
  const call = driver.call;
  const read = driver.evaluate;
  const checkpoint = driver.checkpoint;
  await read(
    `globalThis.driverThreadRef = ${JSON.stringify(threadRef)}; globalThis.driverThreadKey = ${JSON.stringify(threadKey)}`,
  );
  const press = (key, modifiers) => call("press", { key, modifiers });
  const click = (locator) => call("click", { locator });
  const quotedShellPath = `'${shellPath.replaceAll("'", "'\\''")}'`;
  const command = async (text) => {
    await press("c", ["Control"]);
    await call("type", { locator: `${surface} textarea:focus`, text });
    await press("Enter");
  };
  const seed = async (pane, index) => {
    await click(`${surface} canvas >> nth=${index}`);
    await command(`bash ${quotedShellPath} ${pane}`);
    await driver.ready(pane);
  };
  const reset = async () => {
    const n = await read(`document.querySelectorAll('${surface} canvas').length`);
    for (let i = 0; i < n; i++) {
      await click(`${surface} canvas >> nth=${i}`);
      await command("fixture_reset");
      await driver.ready(String.fromCharCode(65 + i));
    }
  };
  const close = async () => {
    await click(action("Close Terminal ("));
    await call("wait_for", { locator: '[role="alertdialog"]' });
    await click('role=button[name="Confirm"]');
    await call("wait_for", { locator: `${surface} canvas` });
  };
  await reset();
  await checkpoint("single");
  for (const name of [
    "Split Terminal Horizontally",
    "Split Terminal Vertically",
    "New Terminal",
    "Close Terminal (",
  ]) {
    await call("hover", { locator: action(name) });
    await call("wait_for", { locator: '[role="dialog"]' });
  }
  await checkpoint("tooltip");
  const hit = await read(
    `(()=>{const b=document.querySelector('${action("Split Terminal Horizontally")}');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+2,label:b.getAttribute('aria-label'),hit:document.elementFromPoint(r.x+r.width/2,r.y+2)?.closest('button')?.getAttribute('aria-label')}})()`,
  );
  await driver.note("top2px horizontal split hit test", hit);
  await call("click", { x: hit.x, y: hit.y });
  await seed("B", 1);
  await reset();
  await checkpoint("S-H");
  for (const [pane, index] of [
    ["C", 2],
    ["D", 3],
  ]) {
    await click(action("Split Terminal Horizontally"));
    await seed(pane, index);
  }
  await reset();
  await call("hover", { locator: action("Split Terminal Horizontally") });
  await call("wait_for", { text: "max 4 per group" });
  try {
    await click(action("Split Terminal Horizontally"));
  } catch (error) {
    await driver.note("Limit control rejected the pointer attempt", { error: String(error) });
  }
  const count = await read(`document.querySelectorAll('${surface} canvas').length`);
  if (count !== 4) throw Error(`Expected four panes, received ${count}`);
  await checkpoint("L");
  for (let i = 0; i < 3; i++) await close();
  await reset();
  await checkpoint("single-after-horizontal");
  await click(action("Split Terminal Vertically"));
  await seed("B", 1);
  await reset();
  await checkpoint("S-V");
  await close();
  await reset();
  await click(action("New Terminal"));
  await seed("B", 0);
  await checkpoint(mode === "RP" ? "new-tab" : "G");
  if (mode === "RP") {
    const tab = (index) =>
      `[data-right-panel-tab-list] [data-active-tab] button:not([aria-label]):visible >> nth=${index}`;
    await click(tab(0));
    await reset();
    await click(tab(1));
    await close();
    if (width > 980) {
      await call("drag", {
        source: '[role="separator"].cursor-col-resize:visible',
        target: '[role="textbox"][contenteditable="true"]',
      });
      await checkpoint("width-drag");
      await click('button[aria-label="Maximize panel"]:visible');
      await checkpoint("maximized");
      await click('button[aria-label="Restore panel size"]:visible');
      await call("drag", {
        source: '[role="separator"].cursor-col-resize:visible',
        target: 'button[aria-label="Toggle right panel"]:visible',
      });
    }
    await click('button[aria-label="Toggle right panel"]:visible');
    await checkpoint("hidden");
    await click('button[aria-label="Toggle right panel"]:visible');
  } else {
    const session = (index) =>
      `${surface} [class~="group/tab"] > button:not([aria-label]) >> nth=${index}`;
    await click(session(0));
    await reset();
    await click(session(1));
    await close();
    await click('button[aria-label="Toggle thread details panel"]:visible');
    await driver.arm();
    await click(
      'button[aria-label="Run Evidence deterministic terminal with deliberately long label"]',
    );
    await call("wait_for", { locator: `${surface} canvas` });
    await click('button[aria-label="Toggle thread details panel"]:visible');
    await driver.ready("G");
    await checkpoint("G-long-label");
    await close();
    await click(`${surface} canvas`);
    await press("d", ["Control"]);
    await seed("B", 1);
    await checkpoint("shortcut-split");
    await close();
    await call("drag", { source: `${surface} > .cursor-row-resize`, target: `${surface} canvas` });
    await reset();
    await checkpoint("minimum-height");
    await read(
      `(async()=>{const m=await import('/src/terminalUiStateStore.ts');m.useTerminalUiStateStore.getState().setTerminalHeight(driverThreadRef,280)})()`,
    );
    await click('button[aria-label="Toggle terminal drawer"]:visible');
    await click('button[aria-label="Toggle terminal drawer"]:visible');
    await call("wait_for", { locator: `${surface} canvas` });
    await driver.note("restore preferred height through existing store action", { height: 280 });
    await call("type", {
      locator: '[role="textbox"][contenteditable="true"]',
      text: Array.from({ length: 12 }, (_, i) => "Composer fixture line " + (i + 1)).join("\n"),
    });
    await read(
      `(async()=>{const m=await import('/src/hooks/useSettings.ts');await m.updateClientSettings({fontSizeTerminal:18})})()`,
    );
    await reset();
    await checkpoint("constrained-font18");
    await call("type", {
      locator: '[role="textbox"][contenteditable="true"]',
      text: "",
      clear: true,
    });
    await read(
      `(async()=>{const m=await import('/src/hooks/useSettings.ts');await m.updateClientSettings({fontSizeTerminal:12})})()`,
    );
    await click(`${surface} canvas`);
    await command("fixture_scrollback");
    await driver.ready("A");
    await read(
      `document.querySelector('${surface} canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:-1000,bubbles:true,cancelable:true}))`,
    );
    await checkpoint("scroll-up");
    await read(
      `document.querySelector('${surface} canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:1000,bubbles:true,cancelable:true}))`,
    );
    await checkpoint("scroll-down");
    await click('button[aria-label="Toggle terminal drawer"]:visible');
    await checkpoint("hidden");
    await click('button[aria-label="Toggle terminal drawer"]:visible');
  }
  await reset();
  await checkpoint("reopened");
  await click(action("Close Terminal ("));
  await click('role=button[name="Cancel"]');
  await checkpoint("close-cancel");
  await click(action("Close Terminal ("));
  await click('role=button[name="Confirm"]');
  await checkpoint("E-last-close");
  if (mode === "RP") {
    const open = await read(
      `JSON.parse(localStorage.getItem('t3code:right-panel-state:v2')).state.byThreadKey[driverThreadKey]?.isOpen === true`,
    );
    if (!open) await click('button[aria-label="Toggle right panel"]:visible');
    await click('role=button[name="Terminal T"]');
  } else {
    await click('button[aria-label="Toggle terminal drawer"]:visible');
  }
  await seed("A", 0);
  await checkpoint("new-usable-single");
}
