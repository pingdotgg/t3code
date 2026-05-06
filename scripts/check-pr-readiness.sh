#!/usr/bin/env bash
set -euo pipefail

WARN_ONLY="${PR_READINESS_WARN_ONLY:-0}"
SKIP_CI="${PR_READINESS_SKIP_CI:-0}"
REQUIRED_CHECKS="${PR_READINESS_REQUIRED_CHECKS:-validate,preflight,env-audit}"
CI_WAIT_SECONDS="${PR_READINESS_CI_WAIT_SECONDS:-600}"
CI_POLL_SECONDS="${PR_READINESS_CI_POLL_SECONDS:-15}"

FAILURES=()
WARNINGS=()

record_issue() {
  local message="$1"
  if [ "$WARN_ONLY" = "1" ]; then
    WARNINGS+=("$message")
  else
    FAILURES+=("$message")
  fi
}

record_warning() {
  local message="$1"
  WARNINGS+=("$message")
}

emit_messages() {
  local prefix="$1"
  shift
  local item
  for item in "$@"; do
    printf '%s %s\n' "$prefix" "$item"
  done
}

is_checked() {
  local label="$1"
  printf '%s' "$PR_BODY_LOWER" | grep -Eq -- "- \[x\] ${label}"
}

is_relevant_markdown_doc() {
  local file="$1"
  case "$file" in
    .github/*.md|.github/**/*.md|README*.md|CONTRIBUTING*.md|SECURITY*.md|CODE_OF_CONDUCT*.md|docs/*.md|docs/**/*.md|AGENTS.md|CLAUDE.md|review.md|.cursor/BUGBOT.md)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

load_local_pr_context() {
  command -v gh >/dev/null 2>&1 || return 1

  PR_URL="$(gh pr view --json url --jq '.url' 2>/dev/null || true)"
  [ -n "${PR_URL:-}" ] || return 1

  PR_BODY="$(gh pr view --json body --jq '.body' 2>/dev/null || true)"
  BASE_REF="$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || true)"
  [ -n "${BASE_REF:-}" ] || return 1

  DIFF_BASE="origin/${BASE_REF}"
  DIFF_HEAD="HEAD"
  return 0
}

if [ -n "${PR_READINESS_BASE_SHA:-}" ] && [ -n "${PR_READINESS_HEAD_SHA:-}" ]; then
  PR_BODY="${PR_READINESS_BODY:-}"
  DIFF_BASE="$PR_READINESS_BASE_SHA"
  DIFF_HEAD="$PR_READINESS_HEAD_SHA"
  PR_URL="${PR_URL:-}"
else
  if ! load_local_pr_context; then
    message="No pull request context found for the current branch."
    if [ "$WARN_ONLY" = "1" ]; then
      printf '[pr-readiness] %s\n' "$message"
      exit 0
    fi
    printf '[pr-readiness] %s\n' "$message" >&2
    exit 1
  fi
fi

PR_BODY_LOWER="$(printf '%s' "$PR_BODY" | tr '[:upper:]' '[:lower:]')"

CHANGED_FILES=()
DIFF_OUTPUT=""
if ! DIFF_OUTPUT="$(git diff --name-only "$DIFF_BASE...$DIFF_HEAD" 2>&1)"; then
  record_issue "Failed to compute diff between $DIFF_BASE and $DIFF_HEAD:
${DIFF_OUTPUT}"
else
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    CHANGED_FILES+=("$line")
  done <<EOF
$DIFF_OUTPUT
EOF
fi

if [ "${#CHANGED_FILES[@]}" -eq 0 ] && [ "${#FAILURES[@]}" -eq 0 ] && [ "${#WARNINGS[@]}" -eq 0 ]; then
  printf '[pr-readiness] No changed files detected.\n'
  exit 0
fi

