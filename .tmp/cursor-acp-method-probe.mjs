import { spawn } from 'node:child_process';
import readline from 'node:readline';

const REQUEST_TIMEOUT_MS = 15000;

function now() {
  return new Date().toISOString();
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

class Client {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];

    this.child = spawn('agent', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    this.stdout = readline.createInterface({ input: this.child.stdout });
    this.stderr = readline.createInterface({ input: this.child.stderr });

    this.stderr.on('line', (line) => {
      process.stderr.write(`[stderr] ${line}\n`);
    });

    this.stdout.on('line', (line) => {
      const msg = parseJson(line);
      if (!msg) {
        process.stdout.write(`[stdout non-json] ${line}\n`);
        return;
      }

      if (
        Object.prototype.hasOwnProperty.call(msg, 'id') &&
        !Object.prototype.hasOwnProperty.call(msg, 'method') &&
        (Object.prototype.hasOwnProperty.call(msg, 'result') ||
          Object.prototype.hasOwnProperty.call(msg, 'error'))
      ) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending(msg);
        return;
      }

      if (typeof msg.method === 'string') {
        this.notifications.push(msg);
        if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
          this.respondUnsupported(msg.id, msg.method);
        }
      }
    });
  }

  respondUnsupported(id, method) {
    const response = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Unhandled server request in probe: ${method}`,
      },
    };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  async send(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ timeout: true, id, method, params });
      }, timeoutMs);

      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve({ timeout: false, id, method, params, response });
      });
    });
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {}
    this.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    this.child.kill('SIGKILL');
  }
}

async function main() {
  const client = new Client();
  const results = [];

  const init = await client.send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: 't3-cursor-acp-method-probe',
      version: '0.1.0',
    },
  });
  results.push(init);

  const auth = await client.send('authenticate', { methodId: 'cursor_login' });
  results.push(auth);

  const sessionNew = await client.send('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
    model: 'gpt-5.3-codex',
  });
  results.push(sessionNew);

  const sessionId = sessionNew?.response?.result?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    const out = {
      ts: now(),
      sessionId: null,
      reason: 'Missing sessionId from session/new',
      results,
      notificationMethods: [...new Set(client.notifications.map((n) => n.method))].sort(),
      notificationSamples: client.notifications.slice(0, 8),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    await client.close();
    return;
  }

  const methodCandidates = [
    { method: 'session/set_model', params: { sessionId, model: 'composer-1.5' } },
    { method: 'session/setModel', params: { sessionId, model: 'composer-1.5' } },
    { method: 'session/model/set', params: { sessionId, model: 'composer-1.5' } },
    { method: 'session/update_model', params: { sessionId, model: 'composer-1.5' } },
    { method: 'session/configure', params: { sessionId, model: 'composer-1.5' } },
    { method: 'session/set_mode', params: { sessionId, modeId: 'ask' } },
    { method: 'session/setMode', params: { sessionId, modeId: 'ask' } },
    { method: 'session/mode/set', params: { sessionId, modeId: 'ask' } },
    { method: 'session/update_mode', params: { sessionId, modeId: 'ask' } },
    { method: 'session/change_mode', params: { sessionId, modeId: 'ask' } },
    { method: 'session/set', params: { sessionId, model: 'composer-1.5' } },
  ];

  for (const candidate of methodCandidates) {
    const result = await client.send(candidate.method, candidate.params);
    results.push(result);
  }

  // Sanity: session/prompt should still work after candidates.
  const prompt = await client.send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: ok' }],
  }, 30000);
  results.push(prompt);

  const out = {
    ts: now(),
    sessionId,
    results,
    notificationMethods: [...new Set(client.notifications.map((n) => n.method))].sort(),
    notificationSamples: client.notifications.slice(0, 8),
  };

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  await client.close();
}

main().catch(async (error) => {
  process.stderr.write(`Probe failed: ${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});
