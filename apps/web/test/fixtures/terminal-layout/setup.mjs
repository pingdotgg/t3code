// Start an isolated dev server and pair its Browser panel before calling this.
// callPreview dispatches names to T3 preview_* tools; it must keep one owned tab.
export async function setup(driver, { width, theme, mode, shellPath, projectName = "server" }) {
  const { call, evaluate } = driver;
  await call("resize", { mode: "freeform", width, height: 900 });
  await call("set_appearance", { colorScheme: theme });
  await evaluate(`(async()=>{
    const capture=await import('/test/fixtures/terminal-layout/capture.mjs');
    capture.freezeClock();
    const settings=await import('/src/hooks/useSettings.ts');
    await settings.updateClientSettings({fontSizeTerminal:12});
    localStorage.setItem('t3code:theme',${JSON.stringify(theme)});
    window.dispatchEvent(new StorageEvent('storage',{key:'t3code:theme',newValue:${JSON.stringify(theme)}}));
  })()`);
  await call("click", {
    locator: `button[aria-label=${JSON.stringify(`New thread in ${projectName}`)}]`,
  });
  await call("wait_for", { locator: '[role="textbox"][contenteditable="true"]' });
  const context = await evaluate(`(()=>{
    const draftId=location.pathname.split('/').at(-1);
    const draft=JSON.parse(localStorage['t3code:composer-drafts:v1']).state.draftThreadsByThreadKey[draftId];
    if(!draft) throw Error('Expected a newly created draft');
    const threadRef={environmentId:draft.environmentId,threadId:draft.threadId};
    return {route:location.pathname,threadRef,threadKey:draft.environmentId+':'+draft.threadId};
  })()`);
  const sidebarOpen = await evaluate(
    `document.querySelector('button[aria-label="Toggle main sidebar"]')?.getAttribute('aria-pressed')==='true'`,
  );
  if (sidebarOpen) await call("click", { locator: 'button[aria-label="Toggle main sidebar"]' });
  if (mode === "RP") {
    await call("click", { locator: 'button[aria-label="Toggle right panel"]' });
    await call("click", { locator: 'role=button[name="Terminal T"]' });
  } else {
    await call("click", { locator: 'button[aria-label="Toggle terminal drawer"]' });
  }
  const surface = `[data-terminal-owner="${mode === "RP" ? "right-panel" : "drawer"}"]`;
  await call("wait_for", { locator: `${surface} canvas` });
  await call("click", { locator: `${surface} canvas` });
  await call("press", { key: "c", modifiers: ["Control"] });
  const quotedPath = `'${shellPath.replaceAll("'", "'\\''")}'`;
  await call("type", { locator: `${surface} textarea:focus`, text: `bash ${quotedPath} A` });
  await call("press", { key: "Enter" });
  await driver.ready("A");
  return context;
}

// This leaves real unexecuted shell input and its cursor on the first row.
export async function typeFirstLine(driver, { mode, columns }) {
  const surface = `[data-terminal-owner="${mode === "RP" ? "right-panel" : "drawer"}"]`;
  await driver.call("click", { locator: `${surface} canvas` });
  await driver.call("press", { key: "c", modifiers: ["Control"] });
  await driver.call("type", { locator: `${surface} textarea:focus`, text: "fixture_input" });
  await driver.call("press", { key: "Enter" });
  await driver.ready("input");
  const terminalColumns = columns ?? (await driver.columns());
  const prefix = "printf '%s\\n' '";
  const suffix = "RIGHT'";
  const text =
    prefix + "typed-".padEnd(terminalColumns - 2 - prefix.length - suffix.length, "x") + suffix;
  await driver.call("type", { locator: `${surface} textarea:focus`, text });
  return text;
}
