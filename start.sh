#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_dist="$repo_root/apps/server/dist"
port="${PORT:-3773}"
host="${HOST:-0.0.0.0}"
base_dir="${T3CODE_HOME:-${HOME}/.t3}"
rebuild=false
server_args=()

usage() {
  cat <<'EOF'
Usage: ./start.sh [options] [T3 server options]

Build and run the repository's production web/server bundle. The build runs
inside Docker; the resulting JavaScript runs natively using the macOS modules
installed by t3@latest.

Options:
  --port PORT       Server port (default: $PORT or 3773)
  --host HOST       Bind address (default: $HOST or 0.0.0.0)
  --base-dir PATH   T3 home (default: $T3CODE_HOME or ~/.t3)
  --rebuild         Rebuild the production bundle inside Docker
  -h, --help        Show this help

Other options are forwarded to the T3 server. For example, --no-browser keeps
the server from opening a browser. The default base directory shares projects,
pairings, settings, and other data with the normal production distribution.
EOF
}

die() {
  printf 'start.sh: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$option requires a value"
}

while (($# > 0)); do
  case "$1" in
    --port)
      require_value "$1" "${2:-}"
      port="$2"
      shift 2
      ;;
    --port=*)
      port="${1#*=}"
      require_value "--port" "$port"
      shift
      ;;
    --host)
      require_value "$1" "${2:-}"
      host="$2"
      shift 2
      ;;
    --host=*)
      host="${1#*=}"
      require_value "--host" "$host"
      shift
      ;;
    --base-dir)
      require_value "$1" "${2:-}"
      base_dir="$2"
      shift 2
      ;;
    --base-dir=*)
      base_dir="${1#*=}"
      require_value "--base-dir" "$base_dir"
      shift
      ;;
    --rebuild)
      rebuild=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      server_args+=("$@")
      break
      ;;
    *)
      server_args+=("$1")
      shift
      ;;
  esac
done

[[ "$port" =~ ^[0-9]+$ ]] || die "port must be an integer between 1 and 65535"
((port >= 1 && port <= 65535)) || die "port must be an integer between 1 and 65535"
[[ -n "$host" ]] || die "host must not be empty"
[[ -n "$base_dir" ]] || die "base directory must not be empty"

build_release() {
  command -v docker >/dev/null 2>&1 || die "Docker is required for the first build"
  docker info >/dev/null 2>&1 || die "Docker is installed but is not running"

  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-release-build.XXXXXX")"

  printf 'Building the production bundle inside Docker...\n'
  if ! docker build \
    --progress=plain \
    --file "$repo_root/Dockerfile.local-release" \
    --output "type=local,dest=$output_dir" \
    "$repo_root"; then
    rm -rf "$output_dir"
    die "Docker production build failed"
  fi

  [[ -f "$output_dir/bin.mjs" ]] || {
    rm -rf "$output_dir"
    die "Docker build did not produce bin.mjs"
  }
  [[ -f "$output_dir/client/index.html" ]] || {
    rm -rf "$output_dir"
    die "Docker build did not produce the web client"
  }

  rm -rf "$server_dist"
  mkdir -p "$(dirname "$server_dist")"
  mv "$output_dir" "$server_dist"
}

if [[ "$rebuild" == true || ! -f "$server_dist/bin.mjs" || ! -f "$server_dist/client/index.html" ]]; then
  build_release
fi

command -v node >/dev/null 2>&1 || die "Node.js is required to run the production bundle"
command -v npm >/dev/null 2>&1 || die "npm is required to locate t3@latest's native modules"

printf 'Locating the native runtime from t3@latest...\n'
t3_bin="$(npm exec --yes --package=t3@latest -- sh -c 'command -v t3')"
[[ -n "$t3_bin" ]] || die "npm could not install or locate t3@latest"

runtime_info="$({ node - "$t3_bin" <<'NODE'
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const binPath = fs.realpathSync(process.argv[2]);
let packageDir = path.dirname(binPath);

while (packageDir !== path.dirname(packageDir)) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.name === "t3") {
      const platformPackageName = `@t3code/t3-${process.platform}-${process.arch}`;
      const requireFromT3 = createRequire(packageJsonPath);
      let platformPackageJsonPath;

      try {
        platformPackageJsonPath = requireFromT3.resolve(`${platformPackageName}/package.json`);
      } catch {
        throw new Error(`t3@latest is missing its native runtime package ${platformPackageName}`);
      }

      const platformPackage = JSON.parse(fs.readFileSync(platformPackageJsonPath, "utf8"));
      const nodeModules = path.join(path.dirname(platformPackageJsonPath), "node_modules");
      for (const packageName of Object.keys(platformPackage.dependencies ?? {})) {
        if (!fs.existsSync(path.join(nodeModules, packageName, "package.json"))) {
          throw new Error(`t3@latest is missing native runtime package ${packageName}`);
        }
      }
      process.stdout.write(`${nodeModules}\n${packageJson.version}\n`);
      process.exit(0);
    }
  }
  packageDir = path.dirname(packageDir);
}

throw new Error(`Could not find the t3 package containing ${binPath}`);
NODE
  } 2>&1)" || die "$runtime_info"

native_node_modules="${runtime_info%%$'\n'*}"
t3_version="${runtime_info#*$'\n'}"
[[ -d "$native_node_modules" ]] || die "resolved t3@latest node_modules does not exist"

runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-local-runtime.XXXXXX")"
cleanup() {
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

mkdir -p "$runtime_dir/apps/server"
cp -R "$server_dist" "$runtime_dir/apps/server/dist"
ln -s "$native_node_modules" "$runtime_dir/node_modules"

printf 'Running local production build with t3@%s native dependencies.\n' "$t3_version"
printf 'State directory: %s/userdata\n' "$base_dir"
printf 'URL: http://%s:%s\n' "$host" "$port"

node "$runtime_dir/apps/server/dist/bin.mjs" \
  --port "$port" \
  --host "$host" \
  --base-dir "$base_dir" \
  --log-level error \
  "${server_args[@]}"
