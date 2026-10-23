async function runProject(variant, width, theme) {
  const tabId = load("tab"),
    url = load("projectUrl");
  const actions = [];
  const checkpoints = [];
  const call = async (name, fn) => {
    const at = new Date().toISOString();
    const r = await fn();
    actions.push({ name, at, completedAt: new Date().toISOString() });
    if (r?.isError) throw Error(JSON.stringify(r));
    return r;
  };
  const ev = async (expression) =>
    (await call("evaluate", () => tools.mcp__t3_code__preview_evaluate({ tabId, expression })))
      .structuredContent.value;
  const nav = async (target) => {
    await call("navigate " + target, () =>
      tools.mcp__t3_code__preview_navigate({ tabId, url: target }),
    );
    await call("loaded", () =>
      tools.mcp__t3_code__preview_wait_for({
        tabId,
        text: target.includes("/storage?") ? "Delete inactive worktrees" : "Applying settings for",
      }),
    );
    await ev(load("runtime"));
  };
  const click = async (locator) =>
    call("click " + locator, () => tools.mcp__t3_code__preview_click({ tabId, locator }));
  const snap = async (name) => {
    await call("neutral pointer", () =>
      tools.mcp__t3_code__preview_hover({
        tabId,
        locator: 'nav[aria-label="Settings breadcrumb"]',
      }),
    );
    await ev(
      `(async()=>{await document.fonts.ready;for(let i=0;i<4;i++){const a=document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime));if(!a.length)break;await Promise.all(a.map(a=>a.finished.catch(()=>{})))}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`,
    );
    const state = await ev(
      `({dark:document.documentElement.classList.contains('dark'),theme:localStorage.getItem('t3code:theme'),follow:localStorage.getItem('t3code:theme-follow-system'),appearance:localStorage.getItem('t3code:theme-appearance-mode'),checked:document.querySelector('[role=switch][aria-label="Delete inactive worktrees"]')?.getAttribute('aria-checked'),input:document.querySelector('input[aria-label="Delete inactive worktrees in days"]')?.value,focus:document.activeElement?.getAttribute('aria-label'),scroll:Array.from(document.querySelectorAll('*')).filter(e=>e.scrollTop).map(e=>({tag:e.tagName,className:e.className,top:e.scrollTop})),writes:proofWrites,acks:proofAcks,events:proofEvents,themeLog:proofThemeLog})`,
    );
    if (state.dark !== (theme === "dark")) throw Error("Theme mismatch " + name);
    const read = await ev(
      `proofRpc('server.getSettings').then(d=>({exit:d.exit._tag,storageCleanup:d.exit.value?.storageCleanup,overrides:d.exit.value?.projectSettingsOverrides}))`,
    );
    const shot = await call("checkpoint " + name, () =>
      tools.mcp__t3_code__preview_snapshot({ tabId, save: true }),
    );
    checkpoints.push({
      name,
      at: new Date().toISOString(),
      ...shot.structuredContent,
      state,
      read,
    });
  };
  await call("resize", () =>
    tools.mcp__t3_code__preview_resize({
      tabId,
      mode: "freeform",
      width,
      height: width === 1440 ? 1000 : 844,
    }),
  );
  await ev(
    `localStorage.setItem('t3code:theme',${JSON.stringify(theme)});localStorage.setItem('t3code:theme-follow-system','false');localStorage.setItem('t3code:theme-appearance-mode',${JSON.stringify(theme)});true`,
  );
  await nav(url);
  const reset = await ev(
    `proofRpc('server.updateSettings',{patch:{enableProviderUpdateChecks:false,projectSettingsOverrides:{'proof-project':{worktreeCleanup:{mode:'custom',rules:{worktreeAfterDays:null,worktreeSettledAfterDays:null,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:false,worktreeKeepWhen:'uncommitted-changes'}}}}}}).then(d=>d.exit._tag)`,
  );
  if (reset !== "Success") throw Error("seed failed");
  await nav(url);
  const start = await call("recording start", () =>
    tools.mcp__t3_code__preview_recording_start({ tabId }),
  );
  await snap("Off");
  await click('role=switch[name="Delete inactive worktrees"]');
  await snap("enable");
  await click('input[aria-label="Delete inactive worktrees in days"]');
  await call("select 8", () =>
    tools.mcp__t3_code__preview_press({ tabId, key: "a", modifiers: ["Control"] }),
  );
  await snap("enable-selected");
  await call("replace with 30", () =>
    tools.mcp__t3_code__preview_type({
      tabId,
      locator: 'input[aria-label="Delete inactive worktrees in days"]',
      text: "30",
      clear: true,
    }),
  );
  await call("commit Enter", () => tools.mcp__t3_code__preview_press({ tabId, key: "Enter" }));
  await click('role=heading[name="Worktrees"]');
  await ev("proofWait30()");
  await ev(
    `(async()=>{const r=await proofRpc('server.getSettings');if(r.exit.value.projectSettingsOverrides['proof-project'].worktreeCleanup.rules.worktreeAfterDays!==30)throw Error('Not committed30');return true})()`,
  );
  await snap("committed30");
  await nav(url);
  await snap("reload30");
  await click('role=switch[name="Delete inactive worktrees"]');
  await snap("Off-before-leave");
  await click('role=switch[name="Delete inactive worktrees"]');
  await snap("enable-before-leave");
  await nav(url.replace("/storage?", "/general?"));
  await snap("General");
  await nav(url);
  await snap("loaded-return");
  // Hold the loaded state across actual frames; animation frames preserve the raw transition recording.
  await ev(
    `new Promise(r=>{const end=performance.now()+1200;function tick(){if(performance.now()>=end)r(true);else requestAnimationFrame(tick)}tick()})`,
  );
  const stop = await call("recording stop", () =>
    tools.mcp__t3_code__preview_recording_stop({ tabId }),
  );
  const result = {
    variant,
    width,
    theme,
    startedAt: start.structuredContent.startedAt,
    video: stop.structuredContent,
    actions,
    checkpoints,
  };
  const results = load("results") || [];
  results.push(result);
  store("results", results);
  return { variant, width, theme, video: result.video.path, checkpoints: checkpoints.length };
}

// Evaluate this file in functions.exec, after loading project-runtime.js into
// store('runtime', source.trim()) and store('tab', the paired preview tabId).
// Register once per fresh home; reuse that same stopped-server snapshot for
// both commits. Copy these fixtures outside the checkout before baseline checkout.
async function registerProofProject(home) {
  if (!home.startsWith("/tmp/issue-14743-")) throw Error("Disposable home required");
  const tabId = load("tab");
  const evaluate = async (expression) => {
    const result = await tools.mcp__t3_code__preview_evaluate({ tabId, expression });
    if (result.isError) throw Error(JSON.stringify(result));
    return result.structuredContent.value;
  };
  await evaluate(load("runtime"));
  const payload = {
    type: "project.create",
    commandId: "proof-project-create",
    projectId: "proof-project",
    title: "Retention proof",
    workspaceRoot: home + "/project",
  };
  const result = await evaluate('proofRpc("projects.mutate",' + JSON.stringify(payload) + ")");
  if (result.exit?._tag !== "Success") throw Error(JSON.stringify(result));
  const descriptor = await evaluate('fetch("/.well-known/t3/environment").then(r=>r.json())');
  const origin = await evaluate("location.origin");
  store(
    "projectUrl",
    origin +
      "/settings/storage?project=" +
      encodeURIComponent(descriptor.environmentId + ":" + home + "/project"),
  );
}
