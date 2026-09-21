import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import { deviceHubWindowsImport } from "./deviceHubWindows.ts";

export const quoteRemoteArg = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Send shell syntax over stdin so the SSH login shell never reinterprets it. */
export const remoteDeviceCommand = (script: string, stdin?: string, nodeBootstrap = false) => ({
  remoteCommandArgs: ["sh", "-s"],
  stdin:
    remoteDeviceEnvironment(nodeBootstrap) +
    (stdin === undefined
      ? `${script} </dev/null\n`
      : `printf %s ${quoteRemoteArg(stdin)} | { ${script}; }\n`),
});

/** Resolve common non-interactive SDK and Node locations without sourcing user shell scripts. */
export const remoteDeviceEnvironment = (
  nodeBootstrap = false,
) => `export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
${nodeBootstrap ? `node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' 2>/dev/null || export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"` : ""}
if [ -z "$ANDROID_HOME" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -n "$ANDROID_HOME" ]; then export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
  for device_java_home in "$HOME/.local/opt/android-studio/jbr" /opt/android-studio/jbr /Applications/Android\\ Studio.app/Contents/jbr "$HOME/Applications/Android Studio.app/Contents/jbr"; do
    if [ -x "$device_java_home/bin/java" ]; then export JAVA_HOME="$device_java_home"; break; fi
  done
