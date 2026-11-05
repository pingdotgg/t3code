#!/usr/bin/env bash
# Prints a T3 Learn release's notes: a "What's new" line per change on main
# since <since>, then every change and the install steps under "Full changelog".
# The desktop update prompt shows only what comes before that <details> block.
set -euo pipefail

since="${1:?usage: t3-learn-release-notes.sh <previous release tag> <commit>}"
commit="${2:?usage: t3-learn-release-notes.sh <previous release tag> <commit>}"

shas="$(git rev-list --reverse --first-parent "$since..$commit")"
new=()
all=()
while read -r sha; do
  [[ -n "$sha" ]] || continue
  subject="$(git log -1 --format=%s "$sha")"
  title="$subject"
  pr=""
  if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
    pr=" (#${BASH_REMATCH[1]})"
    title="$(git log -1 --format=%b "$sha" | sed -n '/./{p;q;}')"
    [[ -n "$title" ]] || title="$subject"
  fi
  all+=("- $title$pr")
  if [[ "$title" =~ sync\ with\ upstream ]]; then
    new+=("- The latest changes from T3 Code")
    continue
  fi
  if [[ "$title" =~ ^([a-z]+)(\(([^\)]*)\))?!?:\ *(.+)$ ]]; then
    type="${BASH_REMATCH[1]}"
    scope="${BASH_REMATCH[3]}"
    text="${BASH_REMATCH[4]}"
    [[ "$type" =~ ^(chore|ci|build|test|tests|docs|refactor|style)$ ]] && continue
    [[ "$scope" =~ ^(release|ci)$ ]] && continue
    title="${text^}"
  fi
  new+=("- $title")
done <<<"$shas"

echo "### What's new"
echo
if ((${#new[@]})); then
  printf '%s\n' "${new[@]}"
else
  echo "- Maintenance and build fixes."
fi
cat <<'EOF'

<details>
<summary>Full changelog</summary>

EOF
((${#all[@]})) && printf '%s\n' "${all[@]}"
cat <<'EOF'

**Install.** T3 Learn installs next to T3 Code and keeps its own projects and settings, so an existing T3 Code stays exactly as it is.

macOS and Linux:

```sh
curl -fsSL https://github.com/aabdel0181/t3-learn/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/aabdel0181/t3-learn/releases/latest/download/install.ps1 | iex
```

Run the same command again to update. Installed apps also update themselves.

</details>
EOF
