#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET_ROOT="$REPO_ROOT"
PROFILE="minimal"
MANIFEST=""

ERRORS=()
WARNINGS=()

usage() {
  cat <<'EOF'
Verify template-governance adoption status in a repository.

Usage:
  bash scripts/verify-template-adoption.sh [options]

Options:
  --target <path>    Repository root to verify (default: current repo root)
  --profile <name>   minimal | full (default: minimal)
  --manifest <path>  Explicit manifest file (overrides --profile)
  -h, --help         Show this help
EOF
}

push_error() { ERRORS+=("$1"); }
push_warning() { WARNINGS+=("$1"); }

search_file() {
  local pattern="$1"
  local file_path="$2"

  if command -v rg >/dev/null 2>&1; then
    rg -n "$pattern" "$file_path" >/dev/null
    return
  fi

  grep -nE "$pattern" "$file_path" >/dev/null
}

expect_command_success() {
  local description="$1"
  shift

  if ! "$@" >/dev/null 2>&1; then
    push_error "$description"
  fi
}

expect_command_failure() {
  local description="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    push_error "$description"
  fi
}

verify_manifest_directory() {
  local rel_dir="$1"
  local source_dir="$REPO_ROOT/${rel_dir%/}"
  local target_dir="$TARGET_ROOT/${rel_dir%/}"

  if [[ ! -d "$source_dir" ]]; then
    push_error "Template manifest directory is missing in source: $rel_dir"
    return
  fi

  if [[ ! -d "$target_dir" ]]; then
    push_error "Missing required directory: $rel_dir"
    return
  fi

  while IFS= read -r -d '' source_file; do
    local sub_path="${source_file#"$source_dir/"}"
    local rel_file="${rel_dir%/}/$sub_path"
    if [[ ! -f "$TARGET_ROOT/$rel_file" ]]; then
      push_error "Missing required file: $rel_file"
    fi
  done < <(find "$source_dir" -type f -print0)
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_ROOT="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[verify] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$PROFILE" != "minimal" && "$PROFILE" != "full" ]]; then
  echo "[verify] --profile must be minimal or full." >&2
  exit 1
fi

if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "[verify] Target root not found: $TARGET_ROOT" >&2
  exit 1
fi

if [[ ! -d "$TARGET_ROOT/.git" ]]; then
  echo "[verify] Target is not a git repository: $TARGET_ROOT" >&2
  exit 1
fi

if [[ -z "$MANIFEST" ]]; then
  MANIFEST="$REPO_ROOT/.template/adoption/${PROFILE}-files.txt"
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "[verify] Manifest not found: $MANIFEST" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  push_warning "jq is not installed, so AI loop config validation will be limited."
fi

