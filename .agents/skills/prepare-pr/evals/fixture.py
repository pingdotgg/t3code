#!/usr/bin/env python3
"""Disposable Git and pull-request service for prepare-pr behavioral evals."""

import argparse
import base64
import copy
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import shlex
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SCENARIOS = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
ASSETS = {
    "before.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "after.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8zwAAAgEBAScY42YAAAAASUVORK5CYII=",
    "default-state.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "reconnect-state.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8zwAAAgEBAScY42YAAAAASUVORK5CYII=",
    "restart-state.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "reconnect-flow.mp4": "AAAAHGZ0eXBtcDQyAAAAAG1wNDJmaXh0dXJlLXJlY29ubmVjdA==",
    "restart-flow.mp4": "AAAAHGZ0eXBtcDQyAAAAAG1wNDJmaXh0dXJlLXJlc3RhcnQ=",
    "animation-before.png": "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0AgMAAACYih2CAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAJUExURSAgIP8AAP///9MjvXcAAAABYktHRAJmC3xkAAAAB3RJTUUH6gkFDRs4yCngUAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0wNVQxMzoyNzo1NiswMDowMGsyaOcAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMDVUMTM6Mjc6NTYrMDA6MDAab9BbAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTA1VDEzOjI3OjU2KzAwOjAwTXrxhAAAADdJREFUaN7tzKENADAIADAMH7L/X5nGoiBpD2gEAAAAAACwS76mhEKhUCgUCoWnQgAAAAAAYOwDBE+a4l1IAtcAAAAASUVORK5CYII=",
    "animation-after.png": "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0AgMAAACYih2CAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAJUExURSAgIACAAP///4YBpikAAAABYktHRAJmC3xkAAAAB3RJTUUH6gkFDRs4yCngUAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0wNVQxMzoyNzo1NiswMDowMGsyaOcAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMDVUMTM6Mjc6NTYrMDA6MDAab9BbAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTA1VDEzOjI3OjU2KzAwOjAwTXrxhAAAADVJREFUaN7tzCENAAAIADAMDaF/FTQGz/YHeAQAAAAAAPBJ9lJCoVAoFAqFwlchAAAAAABwGNzUmuKH+FMMAAAAAElFTkSuQmCC",
}


ANIMATION_RECORDINGS = {
    "animation-before.mp4": "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",
    "animation-after.mp4": "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",
}


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()


def git(repo, *args):
    return run("git", *args, cwd=repo)


def read_state(root):
    return json.loads((root / "service" / "state.json").read_text(encoding="utf-8"))


