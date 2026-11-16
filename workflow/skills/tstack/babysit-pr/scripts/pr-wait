#!/usr/bin/env python3
"""pr-wait: watch one GitHub pull request and print one line per real event.

  pr-wait <pr> [--repo owner/name] [--until green|ready|any-change] [--interval 20]

<pr> is a PR number or PR URL. Without --repo, the repo comes from the URL or
from the current checkout. Stdout carries only events, one line each, so a
monitor (Claude Code's Monitor tool) wakes the agent once per real event.
Progress and errors that do not end the run go to stderr.

--until
  green       required checks passed on the current head (every CI check when
              the base branch requires none)
  ready      green, Greptile or Macroscope reviewed the current head, and no
              review thread is unresolved (default)
  any-change  stop after the first poll that prints an event

Exit codes
  0  the --until condition is met, or the PR merged
  1  the condition cannot be met without action: a required check failed, the
     branch conflicts with its base, the PR closed, `ready` is blocked by
     unresolved threads or a BEHIND branch, or GitHub stayed unreachable
  2  bad arguments, unknown PR, or another pr-wait already watches this PR

Events
  - a required check failed (name and link)
  - all checks finished on the head (one summary line)
  - a new comment, review, thread, or thread reply from someone other than the
    PR author or the gh user
  - Greptile, Macroscope, or CodeRabbit finished on the head, or a Greptile or
    Macroscope summary changed after that
  - the base branch moved and the new commits touch files in this PR
  - merge state became BEHIND or DIRTY
  - the PR merged or closed

CodeRabbit is advisory: pr-wait reports it but never waits for it. Comment
edits are never events, and top-level comments from CI and deploy bots
(github-actions, Vercel) are skipped, because checks already carry that news.

State lives in ~/.local/state/pr-wait/. A lock makes a second watcher for the
same PR exit at once. A state file lets a restarted watcher report what arrived
while no watcher ran. The first run for a PR records what already exists and
reports only what comes after.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, NoReturn

GATING_BOTS = ("greptile", "macroscope")
ADVISORY_BOTS = ("coderabbit",)
# CI and deploy bots report through checks. Their PR comments are status reports.
STATUS_BOTS = ("github-actions", "vercel", "netlify", "railway", "cloudflare")
STATE_DIR = Path.home() / ".local" / "state" / "pr-wait"
# A state file older than this describes an old session. Start a fresh baseline
# instead of replaying hours of comments as new events.
STALE_STATE_SECONDS = 6 * 3600
MAX_FAILED_POLLS = 10
TRANSIENT = re.compile(
    r"HTTP (5\d\d|429)|rate limit|timed? ?out|connection (reset|refused)|EOF|"
    r"temporar|could not resolve host|TLS handshake|Something went wrong",
    re.IGNORECASE,
)
FAILED = ("fail", "cancel")
# gh pr checks buckets, worst first. Duplicate names (push and pull_request runs
# of one job) collapse to the worst bucket.
RANK = {"fail": 4, "cancel": 3, "pending": 2, "pass": 1, "skipping": 0}

QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url state headRefOid baseRefName mergeStateStatus
      author { login }
      baseRef { target { oid } }
      comments(last: 100) { nodes { id url body author { login __typename } } }
      reviews(last: 100) {
        nodes { id url state body commit { oid } author { login __typename } }
      }
      reviewThreads(last: 100) {
        nodes {
          isResolved path line
          comments(first: 100) { nodes { id url body author { login __typename } } }
        }
      }
    }
  }
}
"""

Json = dict[str, Any]


class GhError(Exception):
    def __init__(self, message: str, transient: bool) -> None:
        super().__init__(message)
        self.transient = transient


def log(message: str) -> None:
    print(f"pr-wait: {message}", file=sys.stderr, flush=True)


def fail(message: str, code: int = 2) -> NoReturn:
    # Fatal messages go to stdout so a monitor shows the agent why it stopped.
    print(f"pr-wait: {message}", flush=True)
    sys.exit(code)