while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
  [[ -n "$rel_path" ]] || continue
  [[ "$rel_path" =~ ^# ]] && continue
  if [[ "$rel_path" == */ ]]; then
    verify_manifest_directory "$rel_path"
    continue
  fi
  if [[ ! -f "$TARGET_ROOT/$rel_path" ]]; then
    push_error "Missing required file: $rel_path"
  fi
done < "$MANIFEST"

# Bootstrap placeholders should not remain.
if [[ -f "$TARGET_ROOT/docs/project.md" ]]; then
  if search_file "YOUR_PRODUCT_NAME|YOUR_APP_NAME|\\[who are they\\?\\]|YOUR_DOPPLER_PROJECT" "$TARGET_ROOT/docs/project.md"; then
    push_error "docs/project.md still contains template placeholders."
  fi
  if ! search_file '^-\s+\*\*Environment tiers\*\*:\s+(2|3)\s*$' "$TARGET_ROOT/docs/project.md"; then
    push_error "docs/project.md must declare Environment tiers as 2 or 3."
  fi
fi

if [[ -f "$TARGET_ROOT/review.md" ]]; then
  if search_file "TEMPLATE_OR_PRODUCT|YOUR_PRIORITY_1|path/glob/\\*\\*" "$TARGET_ROOT/review.md"; then
    push_error "review.md still contains template placeholders."
  fi
fi

if [[ -f "$TARGET_ROOT/.cursor/BUGBOT.md" ]]; then
  if search_file "TEMPLATE_OR_PRODUCT|YOUR_TEAM_NAME|YOUR_PRIORITY_1|path/glob/\\*\\*" "$TARGET_ROOT/.cursor/BUGBOT.md"; then
    push_error ".cursor/BUGBOT.md still contains template placeholders."
  fi
fi

# Workflow / script health checks.
if [[ -f "$TARGET_ROOT/.github/workflows/pr-readiness.yml" ]]; then
  if ! search_file 'PR_READINESS_SKIP_CI: "0"' "$TARGET_ROOT/.github/workflows/pr-readiness.yml"; then
    push_error ".github/workflows/pr-readiness.yml should set PR_READINESS_SKIP_CI to \"0\"."
  fi
  if ! search_file 'PR_READINESS_REQUIRED_CHECKS' "$TARGET_ROOT/.github/workflows/pr-readiness.yml"; then
    push_warning ".github/workflows/pr-readiness.yml is missing PR_READINESS_REQUIRED_CHECKS; default 'validate' may be wrong for this repo."
  fi
fi

if [[ -f "$TARGET_ROOT/scripts/check-pr-readiness.sh" ]]; then
  if ! search_file 'PR_READINESS_REQUIRED_CHECKS' "$TARGET_ROOT/scripts/check-pr-readiness.sh"; then
    push_error "scripts/check-pr-readiness.sh does not support PR_READINESS_REQUIRED_CHECKS."
  fi
fi

if [[ -f "$TARGET_ROOT/package.json" ]]; then
  if ! search_file '"preflight"\s*:\s*"bun run scripts/preflight/runner.ts"' "$TARGET_ROOT/package.json"; then
    push_error "package.json must expose bun preflight via scripts/preflight/runner.ts."
  fi
else
  push_warning "package.json is missing, so bun preflight wiring could not be verified."
fi

if [[ -f "$TARGET_ROOT/tasks.yml" && "$PROFILE" = "full" ]]; then
  if ! search_file '^  preflight:' "$TARGET_ROOT/tasks.yml"; then
    push_error "tasks.yml is missing the preflight task."
  fi
  if ! search_file '^  env-audit:' "$TARGET_ROOT/tasks.yml"; then
    push_error "tasks.yml is missing the env-audit task."
  fi
fi

if [[ -f "$TARGET_ROOT/scripts/check-port-policy.sh" ]]; then
  expect_command_success \
    "scripts/check-port-policy.sh rejects valid explicit ports." \
    bash "$TARGET_ROOT/scripts/check-port-policy.sh" \
      --port app=12000 \
      --port api=12001
  expect_command_failure \
    "scripts/check-port-policy.sh should fail when no explicit ports are provided." \
    bash "$TARGET_ROOT/scripts/check-port-policy.sh"
  expect_command_failure \
    "scripts/check-port-policy.sh should reject ports below 10000." \
    bash "$TARGET_ROOT/scripts/check-port-policy.sh" \
      --port app=9999 \
      --port api=12001
  expect_command_failure \
    "scripts/check-port-policy.sh should reject duplicate service ports." \
    bash "$TARGET_ROOT/scripts/check-port-policy.sh" \
      --port app=12000 \
      --port api=12000
fi

if [[ -f "$TARGET_ROOT/scripts/setup-domain.sh" ]]; then
  expect_command_success \
    "scripts/setup-domain.sh should accept explicit non-default ports in --dry-run mode." \
    bash "$TARGET_ROOT/scripts/setup-domain.sh" \
      demo \
      --app-port 12000 \
      --api-port 12001 \
      --dry-run
  expect_command_failure \
    "scripts/setup-domain.sh should require both --app-port and --api-port." \
    bash "$TARGET_ROOT/scripts/setup-domain.sh" \
      demo \
      --app-port 12000 \
      --dry-run
  expect_command_failure \
    "scripts/setup-domain.sh should reject ports below 10000." \
    bash "$TARGET_ROOT/scripts/setup-domain.sh" \
      demo \
      --app-port 9999 \
      --api-port 12001 \
      --dry-run
  expect_command_failure \
    "scripts/setup-domain.sh should reject duplicate port assignments." \
    bash "$TARGET_ROOT/scripts/setup-domain.sh" \
      demo \
      --app-port 12000 \
      --api-port 12000 \
      --dry-run
fi

if [[ -f "$TARGET_ROOT/tasks.yml" && ! -f "$TARGET_ROOT/.rwx/ci.yml" ]]; then
  push_warning "tasks.yml exists but .rwx/ci.yml is missing (RWX GitHub trigger discovery may fail)."
fi

if [[ -f "$TARGET_ROOT/.github/ai-loop.yml" ]]; then
  if command -v jq >/dev/null 2>&1; then
    enabled="$(jq -r '.enabled' "$TARGET_ROOT/.github/ai-loop.yml" 2>/dev/null || echo "__parse_error__")"
    executor_bot_login="$(jq -r '.executor_bot_login' "$TARGET_ROOT/.github/ai-loop.yml" 2>/dev/null || echo "")"
    if [[ "$enabled" = "__parse_error__" ]]; then
      push_error ".github/ai-loop.yml must remain valid JSON-formatted YAML."
    fi
    if [[ "$enabled" = "true" && -z "$executor_bot_login" ]]; then
      push_error ".github/ai-loop.yml is enabled but executor_bot_login is empty."
    fi
    if [[ "$enabled" = "true" ]]; then
      while IFS= read -r workflow_name; do
        [[ -n "$workflow_name" ]] || continue
        workflow_path="$TARGET_ROOT/.github/workflows/$workflow_name.yml"
        if [[ -f "$workflow_path" ]]; then
          push_warning "AI loop is enabled, but legacy workflow $workflow_name.yml still exists."
        fi
      done < <(jq -r '.legacy_workflows_present[]' "$TARGET_ROOT/.github/ai-loop.yml" 2>/dev/null || true)
    fi
    if [[ "$enabled" = "true" ]]; then
      if command -v gh >/dev/null 2>&1; then
        remote_url="$(git -C "$TARGET_ROOT" remote get-url origin 2>/dev/null || echo "")"
        repo_full_name="$(printf '%s' "$remote_url" | sed -E 's#(git@github.com:|https://github.com/)##; s/\.git$//')"
        if [[ -n "$repo_full_name" ]]; then
          if ! gh api "repos/$repo_full_name/installations" >/dev/null 2>&1; then
            push_warning "AI loop is enabled, but GitHub App installation could not be verified for $repo_full_name."
          fi
        else
          push_warning "AI loop is enabled, but the repository remote could not be mapped to owner/name for App verification."
        fi
      else
        push_warning "AI loop is enabled, but gh is unavailable so GitHub App installation could not be verified."
      fi
    fi
  fi
fi

if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
  echo "[verify] warnings:"
  for w in "${WARNINGS[@]}"; do
    echo "  - $w"
  done
fi

if [[ "${#ERRORS[@]}" -gt 0 ]]; then
  echo "[verify] errors:" >&2
  for e in "${ERRORS[@]}"; do
    echo "  - $e" >&2
  done
  exit 1
fi

echo "[verify] OK: template adoption baseline looks healthy."
