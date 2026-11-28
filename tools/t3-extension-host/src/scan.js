'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, fork } = require('node:child_process');
const { loadConfig } = require('./config');
const { activationEvents, describeActivation, discoverAll, readDisabled, resolveMain, selectExtensions } = require('./host/extensions');

const CONCURRENCY = 3;
const EDITOR_ONLY = ['themes', 'iconThemes', 'productIconThemes', 'snippets', 'grammars', 'keybindings', 'localizations'];

const config = loadConfig();
const args = process.argv.slice(2);
const includeExcluded = args.includes('--all');
const only = new Set(args.filter((arg) => !arg.startsWith('--')).map((arg) => arg.toLowerCase()));
const sandbox = path.join(config.dataDir, 'scan-sandbox');

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    resolve();
  });
}

function removeSandbox() {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.warn(`Could not fully remove ${sandbox}: ${error.message}`);
  }
}

function runIsolated(found) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'host', 'index.js'), [], {
      env: { ...process.env, T3_EXTENSION_HOST_SCAN: found.id, T3_EXTENSION_HOST_SANDBOX: sandbox },
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child.pid).then(() => resolve(result));
    };
    const timer = setTimeout(() => finish({ status: 'timed out' }), (config.activationTimeoutSeconds + 15) * 1000);
    child.on('message', (message) => message?.type === 'scan-result' && finish(message));
    child.on('exit', (code) => finish({ status: `crashed the host (exit ${code})` }));
  });
}

function classify(found, { disabled, enabled }) {
  const key = found.id.toLowerCase();
  const events = activationEvents(found.pkg);
  const base = { id: found.id, version: found.version, starts: describeActivation(events) };
  if (disabled.has(key)) return { ...base, status: 'disabled in VS Code' };
  if (!resolveMain(found.dir, found.pkg.main)) {
    const kinds = Object.keys(found.pkg.contributes ?? {}).filter((kind) => EDITOR_ONLY.includes(kind));
    return { ...base, starts: '-', status: 'no code', notes: kinds.length ? `only ${kinds.join(', ')}, which need an editor` : 'declarative only' };
  }
  if (!enabled.has(key) && !includeExcluded) return { ...base, status: 'excluded', notes: 'see "exclude" in config.json' };
  return { ...base, status: 'run' };
}

function notes(result) {
  if (result.error) return result.error;
  const parts = [];
  if (result.runtimeErrors?.length) parts.push(`${result.runtimeErrors.length} runtime error(s): ${result.runtimeErrors[0]}`);
  if (result.missing?.length) parts.push(`ignored ${result.missing.length} unavailable API(s): ${result.missing.slice(0, 4).join(', ')}${result.missing.length > 4 ? ', …' : ''}`);
  return parts.join('; ');
}

function printTable(rows) {
  const columns = [
    ['Extension', (r) => `${r.id} ${r.version}`],
    ['Result', (r) => r.status],
    ['Starts', (r) => r.starts],
    ['Notes', (r) => r.notes ?? ''],
  ];
  const widths = columns.slice(0, -1).map(([title, get]) => Math.max(title.length, ...rows.map((r) => get(r).length)));
  const line = (cells) => cells.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]) : cell)).join('  ');
  console.log(line(columns.map(([title]) => title)));
  for (const row of rows) console.log(line(columns.map(([, get]) => get(row))));
}

async function main() {
  const { registry } = discoverAll(config);
  const disabled = config.respectVSCodeDisabled ? readDisabled(config.vscodeStateDb) : new Set();
  const enabled = selectExtensions(config, registry, disabled);
  const targets = [...registry.values()].filter((found) => (only.size ? only.has(found.id.toLowerCase()) : !found.builtin));
  if (!targets.length) {
    console.log(`No matching extensions in ${config.extensionsDir}`);
    return;
  }

  removeSandbox();
  const rows = targets.map((found) => classify(found, { disabled, enabled }));
  const queue = rows.filter((row) => row.status === 'run');
  console.log(`Test-activating ${queue.length} extension(s) one at a time in isolated processes...`);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const result = await runIsolated(registry.get(row.id.toLowerCase()));
        Object.assign(row, result, { notes: notes(result), tested: true });
        process.stdout.write('.');
      }
    }),
  );
  process.stdout.write('\n\n');
  removeSandbox();

  rows.sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id));
  printTable(rows);
  const tested = rows.filter((row) => row.tested);
  const ok = tested.filter((row) => row.status === 'activated');
  console.log(`\n${ok.length} of ${tested.length} tested extension(s) activated under T3 Code.`);
  const report = path.join(config.dataDir, 'scan.json');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(report, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`Full report: ${report}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