def gh(args: list[str], allow: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    """Run gh. Retries transient failures (HTTP 5xx or 429, network) with backoff."""
    delay = 2
    for attempt in range(5):
        proc = subprocess.run(["gh", *args], capture_output=True, text=True)
        transient = proc.returncode != 0 and bool(TRANSIENT.search(proc.stderr))
        if not transient and proc.returncode in allow:
            return proc
        lines = proc.stderr.strip().splitlines()
        message = lines[-1] if lines else f"gh exited {proc.returncode}"
        if not transient or attempt == 4:
            raise GhError(message, transient)
        log(f"gh {' '.join(args[:2])}: {message}; retry in {delay}s")
        time.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


def gh_lines(args: list[str]) -> list[str]:
    return [line for line in gh(args).stdout.splitlines() if line]


def bot_name(text: str | None) -> str | None:
    """Which review bot a login or check name belongs to, if any."""
    lowered = (text or "").lower()
    return next((bot for bot in GATING_BOTS + ADVISORY_BOTS if bot in lowered), None)


def who(node: Json) -> tuple[str, bool]:
    author = node.get("author") or {}
    return author.get("login") or "ghost", author.get("__typename") == "Bot"


def plain(body: str) -> str:
    body = re.sub(r"<!--.*?-->", " ", body or "", flags=re.DOTALL)
    return html.unescape(re.sub(r"<[^>]+>", " ", body))


def snippet(body: str, limit: int = 100) -> str:
    text = re.sub(r"\s+", " ", plain(body)).strip()
    return text if len(text) <= limit else text[: limit - 3] + "..."


def verdict(body: str) -> str:
    """The verdict line of a bot summary (Macroscope, Greptile), if it has one."""
    for line in plain(body).splitlines():
        if re.search(r"verdict|confidence score", line, re.IGNORECASE):
            return snippet(line.replace("*", ""), 80)
    return ""


def digest(body: str) -> str:
    return hashlib.sha1(re.sub(r"\s+", " ", plain(body)).encode()).hexdigest()[:12]


def parse_target(raw: str | None, repo: str | None) -> tuple[str, int]:
    if raw is None or not raw.strip():
        fail("missing PR number. Did a variable expand to nothing? Usage: pr-wait <pr> [--repo owner/name]")
    url = re.fullmatch(r"https?://github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)(?:[/?#]\S*)?", raw.strip())
    number = re.fullmatch(r"#?(\d+)", raw.strip())
    if url:
        repo = repo or url.group(1)
        pr = int(url.group(2))
    elif number:
        pr = int(number.group(1))
    else:
        fail(f"'{raw}' is not a PR number or PR URL")
    if pr <= 0:
        fail(f"'{raw}' is not a valid PR number")
    if not repo:
        try:
            repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).stdout.strip()
        except GhError as error:
            fail(f"no --repo given and the current directory has no GitHub repo ({error})")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        fail(f"'{repo}' is not owner/name")
    try:
        gh(["pr", "view", str(pr), "-R", repo, "--json", "number"])
    except GhError as error:
        if not error.transient:  # a transient failure is retried by the poll loop
            fail(f"cannot read {repo}#{pr}: {error}")
    return repo, pr


