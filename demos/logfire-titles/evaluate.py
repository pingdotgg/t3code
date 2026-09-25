# /// script
# requires-python = ">=3.12"
# dependencies = ["logfire==5.1.0", "pydantic-evals==2.47.0"]
# ///
"""Evaluate real T3 first-message titles and publish a Pydantic Evals experiment."""
import argparse
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import uuid
from urllib.parse import quote

import logfire
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator

ROOT = Path(__file__).resolve().parents[2]
DEMO = Path(__file__).resolve().parent


def checks(case, title):
    text = title.casefold()
    return {
        "identifies_subject": all(any(term in text for term in group) for group in case["subject_groups"]),
    }


@dataclass
class TitleQuality(Evaluator):
    def evaluate(self, ctx):
        return ctx.output["checks"]


async def main(args):
    # Reuse the operator's one private environment file; never print credentials.
    env = json.loads(subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {loadRepoEnv} from './scripts/lib/public-config.ts'; const {T3CODE_OTLP_HEADERS,LOGFIRE_TOKEN}=loadRepoEnv(); console.log(JSON.stringify({T3CODE_OTLP_HEADERS,LOGFIRE_TOKEN}));",
    ], cwd=ROOT, text=True))
    headers = env.get("T3CODE_OTLP_HEADERS", "")
    token = env.get("LOGFIRE_TOKEN") or next((part.split("=", 1)[1] for part in headers.split(",") if part.strip().lower().startswith("authorization=")), None)
    if not token:
        raise SystemExit("Add your Logfire write token to .env.local using the demo env template.")
    logfire.configure(token=token, service_name="t3-title-evals", console=False, metrics=False)
    corpus = json.loads((DEMO / "corpus.json").read_text())
    run_id = args.name or datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if not run_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_." for c in run_id):
        raise SystemExit("Use letters, numbers, dots, underscores and hyphens in the run name.")
    output_dir = ROOT / ".t3" / "title-evals" / run_id
    output_dir.mkdir(parents=True, exist_ok=False)
    result = {
        "run_id": run_id, "created_at": datetime.now(timezone.utc).isoformat(),
        "model": "gpt-6-luna", "reasoning_effort": "low", "repeat": args.repeat,
        "prompt_source": "override" if (DEMO / "title-prompt.txt").read_text().strip() else "builtin",
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
            "demos/logfire-titles/title-prompt.txt",
            "apps/server/src/textGeneration/TextGenerationPrompts.ts",
            "apps/server/src/textGeneration/CodexTextGeneration.ts",
            "apps/server/scripts/logfire-title-initial.mjs",
        ]},
        "corpus_sha256": hashlib.sha256(json.dumps([
            {key: case[key] for key in ("id", "messages", "subject_groups")} for case in corpus
        ], sort_keys=True).encode()).hexdigest(),
        "cases": [],
        "notes": "Three constructed first messages, real T3 title generation through the production prompt builder and Codex adapter. No prior title or later messages. The demo branch deliberately reproduces a truncation regression. Subject checks use vocabulary groups; format counts are observations. This is not a model benchmark or an agent repair success-rate measurement.",
    }

    def save():
        temporary = output_dir / "results.tmp"
        temporary.write_text(json.dumps(result, indent=2) + "\n")
        temporary.replace(output_dir / "results.json")

    save()

    async def generate(case):
        request_id = str(uuid.uuid4())
        with logfire.span("T3 title case {case_id}", case_id=case["id"], run_id=run_id, **{
            "t3.request.id": request_id, "t3.thread.id": "logfire-title-" + case["id"],
        }):
            return await generate_case(case, request_id)

    async def generate_case(case, request_id):
        process = await asyncio.create_subprocess_exec(
            "node", "apps/server/scripts/logfire-title-initial.mjs", case["id"], request_id,
            cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=210)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(f'T3 did not complete title generation for {case["id"]}')
        if process.returncode:
            raise RuntimeError(stderr.decode()[-2000:])
        output = json.loads(stdout)
        output["checks"] = checks(case, output["title"])
        output["format_observations"] = {
            "characters": len(output["title"]), "words": len(output["title"].split()),
        }
        result["cases"].append(output)
        save()
        logfire.info("T3 title evaluated", **output, run_id=run_id, expected_subject_groups=case["subject_groups"],
                     prompt_source=result["prompt_source"], source_sha256=result["source_sha256"],
                     **{"t3.request.id": request_id, "t3.thread.id": output["thread_id"]})
        print(f'{case["id"]}: {output["title"]} | subject={output["checks"]["identifies_subject"]}', flush=True)
        return output

    dataset_name = "T3 first-message titles"
    dataset = Dataset(name=dataset_name, cases=[Case(name=case["id"], inputs=case) for case in corpus], evaluators=[TitleQuality()])
    report = await dataset.evaluate(generate, name=run_id, repeat=args.repeat, max_concurrency=1, progress=False, task_name="generate_chat_title",
                                    metadata={"prompt_source": result["prompt_source"], "source_sha256": result["source_sha256"], "model": "gpt-6-luna", "corpus_sha256": result["corpus_sha256"]})
    report.print(include_input=False, include_output=False)
    url = logfire.url_from_eval(report)
    if url:
        url = url.replace("/evals/compare?", f"/evals/{quote(dataset_name, safe='')}/compare?")
    result["eval_url"] = url
    passed = sum(case["checks"]["identifies_subject"] for case in result["cases"])
    result["subject_passes"] = passed
    result["total"] = len(result["cases"])
    result["all_checks_passes"] = sum(all(case["checks"].values()) for case in result["cases"])
    result["task_errors"] = len(report.failures)
    save()
    if not logfire.force_flush(timeout_millis=30000):
        raise RuntimeError("Logfire export did not finish")
    print(f'Subjects: {passed}/{result["total"]}. Results: {output_dir / "results.json"}')
    if url: print(f"Pydantic Evals: {url}")
    if result["task_errors"]:
        raise SystemExit("Some T3 requests failed; this is an incomplete evaluation.")
    if (ROOT / ".t3/recording-desktop/recording.json").exists():
        mirror = await asyncio.create_subprocess_exec(
            "node", "demos/logfire-titles/sync-desktop.mjs", str(output_dir / "results.json"),
            cwd=ROOT,
        )
        if await mirror.wait():
            print("Evaluation saved; the recording desktop was unavailable for title updates.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--name")
    parser.add_argument("--repeat", type=int, default=1)
    asyncio.run(main(parser.parse_args()))
