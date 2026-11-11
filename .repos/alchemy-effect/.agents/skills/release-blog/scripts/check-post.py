#!/usr/bin/env python3
"""Check a release blog post before handing it over.

    python3 -I .agents/skills/release-blog/scripts/check-post.py website/src/content/docs/blog/<post>.md [pr-dir]

- every `](/path)` and `](/path#anchor)` resolves to a page and heading under website/src/content/docs
- every `](#anchor)` matches a heading in the post
- every ```diff block renders with even indentation (the website build's odd-indent check)
- with pr-dir (collect-prs.sh's output), every feat, fix, perf or breaking PR is cited
"""
import json
import os
import re
import sys

ROOT = "website/src/content/docs"


def slug(heading: str) -> str:
    h = re.sub(r"`", "", heading.strip().lower())
    h = re.sub(r"[^\w\- ]", "", h)
    return h.replace(" ", "-")


def headings(text: str) -> set[str]:
    return {slug(h) for h in re.findall(r"^#+ (.*)$", text, re.M)}


def check_links(post: str) -> list[str]:
    problems = []
    own = headings(post)
    for link in sorted(set(re.findall(r"\]\((/[^)\s]*)\)", post))):
        path, _, anchor = link.partition("#")
        path = path.strip("/")
        if re.search(r"\.\w+$", path):  # a static asset such as an image
            if not os.path.exists(f"website/public/{path}"):
                problems.append(f"missing asset: {link}")
            continue
        candidates = [f"{ROOT}/{path}{ext}" for ext in (".md", ".mdx", "/index.md", "/index.mdx")]
        page = next((c for c in candidates if os.path.exists(c)), None)
        if page is None:
            problems.append(f"missing page: {link}")
        elif anchor and anchor not in headings(open(page).read()):
            problems.append(f"missing anchor: {link}")
    for anchor in re.findall(r"\]\(#([^)]+)\)", post):
        if anchor not in own:
            problems.append(f"missing anchor in post: #{anchor}")
    return problems


def check_diffs(post: str) -> list[str]:
    problems = []
    lines = post.split("\n")
    i = 0
    while i < len(lines):
        fence = re.match(r"^(\s*)```diff", lines[i])
        if fence:
            indent = len(fence.group(1))
            j = i + 1
            body = []
            while not lines[j].strip().startswith("```"):
                body.append(lines[j][indent:])
                j += 1
            nonblank = [l for l in body if l.strip()]
            least = min(len(l) - len(l.lstrip(" ")) for l in nonblank)
            if not any(l[:1] not in "+-" and len(l) - len(l.lstrip(" ")) == 0 for l in nonblank):
                problems.append(f"line {i + 1}: diff block has no column-0 context line")
            for l in nonblank:
                rendered = l[least:]
                if rendered[:1] in "+-":
                    rendered = rendered[1:]
                if (len(rendered) - len(rendered.lstrip(" "))) % 2:
                    problems.append(f"line {i + 1}: odd indentation: {l!r}")
            i = j
        i += 1
    return problems


def check_coverage(post: str, pr_dir: str) -> list[str]:
    cited = set(re.findall(r"/pull/(\d+)", post))
    problems = []
    for n in open(f"{pr_dir}/nums.txt").read().split():
        if n in cited:
            continue
        pr = json.load(open(f"{pr_dir}/{n}.json"))
        title = pr["title"]
        if re.match(r"(feat|fix|perf)\b", title) or re.match(r"\w+(\([^)]*\))?!:", title):
            problems.append(f"uncited: #{n} {title}")
    return problems


def main() -> None:
    post = open(sys.argv[1]).read()
    problems = check_links(post) + check_diffs(post)
    # uncited PRs are for review, not failures: each must be a deliberate skip
    for line in check_coverage(post, sys.argv[2]) if len(sys.argv) > 2 else []:
        print(line)
    for p in problems:
        print(p)
    print("ok" if not problems else f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
