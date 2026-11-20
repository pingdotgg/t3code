// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ]),
);
/**
 * Reads the CLIProxyAPI provider from `$CODEX_HOME/config.toml` (default `~/.codex`): the
 * configured `model_provider` when it is a custom provider, otherwise `vibeproxy`.
 */
export const proxyConfig = () => {
  const config = decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          `
import json, os, pathlib, sys, tomllib
home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
def fail(message):
  print(json.dumps({'error': message + ' The GPT evals call models through a CLIProxyAPI server set up as a custom model provider in Codex: set model_provider = "<name>" and add [model_providers.<name>] with base_url and its key.'}))
  sys.exit()
path = home / 'config.toml'
if not path.is_file(): fail(f'No Codex config at {path}.')
config = tomllib.loads(path.read_text())
providers = config.get('model_providers', {})
name = config.get('model_provider') if config.get('model_provider') in providers else 'vibeproxy'
if name not in providers: fail(f'{path} has no custom model provider to use (model_provider is {config.get("model_provider", "unset")!r}).')
p = providers[name]
if not p.get('base_url'): fail(f'[model_providers.{name}] in {path} has no base_url.')
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ.get(p['env_key']) if p.get('env_key') else p.get('experimental_bearer_token')
if p.get('env_key') and not key: fail(f'[model_providers.{name}] in {path} reads its key from {p["env_key"]}, which is not set.')
if not key and p.get('requires_openai_auth') and (home / 'auth.json').is_file(): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
  if ("error" in config) throw new Error(config.error);
  return config;
};
