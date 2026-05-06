#!/usr/bin/env bash
set -euo pipefail

TARGET="."
MAX_FILES=50
DRY_RUN=false

usage() {
  cat <<'EOF'
Run a local Claude Code security audit.

Usage:
  bash scripts/security-audit.sh [target-directory] [--max-files <n>] [--dry-run]

Output:
  .local/security-audit/<YYYY-MM-DD-HHMMSS>/SUMMARY.md
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-files)
      MAX_FILES="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "[security-audit] Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

if [[ ! "$MAX_FILES" =~ ^[0-9]+$ || "$MAX_FILES" -lt 1 ]]; then
  echo "[security-audit] --max-files must be a positive integer." >&2
  exit 1
fi

if [[ ! -d "$TARGET" && ! -f "$TARGET" ]]; then
  echo "[security-audit] Target not found: $TARGET" >&2
  exit 1
fi

if [[ "$DRY_RUN" != true ]] && ! command -v claude >/dev/null 2>&1; then
  echo "[security-audit] Claude Code CLI is required. Re-run with --dry-run to verify output plumbing only." >&2
  exit 1
fi

timestamp="$(date +%Y-%m-%d-%H%M%S)"
out_dir=".local/security-audit/$timestamp"
mkdir -p "$out_dir"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

is_semgrep_ignored() {
  local file="$1"
  local ignore_file="$repo_root/.semgrepignore"
  [[ -f "$ignore_file" ]] || return 1

  local pattern
  while IFS= read -r pattern || [[ -n "$pattern" ]]; do
    pattern="${pattern%%#*}"
    pattern="${pattern#"${pattern%%[![:space:]]*}"}"
    pattern="${pattern%"${pattern##*[![:space:]]}"}"
    [[ -n "$pattern" ]] || continue
    [[ "$file" == $pattern || "$file" == ./$pattern ]] && return 0
  done < "$ignore_file"

  return 1
}

is_ignored() {
  local file="$1"
  git -C "$repo_root" check-ignore -q -- "$file" 2>/dev/null && return 0
  is_semgrep_ignored "$file"
}

mapfile -t candidates < <(
  find "$TARGET" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    ! -path '*/node_modules/*' \
    ! -path '*/.local/*' \
    ! -path '*/fixtures/*' \
    ! -path '*/generated/*' \
    ! -path '*/dist/*' \
    ! -name '*.test.*' \
    ! -name '*.spec.*' \
    | sort \
    | head -n "$MAX_FILES"
)

files=()
for candidate in "${candidates[@]}"; do
  if is_ignored "$candidate"; then
    continue
  fi
  files+=("$candidate")
done

summary="$out_dir/SUMMARY.md"
{
  echo "# Security Audit Summary"
  echo ""
  echo "- Target: \`$TARGET\`"
  echo "- Files considered: ${#files[@]}"
  echo "- Mode: $([[ "$DRY_RUN" == true ]] && echo dry-run || echo claude-code)"
  echo ""
  echo "## Findings"
} >"$summary"

if [[ "${#files[@]}" -eq 0 ]]; then
  echo "" >>"$summary"
  echo "No eligible source files found." >>"$summary"
  echo "[security-audit] Wrote $summary"
  exit 0
fi

verified_count=0
for file in "${files[@]}"; do
  safe_name="$(printf '%s' "$file" | sed -E 's#[^A-Za-z0-9._-]+#_#g')"
  vuln_file="$out_dir/$safe_name.vuln.md"
  verified_file="$out_dir/$safe_name.verified.md"

  if [[ "$DRY_RUN" == true ]]; then
    {
      echo "# Dry-run finding candidate"
      echo ""
      echo "File: \`$file\`"
      echo ""
      echo "Dry-run mode verifies audit output routing only."
    } >"$vuln_file"
  else
    claude --print "Security-audit pass 1. Review $file for exploitable auth, injection, secret, tenant-isolation, and CI risks. Read recent git history touching this file and note similar files that may need the same fix. Output markdown findings only; output 'NO_FINDINGS' if none." >"$vuln_file"
    if grep -q '^NO_FINDINGS$' "$vuln_file"; then
      rm -f "$vuln_file"
      continue
    fi
  fi

  if [[ "$DRY_RUN" == true ]]; then
    cp "$vuln_file" "$verified_file"
  else
    claude --print "Security-audit pass 2. Verify exploitability for findings in $vuln_file. Keep only confirmed issues. Output markdown; output 'NO_VERIFIED_FINDINGS' if none." >"$verified_file"
    if grep -q '^NO_VERIFIED_FINDINGS$' "$verified_file"; then
      rm -f "$verified_file"
      continue
    fi
  fi

  verified_count=$((verified_count + 1))
  echo "- $file -> \`$(basename "$verified_file")\`" >>"$summary"
done

if [[ "$verified_count" -eq 0 ]]; then
  echo "" >>"$summary"
  echo "No verified findings." >>"$summary"
fi

echo "" >>"$summary"
echo "Verified reports: $verified_count" >>"$summary"
echo "[security-audit] Wrote $summary"
