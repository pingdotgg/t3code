'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

// Prints "fg:<process name>" whenever the foreground app changes; exits when stdin closes.
const HELPER_SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class FocusWatcher {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  static void Main() {
    Thread stdin = new Thread(delegate () {
      try { while (Console.In.Read() >= 0) {} } catch {}
      Environment.Exit(0);
    });
    stdin.IsBackground = true;
    stdin.Start();
    uint lastPid = uint.MaxValue;
    string last = null;
    while (true) {
      uint pid;
      GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      if (pid != lastPid) {
        lastPid = pid;
        string name = "";
        try { using (Process p = Process.GetProcessById((int)pid)) name = p.ProcessName; } catch {}
        if (name != last) {
          last = name;
          Console.Out.WriteLine("fg:" + name);
          Console.Out.Flush();
        }
      }
      Thread.Sleep(1000);
    }
  }
}
`;

const POWERSHELL_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class T3Foreground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$lastPid = -1
$last = $null
while ($true) {
  $processId = 0
  [void][T3Foreground]::GetWindowThreadProcessId([T3Foreground]::GetForegroundWindow(), [ref]$processId)
  if ($processId -ne $lastPid) {
    $lastPid = $processId
    $name = ''
    try { $name = [Diagnostics.Process]::GetProcessById($processId).ProcessName } catch {}
    if ($name -ne $last) {
      [Console]::Out.WriteLine("fg:$name")
      [Console]::Out.Flush()
      $last = $name
    }
  }
  Start-Sleep -Milliseconds 1000
}
`;

function compilerPath() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  return ['Framework64', 'Framework']
    .map((dir) => path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
    .find((candidate) => fs.existsSync(candidate));
}

function buildHelper(dir, logger) {
  const hash = crypto.createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 10);
  const exe = path.join(dir, `focus-watcher-${hash}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  const csc = compilerPath();
  if (!csc) return Promise.resolve(null);
  const source = path.join(dir, `focus-watcher-${hash}.cs`);
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(source, HELPER_SOURCE);
    } catch (error) {
      logger.debug(`Could not write focus helper: ${error.message}`);
      resolve(null);
      return;
    }
    execFile(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, source], { windowsHide: true, timeout: 60_000 }, (error, stdout) => {
      fs.rm(source, { force: true }, () => {});
      if (error || !fs.existsSync(exe)) {
        logger.debug(`Could not build focus helper: ${String(stdout || error?.message).trim()}`);
        resolve(null);
      } else {
        resolve(exe);
      }
    });
  });
}

class FocusWatcher {
  constructor({ pattern, logger, onChange, helperDir }) {
    this.pattern = new RegExp(pattern, 'i');
    this.logger = logger;
    this.onChange = onChange;
    this.helperDir = helperDir;
    this.focused = undefined;
    this.proc = null;
    this.stopped = false;
    this.helper = undefined;
  }

  async start() {
    if (process.platform !== 'win32') {
      this.set(true);
      return;
    }
    if (this.helper === undefined) this.helper = this.helperDir ? await buildHelper(this.helperDir, this.logger) : null;
    if (this.stopped) return;
    const proc = this.helper
      ? spawn(this.helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    this.proc = proc;
    proc.stdin?.on('error', () => {});
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('fg:')) continue;
        const name = line.slice(3);
        this.logger.debug(`Foreground app: ${name || '(none)'}`);
        this.set(this.pattern.test(name));
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text && !text.startsWith('#< CLIXML') && !text.startsWith('<Objs')) this.logger.debug(`focus watcher: ${text}`);
    });
    const startedAt = Date.now();
    let ended = false;
    const retry = (reason) => {
      if (ended) return;
      ended = true;
      this.proc = null;
      if (this.stopped) return;
      if (this.helper && Date.now() - startedAt < 5000) this.helper = null;
      this.logger.warn(`Focus watcher ${reason}; treating T3 Code as focused and retrying in 10s`);
      this.set(true);
      setTimeout(() => !this.stopped && this.start().catch(() => {}), 10_000).unref();
    };
    proc.on('error', (error) => retry(`failed (${error.message})`));
    proc.on('exit', (code) => retry(`exited (${code})`));
  }

  set(focused) {
    if (focused === this.focused) return;
    this.focused = focused;
    this.onChange(focused);
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }
}

module.exports = { FocusWatcher };