NON_DOC_CHANGED=0
RELEVANT_DOC_CHANGED=0
TEST_CHANGED=0
CHANGED_DOCS_REPO_GOVERNANCE=0
CHANGED_DOCS_AUTOMATION=0
CHANGED_DOCS_REVIEW_BOOTSTRAP=0
CHANGED_CI_AUTOMATION_CODE=0
CHANGED_RULES_OR_POLICY_CODE=0
CHANGED_REVIEW_SYSTEM_CODE=0
CHANGED_CONTRIBUTOR_WORKFLOW_CODE=0

for file in "${CHANGED_FILES[@]}"; do
  if is_relevant_markdown_doc "$file"; then
    RELEVANT_DOC_CHANGED=1
  elif [[ "$file" != *.md ]]; then
    NON_DOC_CHANGED=1
  fi

  if [[ "$file" =~ (^|/)(__tests__/|tests?/).* ]] || [[ "$file" =~ \.(test|spec)\.[A-Za-z0-9]+$ ]]; then
    TEST_CHANGED=1
  fi

  # Doc buckets for path-based expectations.
  case "$file" in
    README*.md|CONTRIBUTING*.md|SECURITY*.md|CODE_OF_CONDUCT*.md|docs/*.md|docs/**/*.md|AGENTS.md|CLAUDE.md)
      CHANGED_DOCS_REPO_GOVERNANCE=1
      ;;
  esac

  case "$file" in
    .github/*.md|.github/**/*.md)
      CHANGED_DOCS_AUTOMATION=1
      ;;
  esac

  case "$file" in
    review.md|.cursor/BUGBOT.md)
      CHANGED_DOCS_REVIEW_BOOTSTRAP=1
      ;;
  esac

  # Code/path buckets that should usually trigger specific docs updates.
  case "$file" in
    .github/workflows/*|.github/actions/**|.github/*.yml|.github/*.yaml)
      CHANGED_CI_AUTOMATION_CODE=1
      ;;
  esac

  case "$file" in
    .ai/rules/*|AGENTS.md|CLAUDE.md|.cursorrules)
      CHANGED_RULES_OR_POLICY_CODE=1
      ;;
  esac

  case "$file" in
    .cursor/*|.cursor/**|review.md)
      CHANGED_REVIEW_SYSTEM_CODE=1
      ;;
  esac

  case "$file" in
    scripts/*|scripts/**)
      CHANGED_CONTRIBUTOR_WORKFLOW_CODE=1
      ;;
  esac
done

DOCS_UPDATED_CHECKED=0
NO_DOC_IMPACT_CHECKED=0
TESTS_UPDATED_CHECKED=0
NO_TEST_IMPACT_CHECKED=0
CI_GREEN_CHECKED=0

is_checked "relevant markdown docs updated" && DOCS_UPDATED_CHECKED=1
is_checked "no documentation impact" && NO_DOC_IMPACT_CHECKED=1
is_checked "tests added or updated for this change" && TESTS_UPDATED_CHECKED=1
is_checked "no test impact" && NO_TEST_IMPACT_CHECKED=1
is_checked "all required ci checks are green" && CI_GREEN_CHECKED=1

if [ "$DOCS_UPDATED_CHECKED" = "1" ] && [ "$NO_DOC_IMPACT_CHECKED" = "1" ]; then
  record_warning "PR body marks both docs updated and no documentation impact. Choose one."
fi

if [ "$TESTS_UPDATED_CHECKED" = "1" ] && [ "$NO_TEST_IMPACT_CHECKED" = "1" ]; then
  record_issue "PR body marks both tests updated and no test impact. Choose one."
fi

if [ "$NON_DOC_CHANGED" = "1" ]; then
  if [ "$RELEVANT_DOC_CHANGED" = "0" ] && [ "$NO_DOC_IMPACT_CHECKED" = "0" ]; then
    record_warning "Non-Markdown changes were detected, but no relevant Markdown docs changed and the PR does not mark 'No documentation impact'."
  fi

  if [ "$DOCS_UPDATED_CHECKED" = "1" ] && [ "$RELEVANT_DOC_CHANGED" = "0" ]; then
    record_warning "PR body claims relevant docs were updated, but no relevant Markdown docs changed."
  fi

  # Path-based doc expectations (warning-only). These apply only when the PR
  # does not explicitly mark "No documentation impact".
  if [ "$NO_DOC_IMPACT_CHECKED" = "0" ]; then
    if [ "$CHANGED_CI_AUTOMATION_CODE" = "1" ] && [ "$CHANGED_DOCS_AUTOMATION" = "0" ]; then
      record_warning "CI/workflow changes detected under .github/, but no .github Markdown docs changed."
    fi

    if [ "$CHANGED_RULES_OR_POLICY_CODE" = "1" ] && [ "$CHANGED_DOCS_REPO_GOVERNANCE" = "0" ]; then
      record_warning "Rules/policy changes detected, but no governance docs changed (README/CONTRIBUTING/SECURITY/docs/AGENTS/CLAUDE)."
    fi

    if [ "$CHANGED_REVIEW_SYSTEM_CODE" = "1" ] && [ "$CHANGED_DOCS_REVIEW_BOOTSTRAP" = "0" ]; then
      record_warning "Review-system changes detected, but review bootstrap docs were not updated (review.md or .cursor/BUGBOT.md)."
    fi

    if [ "$CHANGED_CONTRIBUTOR_WORKFLOW_CODE" = "1" ] && [ "$CHANGED_DOCS_REPO_GOVERNANCE" = "0" ]; then
      record_warning "Contributor workflow/script changes detected, but no contributor-facing docs changed."
    fi
  fi

  if [ "$TEST_CHANGED" = "0" ] && [ "$NO_TEST_IMPACT_CHECKED" = "0" ]; then
    record_issue "Non-Markdown changes were detected, but no test files changed and the PR does not mark 'No test impact'."
  fi

  if [ "$TESTS_UPDATED_CHECKED" = "1" ] && [ "$TEST_CHANGED" = "0" ]; then
    record_issue "PR body claims tests were updated, but no test files changed."
  fi
fi

if [ "$SKIP_CI" != "1" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    record_issue "GitHub CLI is required to verify PR checks locally."
  else
    HEAD_SHA="$(git rev-parse "$DIFF_HEAD" 2>/dev/null || true)"
    if [ -z "$HEAD_SHA" ]; then
      record_issue "Failed to resolve PR head SHA for CI check verification."
    else
      REPO_FULL_NAME="${GITHUB_REPOSITORY:-}"
      if [ -z "$REPO_FULL_NAME" ]; then
        REPO_FULL_NAME="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
      fi

      if [ -z "$REPO_FULL_NAME" ]; then
        record_issue "Failed to resolve repository name for CI check verification."
      else
        IFS=',' read -r -a REQUIRED_CHECK_ARRAY <<< "$REQUIRED_CHECKS"
        SANITIZED_REQUIRED_CHECKS=()
        for required_check in "${REQUIRED_CHECK_ARRAY[@]}"; do
          required_check="$(printf '%s' "$required_check" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"
          [ -n "$required_check" ] || continue
          SANITIZED_REQUIRED_CHECKS+=("$required_check")
        done

        if [ "${#SANITIZED_REQUIRED_CHECKS[@]}" -eq 0 ]; then
          record_issue "PR_READINESS_REQUIRED_CHECKS resolved to an empty list."
        else
          # Never poll for the check-run that this job itself produces (deadlock).
          # Build CHECKS_TO_POLL by excluding the current GitHub Actions job name.
          CURRENT_JOB_NAME="${GITHUB_JOB:-}"
          CHECKS_TO_POLL=()
          SELF_REF_SKIPPED=0
          for required_check in "${SANITIZED_REQUIRED_CHECKS[@]}"; do
            if [ -n "$CURRENT_JOB_NAME" ] && [ "$required_check" = "$CURRENT_JOB_NAME" ]; then
              record_issue "PR_READINESS_REQUIRED_CHECKS must not include '$CURRENT_JOB_NAME' because this job cannot wait for itself."
              SELF_REF_SKIPPED=1
              continue
            fi
            CHECKS_TO_POLL+=("$required_check")
          done

          if [ "${#CHECKS_TO_POLL[@]}" -eq 0 ]; then
            if [ "$SELF_REF_SKIPPED" != "1" ]; then
              record_issue "PR_READINESS_REQUIRED_CHECKS has no checks left to verify after excluding the current job."
            fi
          else
            CHECKS_READY=0
            FAILED_CHECK_MESSAGE=""
            WAIT_REASON=""
            deadline=$((SECONDS + CI_WAIT_SECONDS))

            while true; do
              CHECKS_JSON="$(gh api -H "Accept: application/vnd.github+json" \
                "repos/${REPO_FULL_NAME}/commits/${HEAD_SHA}/check-runs?per_page=100" 2>&1 || true)"

              if ! printf '%s' "$CHECKS_JSON" | jq -e '.check_runs' >/dev/null 2>&1; then
                FAILED_CHECK_MESSAGE="Failed to fetch check runs for PR head:
${CHECKS_JSON}"
                break
              fi

              WAIT_REASON=""
              FAILED_CHECK_MESSAGE=""
              ALL_GREEN=1

              for required_check in "${CHECKS_TO_POLL[@]}"; do
                LATEST_CHECK_RUN="$(printf '%s' "$CHECKS_JSON" | jq -c --arg name "$required_check" '[.check_runs[] | select(.name == $name)] | sort_by((.started_at // ""), (.id // 0)) | reverse | .[0] // empty')"
                if [ -z "$LATEST_CHECK_RUN" ]; then
                  ALL_GREEN=0
                  WAIT_REASON="Required CI check '$required_check' has not appeared yet."
                  continue
                fi

                LATEST_STATUS="$(printf '%s' "$LATEST_CHECK_RUN" | jq -r '.status // ""')"
                LATEST_CONCLUSION="$(printf '%s' "$LATEST_CHECK_RUN" | jq -r '.conclusion // ""')"
                if [ "$LATEST_STATUS" != "completed" ]; then
                  ALL_GREEN=0
                  WAIT_REASON="Required CI check '$required_check' is still running."
                  continue
                fi

                if [ "$LATEST_CONCLUSION" = "success" ]; then
                  continue
                fi

                if [ -n "$LATEST_CONCLUSION" ]; then
                  ALL_GREEN=0
                  FAILED_CHECK_MESSAGE="Required CI check '$required_check' completed with conclusion '$LATEST_CONCLUSION'."
                  break
                fi

                ALL_GREEN=0
                FAILED_CHECK_MESSAGE="Required CI check '$required_check' completed with unknown conclusion."
                break
              done

              if [ -n "$FAILED_CHECK_MESSAGE" ]; then
                break
              fi

              if [ "$ALL_GREEN" = "1" ]; then
                CHECKS_READY=1
                break
              fi

              if [ "$SECONDS" -ge "$deadline" ]; then
                FAILED_CHECK_MESSAGE="Timed out waiting ${CI_WAIT_SECONDS}s for required CI checks to turn green. Last observed state: ${WAIT_REASON}"
                break
              fi

              sleep "$CI_POLL_SECONDS"
            done

            if [ "$CHECKS_READY" = "1" ]; then
              if [ "$CI_GREEN_CHECKED" = "0" ]; then
                record_issue "Required CI checks are green, but the PR body does not mark 'All required CI checks are green'."
              fi
            else
              record_issue "$FAILED_CHECK_MESSAGE"
            fi
          fi
        fi
      fi
    fi
  fi
fi

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  printf '[pr-readiness] warning-only findings:\n'
  emit_messages '  -' "${WARNINGS[@]}"
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '[pr-readiness] failed:\n' >&2
  emit_messages '  -' "${FAILURES[@]}" >&2
  exit 1
fi

printf '[pr-readiness] ok'
if [ -n "${PR_URL:-}" ]; then
  printf ' (%s)' "$PR_URL"
fi
printf '\n'
