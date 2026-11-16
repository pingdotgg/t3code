"""Explore the maestro model with a plain BFS into a NetworkX DiGraph, then ask the graph questions.
usage: python check.py [recheck|norecheck] [--restart N] [--skip-nudge]"""
import sys
from collections import Counter
import networkx as nx
import model as M

args = sys.argv[1:]
cfg = M.Cfg(
    recheck="norecheck" not in args,
    restart=int(args[args.index("--restart") + 1]) if "--restart" in args else 0,
    master_skips_nudge="--skip-nudge" in args,
)
name = "_".join(a for a in args if not a.isdigit()).replace("--", "") or "faithful"

G = nx.DiGraph()
init = M.init()
G.add_node(init)
frontier = [init]
while frontier:
    nxt = []
    for u in frontier:
        if not (M.one_worker_per_issue(u) and M.never_claim_blocked(u)):
            continue  # stop at a broken state, like a checker halting on first violation; it stays in the graph as a sink
        for lab, v, kind in M.successors(u, cfg):
            if v not in G:
                G.add_node(v)
                nxt.append(v)
            if G.has_edge(u, v):  # parallel labels between the same pair: keep first label, one kind wins as auto
                if kind == "auto":
                    G[u][v]["kind"] = "auto"
            else:
                G.add_edge(u, v, label=lab, kind=kind)
    frontier = nxt
print(f"[{name}] {G.number_of_nodes()} states, {G.number_of_edges()} edges")


DIST = nx.single_source_shortest_path_length(G, init)


def can_reach(graph, targets):
    seen, todo = set(targets), list(targets)
    while todo:
        for p in graph.predecessors(todo.pop()):
            if p not in seen:
                seen.add(p)
                todo.append(p)
    return seen


def trace(target):
    p = nx.shortest_path(G, init, target)
    return [(G[a][b]["label"]) for a, b in zip(p, p[1:])]


# 1. safety rules: shortest counterexample = BFS shortest path to the first bad state
for rule, f in [("one worker per issue", M.one_worker_per_issue), ("blocked issue never claimed", M.never_claim_blocked)]:
    bad = [n for n in G if not f(n)]
    if not bad:
        print(f"  OK   {rule}")
        continue
    best = min(bad, key=DIST.get)
    print(f"  FAIL {rule}: {len(bad)} bad states; shortest counterexample ({DIST[best]} steps):")
    for k, l in enumerate(trace(best), 1):
        print(f"       {k}. {l}")

# 2. AG EF merged(i): from every reachable state, some path reaches merged (humans may act)
for i, I in enumerate(M.ISSUES):
    target = {n for n in G if M.merged(i)(n)}
    can = can_reach(G, target)
    dead = [n for n in G if n not in can]
    if dead:
        best = min(dead, key=DIST.get)
        print(f"  FAIL {I} can always still reach merged: {len(dead)} states cannot; shortest:")
        for k, l in enumerate(trace(best), 1):
            print(f"       {k}. {l}")
    else:
        print(f"  OK   {I} can always still reach merged")

# 3. no silent stall: following only automatic steps, every state reaches 'merged, or waiting on a human decision'
A = nx.DiGraph([(u, v) for u, v, d in G.edges(data=True) if d["kind"] == "auto"])
A.add_nodes_from(G)
goal = {n for n in G if M.good(n)}
ok = can_reach(A, goal)
stall = [n for n in G if n not in ok]
if stall:
    best = min(stall, key=DIST.get)
    print(f"  FAIL no silent stall: {len(stall)} states where automation alone can never finish or ask a human; shortest:")
    for k, l in enumerate(trace(best), 1):
        print(f"       {k}. {l}")
    print("       stuck at:", {I: M.issue_phase(best, i) for i, I in enumerate(M.ISSUES)})
else:
    print("  OK   no silent stall")

# 4. diagram: project every transition onto issue A's lifecycle (the quotient graph) -> Mermaid
def render(issue, path):
    i = M.ISSUES.index(issue)
    Q = Counter()
    for u, v, d in G.edges(data=True):
        a, b = M.issue_phase(u, i), M.issue_phase(v, i)
        if a != b:
            Q[(a, b, d["label"].replace(issue, "<issue>").replace("W1", "<W>").replace("W2", "<W>"))] += 1
    ids = {}
    for a, b, _ in Q:
        for x in (a, b):
            ids.setdefault(x, f"n{len(ids)}")
    badphases = {"in-progress but nobody owns it", "needs-help raised, worker ending, maestro not yet looked"}
    L = ["flowchart LR", f"  %% lifecycle of one issue ({issue}), every full-model step that changes it, {name} variant"]
    for x, k in ids.items():
        L.append(f'  {k}("{x}")')
    for (a, b, lab), c in sorted(Q.items()):
        L.append(f'  {ids[a]} -->|"{lab}"| {ids[b]}')
    L.append("  classDef warn fill:#fff3e6,stroke:#e8730c")
    L.append("  classDef done fill:#e3ffe8,stroke:#2a9d4a")
    for x, k in ids.items():
        if x == "merged":
            L.append(f"  class {k} done")
        if x in badphases:
            L.append(f"  class {k} warn")
    open(path, "w").write("\n".join(L) + "\n")


render("A", f"lifecycle-{name}.mmd")
print(f"  wrote lifecycle-{name}.mmd")
