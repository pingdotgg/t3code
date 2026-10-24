export const runNavigationProof = async function (
  tools,
  tab,
  rev,
  profile,
  row = "01",
  exit = "back",
  utility = "Settings",
) {
  const out = "/tmp/issue-16542-evidence";
  const prefix = `${rev}-${profile.id}-row${row}-${exit}`;
  const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const get = (r) => {
    if (r.isError) throw Error(JSON.stringify(r));
    if (r.structuredContent) return r.structuredContent;
    for (const c of r.content ?? [])
      if (c.type === "text") {
        try {
          return JSON.parse(c.text);
        } catch {}
      }
    return r;
  };
  const call = async (name, args) => get(await tools[name]({ tabId: tab, ...args }));
  const log = { rev, profile, row, exit, utility, startedAt: new Date().toISOString(), steps: [] };
  const write = async () =>
    await tools.exec_command({
      cmd: `printf %s ${q(JSON.stringify(log, null, 2))} > ${out}/${prefix}.json`,
      max_output_tokens: 100,
    });
  const diagnostic = async (label) => {
    await call("mcp__t3_code__preview_evaluate", {
      expression:
        "(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()",
    });
    const d = await call("mcp__t3_code__preview_evaluate", {
      expression: `({href:location.href,index:history.state?.__TSR_index,heading:document.querySelector('main h2')?.textContent,utc:new Date().toISOString(),monotonic:performance.now(),dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],theme:document.documentElement.className,text:document.body.innerText,fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),ua:navigator.userAgent})`,
    });
    const snap = await call("mcp__t3_code__preview_snapshot", { save: true });
    const file = `${prefix}-${label}.png`;
    await tools.exec_command({
      cmd: `cp ${q(snap.screenshotPath)} ${out}/${file}`,
      max_output_tokens: 100,
    });
    log.steps.push({ label, ...d.value, file, wallUtc: new Date().toISOString() });
    await write();
  };
  const click = async (locator) => {
    if (locator === 'button[aria-label="Toggle main sidebar"]') {
      await call("mcp__t3_code__preview_evaluate", {
        expression: `new Promise((resolve,reject)=>{const start=performance.now();const tick=()=>{const e=document.querySelector('button[aria-label="Toggle main sidebar"]');const b=e?.getBoundingClientRect();const hit=b&&document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);if(e&&hit&&e.contains(hit))resolve(true);else if(performance.now()-start>5000)reject(Error('Sidebar toggle obscured'));else requestAnimationFrame(tick)};tick()})`,
      });
    }
    return call("mcp__t3_code__preview_click", { locator, timeoutMs: 5000 });
  };
  const wait = async (args) =>
    call("mcp__t3_code__preview_wait_for", { timeoutMs: 10000, ...args });
  const drawer = async () => {
    if (profile.width < 600) {
      // Only open when the sidebar target is not visible.
      const visible = await call("mcp__t3_code__preview_evaluate", {
        expression: `[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Settings' && e.getBoundingClientRect().width>0)`,
      });
      if (!visible.value) await click('button[aria-label="Toggle main sidebar"]');
    }
  };
  try {
    await call("mcp__t3_code__preview_resize", {
      mode: "freeform",
      width: profile.width,
      height: profile.height,
    });
    await call("mcp__t3_code__preview_set_appearance", { colorScheme: profile.theme });
    await call("mcp__t3_code__preview_navigate", { url: "http://localhost:8458/?evidence=16542" });
    await wait({ locator: 'button[aria-label="Toggle main sidebar"]' });
    await drawer();
    await wait({ locator: '[aria-label="Proof A — Alpha, Public navigation proof"]' });
    await call("mcp__t3_code__preview_evaluate", {
      expression: `(()=>{const NativeDate=Date;class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:['2026-10-22T00:00:00.000Z']))}static now(){return 1792627200000}}window.Date=FixedDate;return {index:history.state?.__TSR_index}})()`,
    });
    const dismiss = await call("mcp__t3_code__preview_evaluate", {
      expression: `!!document.querySelector('button[aria-label="Dismiss notification"]')`,
    });
    if (dismiss.value) await click('button[aria-label="Dismiss notification"]');
    await call("mcp__t3_code__preview_recording_start", {});
    log.recordingStartedAt = new Date().toISOString();
    await click('[role="button"][aria-label="Proof A — Alpha, Public navigation proof"]');
    await wait({ urlIncludes: "proof-16542-a" });
    if (profile.width < 600) await click('button[aria-label="Toggle main sidebar"]');
    await click('[role="button"][aria-label="Proof B — Beta, Public navigation proof"]');
    await wait({ urlIncludes: "proof-16542-b" });
    await wait({ locator: 'h2:has-text("Proof B")' });
    await diagnostic("initial-b");
    if (profile.width < 600) await click('button[aria-label="Toggle main sidebar"]');
    await click(`button[aria-label="${utility}"]`);
    await wait({
      urlIncludes:
        utility === "Settings" ? "/settings/" : utility === "Usage" ? "/usage" : "/pull-requests",
    });
    await wait({
      locator: utility === "Settings" ? 'button[aria-label="Project scope: All projects"]' : "main",
    });
    if (row === "03") {
      if (profile.width < 600) await click('button[aria-label="Toggle main sidebar"]');
      await click('button:has-text("Appearance")');
      await wait({ urlIncludes: "/settings/appearance" });
      await diagnostic("appearance");
      if (profile.width < 600) await click('button[aria-label="Toggle main sidebar"]');
      await call("mcp__t3_code__preview_type", {
        locator: 'input[placeholder*="Search"]',
        text: "Time format",
        clear: true,
      });
      await wait({ locator: '[role="option"]:has-text("Time format")' });
      await click('[role="option"]:has-text("Time format")');
      await wait({ urlIncludes: "/settings/general" });
      await diagnostic("search-result");
      await click('a[href="/settings/open-source-licenses"]');
      await wait({ urlIncludes: "/settings/open-source-licenses" });
      await diagnostic("licenses");
    }
    if (row === "02" || row === "04") {
      await click('button[aria-label="Project scope: All projects"]');
      await click('[role="menuitemradio"]:has-text("Public navigation proof")');
      await wait({ locator: 'button[aria-label="Project scope: Public navigation proof"]' });
      await diagnostic("project-scope");
      if (row === "04") {
        await click('button[aria-label="Project scope: Public navigation proof"]');
        await click('[role="menuitemradio"]:has-text("All projects")');
        await wait({ locator: 'button[aria-label="Project scope: All projects"]' });
        await diagnostic("all-projects-scope");
      }
    }
    if (profile.width < 600 && exit === "back")
      await click('button[aria-label="Toggle main sidebar"]');
    await diagnostic("utility");
    if (exit === "escape") await call("mcp__t3_code__preview_press", { key: "Escape" });
    else await click('button:has-text("Back")');
    await wait({ urlIncludes: "proof-16542-b" });
    await wait({ locator: 'h2:has-text("Proof B")' });
    await diagnostic("closed");
    await call("mcp__t3_code__preview_press", { key: "[", modifiers: ["Control"] });
    await wait({
      urlIncludes:
        rev === "before"
          ? utility === "Settings"
            ? "/settings/"
            : utility === "Usage"
              ? "/usage"
              : "/pull-requests"
          : "proof-16542-a",
    });
    await diagnostic("history-back");
    await call("mcp__t3_code__preview_press", { key: "]", modifiers: ["Control"] });
    await wait({ urlIncludes: "proof-16542-b" });
    await diagnostic("history-forward");
    await call("mcp__t3_code__preview_press", { key: "]", modifiers: ["Control"] });
    // Forward at the end of the baseline stack is intentionally a no-op.
    if (rev !== "before")
      await wait({
        urlIncludes:
          utility === "Settings" ? "/settings/" : utility === "Usage" ? "/usage" : "/pull-requests",
      });
    await diagnostic("further-forward");
    log.complete = true;
  } catch (e) {
    log.error = String(e);
  }
  const recording = await tools.mcp__t3_code__preview_recording_stop({ tabId: tab });
  try {
    const r = get(recording);
    if (r.path) {
      await tools.exec_command({
        cmd: `cp ${q(r.path)} ${out}/${prefix}.webm`,
        max_output_tokens: 100,
      });
      log.recording = { ...r, path: `${prefix}.webm` };
    }
  } catch (e) {
    log.recordingError = String(e);
  }
  await write();
  return {
    prefix,
    complete: log.complete,
    error: log.error,
    steps: log.steps.map((s) => ({ label: s.label, index: s.index, href: s.href })),
    recording: log.recording,
  };
};