def lock(repo: str, pr: int) -> Any:
    """Hold a per-PR lock for the life of the process. The OS drops it on exit."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = open(STATE_DIR / f"{repo.replace('/', '__')}__{pr}.lock", "a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.seek(0)
        pid = handle.read().strip() or "unknown"
        fail(
            f"pid {pid} already watches {repo}#{pr}, so this watcher exits to avoid "
            f"duplicate events. If no events reach you from it, run `kill {pid}` and start again."
        )
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    return handle


def required_checks(repo: str, base: str) -> set[str]:
    """Required check names for the base branch, from rulesets and classic branch
    protection. Knowing them up front means a required check that has not started
    yet counts as pending, instead of green by omission."""
    sources = (
        (
            f"repos/{repo}/rules/branches/{base}",
            '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
        ),
        (f"repos/{repo}/branches/{base}/protection/required_status_checks", ".contexts[]?, .checks[]?.context"),
    )
    names: set[str] = set()
    for path, jq in sources:
        try:
            names.update(gh_lines(["api", path, "--jq", jq]))
        except GhError as error:
            if "HTTP 404" not in str(error):  # 404 means no protection, which is normal
                log(f"could not read required checks from {path}: {error}")
    return names


class Watcher:
    def __init__(self, repo: str, pr: int, until: str, interval: int) -> None:
        self.repo, self.pr, self.until, self.interval = repo, pr, until, interval
        self.owner, self.name = repo.split("/")
        self.path = STATE_DIR / f"{repo.replace('/', '__')}__{pr}.json"
        state = self.load()
        # First run for this PR: record what exists and report nothing.
        self.baseline = state is None
        self.state: Json = state or {"reported": [], "summaries": {}, "base_oid": None, "merge_state": None}
        self.reported: set[str] = set(self.state["reported"])
        self.printed: set[str] = set()
        self.events = 0
        self.required: set[str] | None = None
        self.prev_snapshot: list[tuple[str, str]] | None = None
        self.pr_files: dict[str, set[str]] = {}

    def load(self) -> Json | None:
        try:
            if time.time() - self.path.stat().st_mtime > STALE_STATE_SECONDS:
                return None
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return None

    def save(self) -> None:
        self.state["reported"] = sorted(self.reported)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state))
        tmp.replace(self.path)

    def say(self, line: str) -> None:
        if line not in self.printed:
            self.printed.add(line)
            print(f"#{self.pr} {line}", flush=True)

    def emit(self, key: str, line: str) -> None:
        """Print an event once per PR, across restarts."""
        if key in self.reported:
            return
        self.reported.add(key)
        if not self.baseline:
            self.events += 1
            self.say(line)

    def finish(self, code: int, lines: Sequence[str] = ()) -> NoReturn:
        for line in lines:
            self.say(line)
        self.save()
        sys.exit(code)

    def fetch_pr(self) -> Json:
        proc = gh([
            "api", "graphql", "-f", f"query={QUERY}",
            "-f", f"owner={self.owner}", "-f", f"name={self.name}", "-F", f"number={self.pr}",
        ])
        data = json.loads(proc.stdout)["data"]
        pr = data["repository"]["pullRequest"]
        pr["viewer"] = data["viewer"]["login"]
        return pr

    def fetch_checks(self) -> dict[str, Json]:
        # gh pr checks exits 8 while checks are pending and 1 when one failed.
        # Those are states, not errors: read the JSON and ignore the exit code.
        proc = gh(["pr", "checks", str(self.pr), "-R", self.repo, "--json", "name,bucket,link,description"], allow=(0, 1, 8))
        if not proc.stdout.strip():
            if "no checks reported" in proc.stderr:
                return {}
            raise GhError(proc.stderr.strip() or f"gh pr checks exited {proc.returncode}", False)
        checks: dict[str, Json] = {}
        for row in json.loads(proc.stdout):
            current = checks.get(row["name"])
            if current is None or RANK.get(row["bucket"], 2) > RANK.get(current["bucket"], 2):
                checks[row["name"]] = row
        return checks

    def base_overlap(self, head: str, old: str, new: str) -> list[str]:
        """Files this PR touches that the new base commits also touch."""
        try:
            if head not in self.pr_files:
                self.pr_files[head] = set(gh_lines(["pr", "diff", str(self.pr), "-R", self.repo, "--name-only"]))
            moved = gh_lines(["api", f"repos/{self.repo}/compare/{old}...{new}", "--jq", ".files[].filename"])
        except GhError as error:
            log(f"could not compare base commits: {error}")
            return []
        return sorted(self.pr_files[head].intersection(moved))

    def behind(self, base: str, base_oid: str | None, head: str) -> str:
        """How far the head is behind its base, for the green and ready lines."""
        if not base_oid:
            return ""
        try:
            count = gh(["api", f"repos/{self.repo}/compare/{base_oid}...{head}", "--jq", ".behind_by"]).stdout.strip()
        except GhError:
            return ""
        return f"; {count} commit{'' if count == '1' else 's'} behind {base}"

    def poll(self) -> None:
        pr = self.fetch_pr()
        if pr["state"] == "MERGED":
            self.finish(0, [f"merged: {pr['url']}"])
        if pr["state"] == "CLOSED":
            self.finish(1, [f"closed without merging: {pr['url']}"])

        base = pr["baseRefName"]
        if self.required is None:
            self.required = required_checks(self.repo, base)
            gate = ", ".join(sorted(self.required)) or "none set, so every CI check gates"
            log(f"watching {self.repo}#{self.pr} until {self.until}; required checks: {gate}")
        checks = self.fetch_checks()
        head = pr["headRefOid"]
        short = head[:7]
        mine = {who(pr)[0], pr["viewer"]}
        comments = pr["comments"]["nodes"]
        reviews = pr["reviews"]["nodes"]
        threads = pr["reviewThreads"]["nodes"]
        self.events = 0

        # Required checks. With no required checks configured, every CI check
        # gates except the review bots' own checks.
        gate = self.required or {name for name in checks if not bot_name(name)}
        label = "required check" if self.required else "check"

        def bucket(name: str) -> str:
            return checks[name]["bucket"] if name in checks else "pending"

        fail_lines: list[str] = []
        for name in sorted(gate):
            if bucket(name) in FAILED:
                link = checks[name]["link"]
                fail_lines.append(f"{label} failed: {name} {link}")
                self.emit(f"fail:{head}:{name}:{link}", fail_lines[-1])
        watched = {name: c for name, c in checks.items() if bot_name(name) not in ADVISORY_BOTS}
        gate_done = bool(gate) and all(bucket(n) != "pending" for n in gate)
        all_done = gate_done and all(c["bucket"] != "pending" for c in watched.values())
        # Checks appear a few seconds after a push. Two identical polls in a row
        # guard against calling a half-registered set of checks finished.
        snapshot = sorted((name, c["bucket"]) for name, c in watched.items())
        stable = snapshot == self.prev_snapshot
        self.prev_snapshot = snapshot
        green = gate_done and stable and not fail_lines

        # People and bots talking. Edits are never events.
        for comment in comments:
            login, is_bot = who(comment)
            if login in mine or bot_name(login) or (is_bot and any(b in login for b in STATUS_BOTS)):
                continue
            self.emit(f"c:{comment['id']}", f"comment from {login}: {snippet(comment['body'])} {comment['url']}")
        for review in reviews:
            login, is_bot = who(review)
            if login in mine or is_bot:
                continue
            if review["state"] in ("APPROVED", "CHANGES_REQUESTED") or review["body"].strip():
                state = review["state"].lower().replace("_", " ")
                self.emit(f"c:{review['id']}", f"review from {login} ({state}): {snippet(review['body'])} {review['url']}")
        unresolved: list[str] = []
        for thread in threads:
            nodes = thread["comments"]["nodes"]
            if not thread["isResolved"] and nodes:
                unresolved.append(nodes[0]["url"])
            where = f"{thread['path']}:{thread['line']}" if thread["line"] else thread["path"]
            for index, comment in enumerate(nodes):
                login, _ = who(comment)
                if login in mine:
                    continue
                kind = "new thread" if index == 0 else "thread reply"
                self.emit(f"c:{comment['id']}", f"{kind} from {login} on {where}: {snippet(comment['body'])} {comment['url']}")

        # Review bots on the current head. A bot with checks is done when they
        # finish. Otherwise it is done once it reviews the head commit or its
        # summary names the head.
        bot_status: dict[str, str] = {}
        reviewed: list[str] = []
        for bot in GATING_BOTS + ADVISORY_BOTS:
            own_checks = {name: c for name, c in checks.items() if bot_name(name) == bot}
            summaries = [c for c in comments if bot_name(who(c)[0]) == bot]
            own_reviews = [r for r in reviews if bot_name(who(r)[0]) == bot]
            on_head = any((r.get("commit") or {}).get("oid") == head for r in own_reviews)
            if own_checks:
                done = all(c["bucket"] != "pending" for c in own_checks.values())
            else:
                done = on_head or any(short in s["body"] for s in summaries)
            seen = bool(own_checks or summaries or own_reviews)
            if bot in ADVISORY_BOTS and own_checks:
                desc = next(iter(own_checks.values()))
                bot_status[bot] = f"{bot} {desc['description'] or desc['bucket']} (advisory)"
            elif seen:
                bot_status[bot] = f"{bot} {'done' if done else 'pending'}{' (advisory)' if bot in ADVISORY_BOTS else ''}"
            key = f"bot:{bot}:{head}"
            was_done = key in self.reported
            if done:
                if bot in GATING_BOTS:
                    reviewed.append(bot)
                failed = [name for name, c in own_checks.items() if c["bucket"] in FAILED]
                detail = "; ".join(filter(None, [
                    next((v for v in map(verdict, (s["body"] for s in summaries)) if v), ""),
                    f"failed: {', '.join(failed)}" if failed else "",
                ]))
                tag = " (advisory, not waited on)" if bot in ADVISORY_BOTS else ""
                self.emit(key, f"{bot} finished on {short}{': ' + detail if detail else ''}{tag}")
            if bot in GATING_BOTS:
                for s in summaries:
                    new, old = digest(s["body"]), self.state["summaries"].get(s["id"])
                    self.state["summaries"][s["id"]] = new
                    if was_done and old and old != new:
                        text = verdict(s["body"]) or snippet(s["body"])
                        self.emit(f"summary:{s['id']}:{new}", f"{bot} summary changed on {short}: {text} {s['url']}")

        # Base branch and merge state.
        base_oid = ((pr.get("baseRef") or {}).get("target") or {}).get("oid")
        old_base = self.state["base_oid"]
        if base_oid and old_base and base_oid != old_base and not self.baseline:
            touched = self.base_overlap(head, old_base, base_oid)
            if touched:
                more = f" and {len(touched) - 5} more" if len(touched) > 5 else ""
                self.emit(
                    f"base:{base_oid}",
                    f"{base} moved to {base_oid[:7]} and touches files in this PR: {', '.join(touched[:5])}{more}",
                )
        if base_oid:
            self.state["base_oid"] = base_oid
        merge_state = pr["mergeStateStatus"]
        dirty_line = f"merge state is DIRTY: the branch conflicts with {base}, rebase it"
        behind_line = f"merge state is BEHIND: update the branch from {base} before merging"
        if merge_state != "UNKNOWN":
            if merge_state in ("BEHIND", "DIRTY") and self.state["merge_state"] != merge_state:
                line = dirty_line if merge_state == "DIRTY" else behind_line
                self.emit(f"merge:{merge_state}:{head}:{base_oid}", line)
            self.state["merge_state"] = merge_state

        # One summary line per head once all checks finish.
        counts: dict[str, int] = {}
        for c in watched.values():
            counts[c["bucket"]] = counts.get(c["bucket"], 0) + 1
        failed_names = sorted(name for name, c in watched.items() if c["bucket"] in FAILED)
        parts = [
            ", ".join(f"{n} {b}" for b, n in sorted(counts.items()))
            + (f" ({', '.join(failed_names)})" if failed_names else ""),
            f"required {sum(bucket(n) in ('pass', 'skipping') for n in self.required)}/{len(self.required)} green"
            if self.required
            else "",
            ", ".join(bot_status[b] for b in GATING_BOTS + ADVISORY_BOTS if b in bot_status)
            or "no Greptile or Macroscope yet",
            f"{len(unresolved)} unresolved threads",
            f"merge state {merge_state}",
        ]
        summary = "; ".join(p for p in parts if p)
        checks_key = f"checks:{head}"

        # Decide whether to stop. A green or ready line carries the same summary
        # as the checks line, so it marks that event as reported.
        if self.until != "any-change":
            if merge_state == "DIRTY":
                self.finish(1, [dirty_line])
            if fail_lines:
                self.finish(1, fail_lines)
            if green and self.until == "green":
                self.reported.add(checks_key)
                self.finish(0, [f"green on {short}: {summary}{self.behind(base, base_oid, head)}"])
            # ready waits for Greptile or Macroscope, never for CodeRabbit.
            if green and reviewed:
                if unresolved:
                    self.finish(1, [f"blocked by {len(unresolved)} unresolved threads on {short}: {' '.join(unresolved)}"])
                if merge_state == "BEHIND":
                    self.finish(1, [behind_line])
                self.reported.add(checks_key)
                self.finish(0, [f"ready on {short}: {summary}{self.behind(base, base_oid, head)}"])
        if all_done and (stable or self.baseline):
            self.emit(checks_key, f"checks finished on {short}: {summary}")
        if self.until == "any-change" and self.events:
            self.finish(0)

    def run(self) -> NoReturn:
        failures = 0
        while True:
            try:
                self.poll()
                failures = 0
            except GhError as error:
                if not error.transient:
                    self.finish(1, [f"pr-wait stopped: {error}"])
                failures += 1
                log(f"poll failed ({failures}/{MAX_FAILED_POLLS}): {error}")
                if failures >= MAX_FAILED_POLLS:
                    self.finish(1, [f"pr-wait stopped: GitHub unreachable for {failures} polls: {error}"])
            else:
                self.save()
                if self.baseline:
                    log(f"baseline recorded for {self.repo}#{self.pr}; reporting only new events")
                self.baseline = False
            time.sleep(self.interval)


def main() -> None:
    parser = argparse.ArgumentParser(prog="pr-wait", description="Watch a GitHub PR and print one line per real event.")
    parser.add_argument("pr", nargs="?", help="PR number or URL")
    parser.add_argument("--repo", help="owner/name (default: from the URL or the current checkout)")
    parser.add_argument("--until", choices=("green", "ready", "any-change"), default="ready")
    parser.add_argument("--interval", type=int, default=20, help="seconds between polls (default 20, min 5)")
    args = parser.parse_args()
    repo, pr = parse_target(args.pr, args.repo)
    _lock = lock(repo, pr)
    Watcher(repo, pr, args.until, max(args.interval, 5)).run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