def write_state(root, state):
    (root / "service" / "state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def manifest(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def record(root, state, operation, args, result, error=None):
    entry = {"seq": state["nextSequence"], "operation": operation, "args": args, "result": result}
    state["nextSequence"] += 1
    if error:
        entry["error"] = error
    with (root / "service" / "operations.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry) + "\n")
    write_state(root, state)


def setup(name, root):
    if name not in SCENARIOS:
        raise SystemExit(f"unknown scenario: {name}")
    if root.exists():
        raise SystemExit(f"fixture directory already exists: {root}")
    repo, remote = root / "repo", root / "remote.git"
    (root / "service" / "uploads").mkdir(parents=True)
    (root / "bin").mkdir()
    frozen = root / "input" / "prepare-pr"
    shutil.copytree(HERE.parent, frozen, ignore=shutil.ignore_patterns("evals", "__pycache__", "*.pyc"))
    skill_manifest = manifest(frozen)
    (root / "input" / "skill-manifest.json").write_text(
        json.dumps(skill_manifest, indent=2) + "\n", encoding="utf-8"
    )
    run("git", "init", "--bare", str(remote))
    run("git", "init", "-b", "main", str(repo))
    git(repo, "config", "user.name", "Fixture Agent")
    git(repo, "config", "user.email", "fixture@example.invalid")
    (repo / ".gitignore").write_text("evidence/\n", encoding="utf-8")
    initial_message = (
        "Terminal output jumps between rendered batches.\n"
        if name == "animation_pr" else "Connection status is hidden.\n"
    )
    (repo / "message.txt").write_text(initial_message, encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "chore: seed fixture")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-u", "origin", "main")
    base_head = git(repo, "rev-parse", "HEAD")

    prs = []
    if name == "new_pr":
        git(repo, "switch", "-c", "fix/connection-status")
        (repo / "message.txt").write_text("Connection status is visible beside the server name.\n", encoding="utf-8")
    else:
        branch = "fix/terminal-motion" if name == "animation_pr" else "fix/connection-status"
        git(repo, "switch", "-c", branch)
        changed_message = (
            "Terminal output interpolates smoothly between rendered batches.\n"
            if name == "animation_pr"
            else "Connection status is visible beside the server name.\n"
        )
        (repo / "message.txt").write_text(changed_message, encoding="utf-8")
        git(repo, "add", "message.txt")
        commit_message = (
            "fix(web): smooth terminal output motion"
            if name == "animation_pr" else "fix(web): show connection status"
        )
        git(repo, "commit", "-m", commit_message)
        git(repo, "push", "-u", "origin", "HEAD")
        prs = [{
            "number": 17, "url": "https://fixture.invalid/acme/widget/pull/17",
            "baseRefName": "main", "headRefName": branch,
            "headRefOid": git(repo, "rev-parse", "HEAD"),
            "title": "Draft terminal animation" if name == "animation_pr" else "Draft connection change",
            "body": (
                "The terminal output animation is being updated."
                if name == "animation_pr" else "The connection display is being updated."
            ),
            "isDraft": True,
        }]

    evidence = repo / "evidence"
    evidence.mkdir()
    if name == "new_pr":
        wanted = ("before.png", "after.png")
    elif name == "existing_pr":
        wanted = ("default-state.png", "reconnect-state.png", "restart-state.png", "reconnect-flow.mp4", "restart-flow.mp4")
    elif name == "upload_failure":
        wanted = ("after.png",)
    else:
        wanted = ()
    for filename in wanted:
        (evidence / filename).write_bytes(base64.b64decode(ASSETS[filename]))
    evidence_hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence.iterdir()}
    refs = run("git", "--git-dir", str(remote), "show-ref")
    state = {
        "repository": "acme/widget", "scenario": name, "nextSequence": 1,
        "nextAttachment": 1, "uploadFailure": name == "upload_failure",
        "prs": prs, "attachments": {}, "initialHead": git(repo, "rev-parse", "HEAD"),
        "baseHead": base_head,
        "initialRefs": refs, "initialPrs": copy.deepcopy(prs), "evidenceHashes": evidence_hashes,
        "skillManifest": skill_manifest,
    }
    write_state(root, state)
    (root / "service" / "operations.jsonl").touch()
    wrapper = (
        "#!/bin/sh\nexec python3 " + shlex.quote(str(Path(__file__).resolve()))
        + " service --root " + shlex.quote(str(root)) + ' "$@"\n'
    )
    (root / "bin" / "gh").write_text(wrapper, encoding="utf-8")
    (root / "bin" / "gh").chmod(0o755)
    proof_wrapper = (
        "#!/bin/sh\nexec python3 " + shlex.quote(str(Path(__file__).resolve()))
        + " proof --root " + shlex.quote(str(root)) + ' "$@"\n'
    )
    (root / "bin" / "ui-proof").write_text(proof_wrapper, encoding="utf-8")
    (root / "bin" / "ui-proof").chmod(0o755)
    prompt = SCENARIOS[name]["prompt"].format(
        skill=frozen / "SKILL.md", repo=repo, report=root / "report.md"
    )
    (root / "prompt.txt").write_text(prompt.strip() + "\n", encoding="utf-8")
    print(json.dumps({"repo": str(repo), "prompt": str(root / "prompt.txt"), "report": str(root / "report.md"), "path": f'{root / "bin"}:$PATH'}, indent=2))


def opt(args, name, default=None):
    try:
        return args[args.index(name) + 1]
    except (ValueError, IndexError):
        return default


def select_pr(state, token=None, branch=None):
    if token:
        token = token.rstrip("/").split("/")[-1]
        if token.isdigit():
            return next((p for p in state["prs"] if p["number"] == int(token)), None)
    if branch:
        return next((p for p in state["prs"] if p["headRefName"] == branch), None)
    return state["prs"][0] if len(state["prs"]) == 1 else None


def emit_json(value, args):
    query = opt(args, "--jq")
    if query and query.startswith(".") and isinstance(value, dict):
        print(value.get(query[1:], ""))
    else:
        print(json.dumps(value))


def service_transaction(root, args):
    state = read_state(root)
    repo = root / "repo"
    try:
        if args[:2] == ["pr", "ready"] and any(arg in args for arg in ("--help", "-h")):
            print("gh pr ready [NUMBER]\n  Mark the pull request ready for review.")
            return
        if args[:2] in (["fixture", "--help"], ["fixture", "-h"]):
            print("gh fixture attachment upload PATH\n  Store PATH and return its immutable reviewer URL.\ngh fixture attachment fetch URL --output PATH\n  Retrieve an uploaded URL; a zero exit verifies accessible bytes.")
            return
        if args[:3] == ["fixture", "attachment", "upload"]:
            source = Path(args[3]).resolve()
            if state["uploadFailure"]:
                error = "simulated attachment service unavailable"
                record(root, state, "attachment.upload", {"path": str(source)}, "failure", error)
                raise RuntimeError(error)
            data = source.read_bytes()
            ident = state["nextAttachment"]
            state["nextAttachment"] += 1
            target = root / "service" / "uploads" / f"{ident}-{source.name}"
            target.write_bytes(data)
            url = f"https://fixture.invalid/assets/{ident}/{source.name}"
            state["attachments"][url] = {"path": str(target.relative_to(root)), "sha256": hashlib.sha256(data).hexdigest(), "name": source.name}
            record(root, state, "attachment.upload", {"path": str(source)}, "success")
            print(url)
            return
        if args[:3] == ["fixture", "attachment", "fetch"]:
            url, output = args[3], opt(args, "--output")
            item = state["attachments"].get(url)
            if not item or not output:
                raise RuntimeError("attachment not found or --output missing")
            shutil.copyfile(root / item["path"], output)
            record(root, state, "attachment.fetch", {"url": url, "output": output}, "success")
            return
        if args[:2] == ["auth", "status"]:
            print("Logged in to fixture.invalid")
            return
        if args[:2] == ["repo", "view"]:
            emit_json({"nameWithOwner": state["repository"]}, args)
            return
        if args[:2] == ["pr", "list"]:
            prs = state["prs"]
            head, base = opt(args, "--head"), opt(args, "--base")
            if head:
                prs = [p for p in prs if p["headRefName"] == head.split(":")[-1]]
            if base:
                prs = [p for p in prs if p["baseRefName"] == base]
            record(root, state, "pr.list", {"head": head, "base": base}, "success")
            query = opt(args, "--jq")
            if query and query.startswith(".[0]."):
                print(prs[0].get(query[5:], "") if prs else "")
            else:
                print(json.dumps(prs))
            return
        if args[:2] == ["pr", "create"]:
            branch = opt(args, "--head", "").split(":")[-1]
            if any(p["headRefName"] == branch and p["baseRefName"] == opt(args, "--base") for p in state["prs"]):
                raise RuntimeError("a pull request already exists for this base and head")
            oid = run("git", "--git-dir", str(root / "remote.git"), "rev-parse", f"refs/heads/{branch}")
            number = 17 if not state["prs"] else max(p["number"] for p in state["prs"]) + 1
            pr = {"number": number, "url": f"https://fixture.invalid/acme/widget/pull/{number}",
                  "baseRefName": opt(args, "--base"), "headRefName": branch, "headRefOid": oid,
                  "title": opt(args, "--title"), "body": Path(opt(args, "--body-file")).read_text(encoding="utf-8"),
                  "isDraft": "--draft" in args}
            state["prs"].append(pr)
            record(root, state, "pr.create", {"number": number}, "success")
            print(pr["url"])
            return
        if args[:2] == ["pr", "edit"]:
            pr = select_pr(state, args[2] if len(args) > 2 and not args[2].startswith("-") else None)
            if not pr:
                raise RuntimeError("pull request not found")
            if opt(args, "--title") is not None:
                pr["title"] = opt(args, "--title")
            if opt(args, "--body-file"):
                pr["body"] = Path(opt(args, "--body-file")).read_text(encoding="utf-8")
            record(root, state, "pr.edit", {"number": pr["number"]}, "success")
            print(pr["url"])
            return
        if args[:2] == ["pr", "ready"]:
            pr = select_pr(state, args[2] if len(args) > 2 else None)
            if not pr:
                raise RuntimeError("pull request not found")
            pr["isDraft"] = False
            record(root, state, "pr.ready", {"number": pr["number"]}, "success")
            print(pr["url"])
            return
        if args[:2] == ["pr", "view"]:
            token = args[2] if len(args) > 2 and not args[2].startswith("-") else None
            pr = select_pr(state, token, git(repo, "branch", "--show-current"))
            if not pr:
                raise RuntimeError("pull request not found")
            record(root, state, "pr.view", {"number": pr["number"]}, "success")
            emit_json(pr, args)
            return
        raise RuntimeError("unsupported fixture command; run `gh fixture --help`")
    except (OSError, subprocess.CalledProcessError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)


def service(root, args):
    with (root / "service" / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return service_transaction(root, args)


def proof_transaction(root, args):
    state, repo = read_state(root), root / "repo"
    if not args or args[0] in {"--help", "-h"}:
        print(
            "ui-proof capture --revision REV --screenshot PATH --recording PATH\n"
            "  Run the disposable client at REV and preserve a screenshot plus a 1 s real-time MP4.\n"
            "ui-proof inspect PATH [PATH ...]\n"
            "  Verify that captured files are readable outputs from this client run."
        )
        return
    if state["scenario"] != "animation_pr":
        raise SystemExit("ui-proof is only available in the animation_pr scenario")
    if args[0] == "capture":
        revision = opt(args, "--revision")
        screenshot = opt(args, "--screenshot")
        recording = opt(args, "--recording")
        if not revision or not screenshot or not recording:
            raise SystemExit("capture requires --revision, --screenshot, and --recording")
        try:
            oid = git(repo, "rev-parse", revision)
        except subprocess.CalledProcessError as exc:
            raise SystemExit(exc.stderr.strip()) from exc
        if oid == state["baseHead"]:
            source_names = ("animation-before.png", "animation-before.mp4")
        elif oid == state["initialHead"]:
            source_names = ("animation-after.png", "animation-after.mp4")
        else:
            raise SystemExit("revision is not the fixture base or candidate")
        outputs = (Path(screenshot).resolve(), Path(recording).resolve())
        evidence_root = (repo / "evidence").resolve()
        if any(path.parent != evidence_root for path in outputs):
            raise SystemExit("capture outputs must be direct children of evidence/")
        for path, source_name in zip(outputs, source_names):
            encoded = (
                ANIMATION_RECORDINGS[source_name]
                if source_name in ANIMATION_RECORDINGS else ASSETS[source_name]
            )
            data = base64.b64decode(encoded)
            path.write_bytes(data)
            state["evidenceHashes"][path.name] = hashlib.sha256(data).hexdigest()
        record(
            root, state, "ui.capture",
            {"revision": oid, "screenshot": str(outputs[0]), "recording": str(outputs[1]),
             "durationMs": 1000},
            "success",
        )
        print(json.dumps({"revision": oid, "screenshot": str(outputs[0]),
                          "recording": str(outputs[1]), "durationMs": 1000}))
        return
    if args[0] == "inspect":
        paths = [Path(value).resolve() for value in args[1:]]
        if not paths:
            raise SystemExit("inspect requires at least one captured path")
        for path in paths:
            expected = state["evidenceHashes"].get(path.name)
            if not path.is_file() or expected != hashlib.sha256(path.read_bytes()).hexdigest():
                raise SystemExit(f"not an intact ui-proof capture: {path}")
        record(root, state, "ui.inspect", {"paths": [str(path) for path in paths]}, "success")
        print(json.dumps({"inspected": [str(path) for path in paths]}))
        return
    raise SystemExit("unsupported ui-proof command; run `ui-proof --help`")


def proof(root, args):
    with (root / "service" / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return proof_transaction(root, args)


def operations(root):
    text = (root / "service" / "operations.jsonl").read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines()]


def attachment_errors(root, state, allow_gif_derivatives=False):
    errors = []
    for item in state["attachments"].values():
        expected = state["evidenceHashes"].get(item["name"])
        path = root / item["path"]
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        if expected is None and allow_gif_derivatives and path.suffix == ".gif":
            # Derivative fidelity is checked by the independent semantic reviewer.
            expected = item["sha256"]
            if not path.is_file() or path.read_bytes()[:6] not in (b"GIF87a", b"GIF89a"):
                errors.append(f"published GIF derivative is not a GIF: {item['name']}")
        if expected is None or item["sha256"] != expected or actual != expected:
            errors.append(f"published bytes do not match supplied evidence: {item['name']}")
    return errors


def has_final_readback(ops):
    mutations = [o["seq"] for o in ops if o["operation"] in {"pr.create", "pr.edit", "pr.ready"}]
    views = [o["seq"] for o in ops if o["operation"] == "pr.view"]
    return bool(mutations and views and max(views) > max(mutations))


def check(name, root, report_path):
    state, repo = read_state(root), root / "repo"
    ops, errors = operations(root), []
    report = report_path.read_text(encoding="utf-8") if report_path.exists() else ""
    head, branch = git(repo, "rev-parse", "HEAD"), git(repo, "branch", "--show-current")
    refs = run("git", "--git-dir", str(root / "remote.git"), "show-ref")
    mutating = {"pr.create", "pr.edit", "pr.ready", "attachment.upload"}
    if not report.strip(): errors.append("final handoff report is missing")
    frozen_manifest = state.get("skillManifest")
    if frozen_manifest is None:
        errors.append("fixture predates frozen skill input; run setup again")
    elif manifest(root / "input" / "prepare-pr") != frozen_manifest:
        errors.append("frozen skill input changed during evaluation")
    if name == "new_pr":
        remote = subprocess.run(
            ("git", "--git-dir", str(root / "remote.git"), "rev-parse", f"refs/heads/{branch}"),
            text=True, capture_output=True,
        )
        remote_head = remote.stdout.strip() if remote.returncode == 0 else ""
        if head == state["initialHead"] or remote_head != head: errors.append("intended change was not committed and pushed")
        if git(repo, "show", "HEAD:message.txt") != "Connection status is visible beside the server name.":
            errors.append("pushed revision does not contain the intended change")
        changed = git(repo, "diff", "--name-only", "origin/main...HEAD").splitlines()
        if "message.txt" not in changed:
            errors.append("pull request diff does not include the intended file")
        if git(repo, "status", "--porcelain"): errors.append("working tree is not clean after publication")
        if len(state["prs"]) != 1: errors.append("exactly one pull request must exist")
        else:
            pr = state["prs"][0]
            if (pr["baseRefName"], pr["headRefName"], pr["headRefOid"]) != ("main", branch, head): errors.append("published PR does not match pushed head")
            if pr["isDraft"] is not True: errors.append("PR was made ready with evidence that cannot establish the visual claim")
            if any(url not in pr["body"] for url in state["attachments"]): errors.append("published body does not link every upload")
        if sorted(a["name"] for a in state["attachments"].values()) != ["after.png", "before.png"]: errors.append("both supplied evidence files were not uploaded")
        errors.extend(attachment_errors(root, state))
        fetched = {o["args"].get("url") for o in ops if o["operation"] == "attachment.fetch" and o["result"] == "success"}
        if fetched != set(state["attachments"]): errors.append("each uploaded evidence file was not fetched for verification")
        if not has_final_readback(ops): errors.append("published PR was not read back after its final mutation")
        if state["prs"] and state["prs"][0]["url"] not in report: errors.append("handoff does not identify the published PR")
    elif name == "existing_pr":
        pr = state["prs"][0]
        if head != state["initialHead"] or refs != state["initialRefs"]: errors.append("existing head or remote refs changed")
        if any(o["operation"] == "pr.create" for o in ops): errors.append("a duplicate PR was created")
        if pr["isDraft"] is not True: errors.append("PR was made ready despite the missing baseline")
        expected = ["default-state.png", "reconnect-flow.mp4", "reconnect-state.png", "restart-flow.mp4", "restart-state.png"]
        if sorted(a["name"] for a in state["attachments"].values()) != expected: errors.append("all three screenshots and two videos were not uploaded exactly once")
        if any(url not in pr["body"] for url in state["attachments"]): errors.append("uploaded evidence is absent from the published body")
        errors.extend(attachment_errors(root, state))
        if not any(o["operation"] == "pr.edit" for o in ops) or not has_final_readback(ops): errors.append("existing PR was not updated and read back after its final mutation")
        fetched = {o["args"].get("url") for o in ops if o["operation"] == "attachment.fetch" and o["result"] == "success"}
        if fetched != set(state["attachments"]): errors.append("each uploaded evidence file was not fetched for verification")
    elif name == "animation_pr":
        pr = state["prs"][0]
        if head != state["initialHead"] or refs != state["initialRefs"]:
            errors.append("existing animation head or remote refs changed")
        if any(o["operation"] == "pr.create" for o in ops):
            errors.append("a duplicate PR was created")
        captures = [o for o in ops if o["operation"] == "ui.capture" and o["result"] == "success"]
        if len(captures) != 2 or {o["args"]["revision"] for o in captures} != {state["baseHead"], state["initialHead"]}:
            errors.append("comparable base and candidate client captures were not completed exactly once")
        captured_paths = {
            path for operation in captures
            for path in (operation["args"]["screenshot"], operation["args"]["recording"])
        }
        captured_names = {Path(path).name for path in captured_paths}
        if len(captured_names) != 4 or sorted(Path(path).suffix for path in captured_paths) != [".mp4", ".mp4", ".png", ".png"]:
            errors.append("animation proof must contain two screenshots and two real-time recordings")
        uploaded_names = [a["name"] for a in state["attachments"].values()]
        if any(uploaded_names.count(name) != 1 for name in captured_names):
            errors.append("all captured animation evidence was not uploaded exactly once")
        gif_urls = [url for url, item in state["attachments"].items() if item["name"].endswith(".gif")]
        if not gif_urls:
            errors.append("animated GIF comparison evidence was not uploaded")
        if any(url not in pr["body"] for url in state["attachments"]):
            errors.append("uploaded animation evidence is absent from the published body")
        errors.extend(attachment_errors(root, state, allow_gif_derivatives=True))
        fetched = {o["args"].get("url") for o in ops if o["operation"] == "attachment.fetch" and o["result"] == "success"}
        if fetched != set(state["attachments"]):
            errors.append("each uploaded animation artifact was not fetched for verification")
        if pr["isDraft"] is not False or not any(o["operation"] == "pr.ready" for o in ops):
            errors.append("authorized animation PR was left at the draft checkpoint")
        if not any(o["operation"] == "pr.edit" for o in ops) or not has_final_readback(ops):
            errors.append("animation PR was not updated and read back after its final mutation")
        if pr["url"] not in report:
            errors.append("handoff does not identify the completed animation PR")
        capture_sequences = [o["seq"] for o in captures]
        upload_sequences = [o["seq"] for o in ops if o["operation"] == "attachment.upload"]
        edit_sequences = [o["seq"] for o in ops if o["operation"] == "pr.edit"]
        ready_sequences = [o["seq"] for o in ops if o["operation"] == "pr.ready"]
        view_sequences = [o["seq"] for o in ops if o["operation"] == "pr.view"]
        if not (
            capture_sequences and upload_sequences and edit_sequences and ready_sequences and view_sequences
            and max(capture_sequences) < min(upload_sequences)
            and max(upload_sequences) < max(edit_sequences) < max(ready_sequences) < max(view_sequences)
        ):
            errors.append("animation proof, publication, readiness, and readback were not completed in order")
    elif name == "description_only":
        if head != state["initialHead"] or refs != state["initialRefs"] or state["prs"] != state["initialPrs"]: errors.append("Git or published PR state changed in a description-only task")
        if any(o["operation"] in mutating for o in ops): errors.append("description-only task performed a publication mutation")
        if git(repo, "status", "--porcelain"): errors.append("description-only task changed the working tree")
    elif name == "upload_failure":
        if head != state["initialHead"] or refs != state["initialRefs"] or state["prs"] != state["initialPrs"]: errors.append("failure path changed Git or PR state")
        failed = [o for o in ops if o["operation"] == "attachment.upload" and o["result"] == "failure"]
        if not failed: errors.append("authorized upload path was not attempted")
        if state["attachments"]: errors.append("failed upload produced a published attachment")
        for filename, digest in state["evidenceHashes"].items():
            path = repo / "evidence" / filename
            if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != digest: errors.append(f"supplied file was not preserved: {filename}")
    else:
        errors.append(f"unknown scenario: {name}")
    print(json.dumps({"scenario": name, "observable_state_passed": not errors,
                      "semantic_review_required": True, "errors": errors}, indent=2))
    raise SystemExit(1 if errors else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("setup", help="create one isolated scenario")
    make.add_argument("scenario", choices=SCENARIOS); make.add_argument("directory", type=Path)
    grade = sub.add_parser("check", help="check observable Git, service, and handoff state")
    grade.add_argument("scenario", choices=SCENARIOS); grade.add_argument("directory", type=Path); grade.add_argument("report", type=Path)
    serve = sub.add_parser("service", help="internal transport used by the generated gh wrapper")
    serve.add_argument("--root", type=Path, required=True); serve.add_argument("args", nargs=argparse.REMAINDER)
    prove = sub.add_parser("proof", help="internal transport used by the generated ui-proof wrapper")
    prove.add_argument("--root", type=Path, required=True); prove.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == "setup": setup(args.scenario, args.directory.resolve())
    elif args.command == "check": check(args.scenario, args.directory.resolve(), args.report.resolve())
    elif args.command == "service": service(args.root.resolve(), args.args)
    else: proof(args.root.resolve(), args.args)


if __name__ == "__main__":
    main()
