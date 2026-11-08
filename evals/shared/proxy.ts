// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);
/**
 * Reads a CLIProxyAPI server: `vibeproxy` from `~/.codex/config.toml`, or `pool`, the provider-pool
 * client T3's `claude-public-pool` and `codex-public-pool` instances use.
 */
export const proxyConfig = (source: "vibeproxy" | "pool" = "vibeproxy") =>
  decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          `
import json, os, pathlib, sys, tomllib
if sys.argv[1] == 'pool':
  d = pathlib.Path.home() / '.config/cliproxy-public-client'
  print(json.dumps({'url': (d / 'endpoint').read_text().strip().rstrip('/') + '/v1', 'headers': {'Authorization': 'Bearer ' + (d / 'client-key').read_text().strip()}}))
  sys.exit()
home = pathlib.Path.home() / '.codex'
p = tomllib.loads((home / 'config.toml').read_text())['model_providers']['vibeproxy']
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
          source,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
