import { deviceToolMaintenanceScript } from "./deviceToolMaintenance.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

export const quoteRemoteArg = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Shells drop NUL, and Git for Windows sh drops CR, while reading script source.
const printfEscaped = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("\r", "\\0015").replaceAll("\0", "\\0000");

interface RemoteDeviceOptions {
  readonly nodeBootstrap?: boolean;
}

/** Send shell syntax over stdin so the SSH login shell never reinterprets it. */
export const remoteDeviceCommand = (
  script: string,
  stdin?: string,
  options?: RemoteDeviceOptions,
) => ({
  remoteCommandArgs: ["sh", "-s"],
  stdin:
    remoteDeviceEnvironment(options) +
    (stdin === undefined
      ? `${script} </dev/null\n`
      : `printf %b ${quoteRemoteArg(printfEscaped(stdin))} | { ${script}; }\n`),
});

export const remoteDeviceEnvironment = (
  options?: RemoteDeviceOptions,
) => `export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
${options?.nodeBootstrap ? `node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' 2>/dev/null || export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"` : ""}
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

/** Runs on the host and returns host-local paths. */
export const remoteDeviceScript = (
  owner: string,
  mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
) =>
  `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const hubVersion = ${JSON.stringify(DEVICE_HUB_VERSION)};
const agentVersion = ${JSON.stringify(AGENT_DEVICE_VERSION)};
` +
  deviceToolMaintenanceScript +
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.t3', 'device');
const state = path.join(root, 'hosts', owner);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
// Windows cannot spawn npm.cmd directly. Keep npm paired with a compatible Node,
// including lifecycle children, without putting paths or arguments in a shell.
const runNpm = (args, options) => {
  if (process.platform !== 'win32') return run('npm', args, options);
  const env = { ...process.env, ...options?.env };
  const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
  const inheritedPath = pathKeys.map(key => env[key]).filter(Boolean).join(path.delimiter);
  for (const key of pathKeys) delete env[key];
  const directories = [path.dirname(process.execPath), ...inheritedPath.split(path.delimiter)];
  const failures = [];
  for (const directory of [...new Set(directories.filter(Boolean).map(dir => dir.replace(/^"|"$/g, '')))]) {
    const npmRoot = path.join(directory, 'node_modules', 'npm');
    const entry = path.join(npmRoot, 'bin', 'npm-cli.js');
    if (!fs.existsSync(entry)) continue;
    let npm, semver;
    try {
      npm = JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
      if (typeof npm?.engines?.node !== 'string') throw Error('package.json has no engines.node');
      semver = require(path.join(npmRoot, 'node_modules', 'semver'));
    } catch (error) {
      failures.push('npm at ' + entry + ': ' + error.message);
      continue;
    }
    const sibling = path.join(directory, 'node.exe');
    const nodes = [...new Set([...(fs.existsSync(sibling) ? [sibling] : []), process.execPath])];
    for (const node of nodes) {
      const version = node === process.execPath ? null : run(node, ['-p', 'process.versions.node']);
      if (version && (version.error || version.status !== 0)) {
        failures.push('Node at ' + node + ': ' + commandFailure(version));
        continue;
      }
      const nodeVersion = version ? version.stdout.trim() : process.versions.node;
      if (!semver.satisfies(nodeVersion, '>=22') || !semver.satisfies(nodeVersion, npm.engines.node)) {
        failures.push('npm ' + npm.version + ' at ' + entry + ' requires Node ' + npm.engines.node + '; found ' + nodeVersion + ' at ' + node);
        continue;
      }
      return run(node, [entry, ...args], { ...options, env: { ...env, PATH: path.dirname(node) + path.delimiter + inheritedPath } });
    }
  }
  if (failures.length) throw Error('No compatible Node 22+ and npm pair: ' + failures.join('; '));
  throw Error('npm is missing: could not find node_modules/npm/bin/npm-cli.js beside Node or on the non-interactive SSH PATH.');
};
const commandFailure = result => [
  result.error?.message,
  result.signal ? 'signal ' + result.signal : result.status !== null ? 'exit code ' + result.status : null,
  (result.stderr?.trim() || result.stdout?.trim())?.slice(-2000),
].filter(Boolean).join(': ');
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
const toolVersions = (name, requiredVersion, entry, record) => {
  const directory = path.join(root, 'tools');
  const prefix = name + '@';
  let names = [];
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') return null; }
  let unreadable = false;
  const installedVersions = names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)).filter(version => {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return false;
    const dir = path.join(directory, prefix + version);
    try { return fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version && fs.existsSync(path.join(dir, 'node_modules', name, entry)); } catch (error) { if (error.code !== 'ENOENT') unreadable = true; return false; }
  }).sort();
  if (unreadable) return null;
  let runningVersion = null;
  if (record?.entryPath && record?.pid) {
    const command = run('ps', ['-p', String(record.pid), '-o', 'command=']).stdout || '';
    runningVersion = installedVersions.find(version => {
      const install = path.join(directory, prefix + version);
      return record.entryPath === path.join(install, 'node_modules', name, entry) && command.includes(install + path.sep);
    }) ?? null;
  }
  return { requiredVersion, installedVersions, runningVersion };
};
const versions = () => {
  const result = {
  hub: toolVersions('expo-device-hub', hubVersion, 'dist/server/cli.mjs', read(path.join(state, 'hub.json'))),
  agent: toolVersions('agent-device', agentVersion, 'bin/agent-device.mjs', { ...read(path.join(state, 'agent.json')), ...read(path.join(state, 'daemon.json')) }),
  };
  return result.hub && result.agent ? result : undefined;
};
const stopHub = hub => {
  if (!hub || hub.owner !== owner) return;
  const command = run('ps', ['-p', String(hub.pid), '-o', 'command=']).stdout || '';
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
  const android = run('adb', ['version']).status === 0;
  const platforms = [
    { platform: 'ios', available: ios, ...(!ios ? { reason: 'iOS needs macOS with Xcode and working xcrun simctl.' } : {}) },
    { platform: 'android', available: android, ...(!android ? { reason: 'Android SDK missing. Set ANDROID_HOME or put adb on the SSH PATH.' } : {}) },
  ];
  if (mode === 'probe') {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required on the device host. Found ' + process.versions.node + ' at ' + process.execPath + '.');
    const npm = runNpm(['--version']);
    if (npm.error || npm.status !== 0) throw Error(npm.error?.code === 'ENOENT' ? 'npm is missing from the non-interactive SSH PATH: ' + npm.error.message : 'npm probe failed: ' + commandFailure(npm));
    console.log(JSON.stringify({ nodePath: process.execPath, platforms, tools: versions() })); return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  // Serialize starts and stops for this environment/host owner, including agent startup.
  const hostLock = path.join(state, 'runtime.lock');
  const releaseHost = await acquireLock(hostLock);
  try {
  const hubFile = path.join(state, 'hub.json');
  const daemonFile = path.join(state, 'daemon.json');
  const agentFile = path.join(state, 'agent.json');
  const stopAgent = () => {
    const entry = read(agentFile)?.entryPath || path.join(root, 'tools', 'agent-device@' + agentVersion, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
    if (fs.existsSync(entry)) return run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]).status === 0;
    // A running daemon outlives its deleted CLI, so without one only a recorded pid that is gone counts as stopped.
    const pid = read(daemonFile)?.pid;
    return Number.isSafeInteger(pid) && pid > 0 && !maintenanceAlive(pid);
  };
  if (mode === 'stop' || mode === 'stop-agent') {
    const hub = read(hubFile);
    if (mode === 'stop' && hub && hub.owner === owner) {
      stopHub(hub);
      fs.rmSync(hubFile, { force: true });
    }
    stopAgent();
    return;
  }
  // A start without agent tools means the server holds no claims, so a daemon still here is
  // orphaned. Agent access was turned off while the tunnel was down, or a server crashed.
  // Close skips the release when start returns no endpoint, so the claims must end here.
  if (mode === 'start' && read(daemonFile)) {
    if (!stopAgent()) throw Error('Could not stop the agent-device daemon in ' + state);
    fs.rmSync(daemonFile, { force: true });
  }
  if (!ios && !android) throw Error(platforms.map(p => p.reason).join(' '));
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const hubEntry = await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
  // Only a Mac can list Apple simulators. Recording the filter replaces hubs started without it.
  const hubPlatform = process.platform === 'darwin' ? undefined : 'android';
  const cameraArgs = android ? ['front', 'back'].flatMap(facing => {
    const emulator = process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'emulator', 'emulator') : 'emulator';
    const help = run(emulator, ['-help-camera-' + facing], { timeout: 5000 });
    const text = (help.stdout || '') + '\n' + (help.stderr || '');
    // The hub's imagefile camera mode is not supported by every installed SDK emulator.
    return help.status === 0 && /\bemulated\b/.test(text) && !/\bimagefile\b/.test(text) ? ['-camera-' + facing, 'emulated'] : [];
  }) : [];
  const emulatorExtraArgs = [cameraArgs.join(' '), process.env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS].filter(Boolean).join(' ');
  let hub = read(hubFile);
  if (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || hub.platform !== hubPlatform || hub.emulatorExtraArgs !== emulatorExtraArgs || !await healthy(hub.port, '/readyz')) {
    stopHub(hub);
    for (let attempt = 0; attempt < 5; attempt++) {
      const hubPort = await port();
      const log = fs.openSync(path.join(state, 'hub.log'), 'a');
      const child = spawn(process.execPath, [hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device', ...(hubPlatform ? ['--platform', hubPlatform] : [])], {
        cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: emulatorExtraArgs, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
      finally { fs.closeSync(log); }
      child.unref();
      hub = { owner, pid: child.pid, port: hubPort, entryPath: hubEntry, platform: hubPlatform, emulatorExtraArgs };
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
  await pruneTools(path.join(root, 'tools'), [['expo-device-hub', hubVersion], ...(mode === 'agent-start' ? [['agent-device', agentVersion]] : [])], true).catch(() => {});
  console.log(JSON.stringify({ nodePath: process.execPath, platforms, tools: versions(), hubPort: hub.port, ...agentResult,
    helpers: { serveSimAxSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
  } finally { releaseHost(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