fi
if [ -n "$JAVA_HOME" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
`;

/** Node runs this on the host. All paths it returns belong to that host. */
export const remoteDeviceScript = (
  owner: string,
  mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
) =>
  `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const hubVersion = ${JSON.stringify(DEVICE_HUB_VERSION)};
const agentVersion = ${JSON.stringify(AGENT_DEVICE_VERSION)};
const hubWindowsImport = ${JSON.stringify(deviceHubWindowsImport)};
` +
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.t3', 'device');
const state = path.join(root, 'hosts', owner);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
// Windows cannot spawn npm.cmd directly. Run its JS entry with the selected Node,
// keeping paths and arguments out of a command shell for both probe and install.
const runNpm = (args, options) => {
  if (process.platform !== 'win32') return run('npm', args, options);
  const directories = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
  const entry = directories.filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(file => fs.existsSync(file));
  if (!entry) throw Error('npm is missing: could not find node_modules/npm/bin/npm-cli.js beside Node or on the non-interactive SSH PATH.');
  return run(process.execPath, [entry, ...args], options);
};
const commandFailure = result => [
  result.error?.message,
  result.signal ? 'signal ' + result.signal : result.status !== null ? 'exit code ' + result.status : null,
  (result.stderr?.trim() || result.stdout?.trim())?.slice(-2000),
].filter(Boolean).join(': ');
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
const stopHub = hub => {
  if (!hub || hub.owner !== owner) return;
  const inspection = process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter "ProcessId = ' + Number(hub.pid) + '").CommandLine'])
    : run('ps', ['-p', String(hub.pid), '-o', 'command=']);
  const command = !inspection.error && inspection.status === 0 ? inspection.stdout || '' : '';
  if (command.includes(hub.entryPath) && command.includes(String(hub.port))) {
    try { process.kill(hub.pid, 'SIGTERM'); } catch {}
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const healthy = async (port, route) => { try { return (await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function acquireLock(lock, complete = () => false) {
  const deadline = Date.now() + 600000;
  const token = process.pid + ':' + require('node:crypto').randomUUID();
  const owner = () => { try { return fs.readlinkSync(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  while (true) {
    try {
      // Publishing the PID and token is atomic; suspension cannot leave an incomplete owner.
      fs.symlinkSync(token, lock);
      return () => { if (owner() === token) fs.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete()) return null;
      const previous = owner();
      if (previous === null) continue;
      const pid = Number(previous.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid device lock at ' + lock);
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH' && owner() === previous) {
          try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
      }
      if (Date.now() > deadline) throw Error('Device operation is locked at ' + lock + '. Check the other installer before removing the lock.');
      await sleep(500);
    }
  }
}
async function install(name, version, entry) {
  const dir = path.join(root, 'tools', name + '@' + version);
  const file = path.join(dir, 'node_modules', name, entry);
  const complete = () => fs.existsSync(file) && fs.existsSync(path.join(dir, '.install-complete')) && fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version;
  if (complete()) return file;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = dir + '.lock';
  const release = await acquireLock(lock, complete);
  if (!release) return file;
  let staging;
  try {
    if (complete()) return file;
    staging = fs.mkdtempSync(path.join(path.dirname(dir), '.install-'));
    const result = runNpm(['install', '--prefix', staging, '--no-fund', '--no-audit', name + '@' + version], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error('Installing ' + name + ': ' + commandFailure(result));
    if (!fs.existsSync(path.join(staging, 'node_modules', name, entry))) throw Error('Missing installed entry for ' + name);
    fs.writeFileSync(path.join(staging, '.install-complete'), version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return file;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}
(async () => {
  const ios = process.platform === 'darwin' && run('xcrun', ['simctl', 'help']).status === 0;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
    : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk'));
  const tool = (relative) => fs.existsSync(path.join(sdk, relative));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const androidReason = !tool('platform-tools/adb' + suffix) ? 'Android SDK Platform-Tools are missing. Install the Android SDK and set ANDROID_HOME.'
    : !tool('emulator/emulator' + suffix) ? 'Android Emulator is missing. Install it in Android Studio SDK Manager.'
    : !tool('cmdline-tools/latest/bin/avdmanager' + (process.platform === 'win32' ? '.bat' : '')) ? 'Android SDK Command-line Tools (latest) are missing. Install them in Android Studio SDK Manager.'
    : null;
  const android = androidReason === null;
  if (android) process.env.ANDROID_HOME = sdk;
  const platforms = [
    { platform: 'ios', available: ios, ...(!ios ? { reason: 'iOS needs macOS with Xcode and working xcrun simctl.' } : {}) },
    { platform: 'android', available: android, ...(!android ? { reason: androidReason } : {}) },
  ];
  if (mode === 'probe') {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required on the device host. Found ' + process.versions.node + ' at ' + process.execPath + '.');
    const npm = runNpm(['--version']);
    if (npm.error || npm.status !== 0) throw Error(npm.error?.code === 'ENOENT' ? 'npm is missing from the non-interactive SSH PATH: ' + npm.error.message : 'npm probe failed: ' + commandFailure(npm));
    console.log(JSON.stringify({ nodePath: process.execPath, platforms })); return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  // Serialize starts and stops for this environment/host owner, including agent startup.
  const hostLock = path.join(state, 'runtime.lock');
  const releaseHost = await acquireLock(hostLock);
  try {
  const hubFile = path.join(state, 'hub.json');
  const daemonFile = path.join(state, 'daemon.json');
  const agentFile = path.join(state, 'agent.json');
  if (mode === 'stop' || mode === 'stop-agent') {
    const hub = read(hubFile);
    if (mode === 'stop' && hub && hub.owner === owner) {
      stopHub(hub);
      fs.rmSync(hubFile, { force: true });
    }
    const entry = read(agentFile)?.entryPath || path.join(root, 'tools', 'agent-device@' + agentVersion, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
    if (fs.existsSync(entry)) run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]);
    return;
  }
  if (!ios && !android) throw Error(platforms.map(p => p.reason).join(' '));
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const hubEntry = await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
  let hub = read(hubFile);
  const windowsImport = process.platform === 'win32' ? hubWindowsImport : null;
  if (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || (windowsImport !== null && hub.windowsImport !== windowsImport) || !await healthy(hub.port, '/readyz')) {
    stopHub(hub);
    for (let attempt = 0; attempt < 5; attempt++) {
      const hubPort = await port();
      const log = fs.openSync(path.join(state, 'hub.log'), 'a');
      const child = spawn(process.execPath, [...(process.platform === 'win32' ? ['--import', hubWindowsImport] : []), hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'], {
        cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
      finally { fs.closeSync(log); }
      child.unref();
      hub = { owner, pid: child.pid, port: hubPort, entryPath: hubEntry, windowsImport };
      write(hubFile, hub);
      const deadline = Date.now() + 30000;
      let listening = false;
      while (child.exitCode === null && child.signalCode === null) {
        if (await healthy(hub.port, '/readyz')) { listening = true; break; }
        if (Date.now() > deadline) { stopHub(hub); throw Error('Device hub did not become ready. See ' + path.join(state, 'hub.log')); }
        await sleep(200);
      }
      if (listening) break;
      // Port reservation and binding happen in different processes. Retry an early exit with a fresh port.
      fs.rmSync(hubFile, { force: true });
      if (attempt === 4) throw Error('Device hub exited before becoming ready. See ' + path.join(state, 'hub.log'));
    }
  }
  let agentResult = {};
  if (mode === 'agent-start') {
  const agentEntry = await install('agent-device', agentVersion, 'bin/agent-device.mjs');
  const previousAgent = read(agentFile)?.entryPath;
  let daemon = read(daemonFile);
  if (daemon && (previousAgent !== agentEntry || !await healthy(daemon.httpPort, '/health'))) {
    const stopped = run(process.execPath, [previousAgent || agentEntry, 'daemon', 'stop', '--state-dir', state]);
    if (stopped.status !== 0) throw Error('Could not stop the previous agent-device version.');
    fs.rmSync(daemonFile, { force: true });
    daemon = null;
  }
  if (!daemon) {
    fs.rmSync(daemonFile, { force: true });
    const env = { ...process.env, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_DAEMON_SERVER_MODE: 'http', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
    delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG;
    run(process.execPath, [agentEntry, 'devices', '--json'], { env });
    daemon = read(daemonFile);
  }
  if (!daemon || !await healthy(daemon.httpPort, '/health')) throw Error('agent-device daemon did not become ready in ' + state);
  write(agentFile, { entryPath: agentEntry });
  agentResult = { daemonPort: daemon.httpPort, token: daemon.token, entryPath: agentEntry };
  }
  const vendor = path.resolve(path.dirname(hubEntry), '../../vendor/serve-sim/dist');
  const optional = file => fs.existsSync(file) ? file : null;
  console.log(JSON.stringify({ nodePath: process.execPath, platforms, hubPort: hub.port, ...agentResult,
    helpers: { serveSimAxSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
  } finally { releaseHost(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
