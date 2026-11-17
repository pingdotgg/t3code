"""Graph rules TLC cannot state directly, run on the state graph TLC dumps (-dump dot,actionlabels).
usage: uv run --with networkx python check.py STATES.dot
Needs node on PATH: step words come from view.mjs, so the paths read like the chart."""
import json, re, subprocess, sys
from collections import Counter, deque
from pathlib import Path
import networkx as nx

HERE = Path(__file__).parent
NODE = re.compile(r'^(-?\d+) \[label="(.*?)"(?:,style = filled)?\];?$')
EDGE = re.compile(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"')


def parse_state(label):
    d = {}
    for part in label.split("\\n"):
        m = re.match(r'/\\\\ (\w+) = (.*)$', part)
        if m:
            k, v = m.groups()
            v = v.replace('\\"', '"')
            if v.startswith("["):
                v = dict(re.findall(r'(\w+) \|-> "(\w+|-)"', v))
            else:
                v = v.strip('"')
            d[k] = v
    return d


states, G = {}, nx.DiGraph()
for line in open(sys.argv[1]):
    m = NODE.match(line)
    if m:
        states[m.group(1)] = parse_state(m.group(2))
        continue
    m = EDGE.match(line)
    if m:
        u, v, a = m.groups()
        if G.has_edge(u, v):
            G[u][v]["acts"].add(a)
        else:
            G.add_edge(u, v, acts={a})
G.add_nodes_from(states)
ACTIONS = sorted({a for _, _, d in G.edges(data=True) for a in d["acts"]})
WORDS = json.loads(subprocess.run(["node", "-e", "import('./view.mjs').then(m=>console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(a=>[a,m.step(a)??a])))))", *ACTIONS], cwd=HERE, capture_output=True, text=True, check=True).stdout)
words = lambda a: WORDS.get(a, a)
print(f"{G.number_of_nodes()} states, {G.number_of_edges()} edges")

# who acts: the user or the master thread (the user's own), versus automation (maestro, workers, the agent running a skill)
USER_NAMES = {"RoutePlanFile", "BcheckPicks"}
is_user = lambda a: a.startswith(("User", "Master")) or a in USER_NAMES
ph = lambda n: states[n]["ph"]
terminal = lambda n: ph(n) in ("Done", "Stopped")

init = [n for n in G if G.in_degree(n) == 0]
parent = {n: None for n in init}
dq = deque(init)
while dq:
    u = dq.popleft()
    for v in G.successors(u):
        if v not in parent:
            parent[v] = u
            dq.append(v)


def path(n):
    steps = []
    root = n
    while parent[root] is not None:
        root = parent[root]
    st = states[root]
    steps_prefix = [f"(start: maestro {'does not exist' if st['mst'] == 'none' else 'thread exists, asleep'}; idea {'runs under the maestro skill' if st['mm'] == 'TRUE' else 'is filed by a skill run directly'})"]
    while parent[n] is not None:
        steps.append(sorted(G[parent[n]][n]["acts"], key=lambda a: (not is_user(a), a))[0])
        n = parent[n]
    return steps_prefix + [words(a) for a in reversed(steps)]


def depth(n):
    k = 0
    while parent[n] is not None:
        n, k = parent[n], k + 1
    return k


def back_reach(targets, graph):
    seen, todo = set(targets), list(targets)
    while todo:
        for p in graph.predecessors(todo.pop()):
            if p not in seen:
                seen.add(p)
                todo.append(p)
    return seen


def show(name, bad, note):
    if not bad:
        print(f"PASS {name}")
        return
    best = min(bad, key=depth)
    print(f"FAIL {name}: {len(bad)} states. {note}\n     shortest path ({depth(best)} steps):")
    for i, w in enumerate(path(best)):
        print(f"       {i}. {w}")
    sig = Counter(describe(states[n]) for n in bad)
    for d, c in sig.most_common(6):
        print(f"     stuck as: {d} (x{c})")


def describe(st):
    s = ",".join(f"{k}:{v}" for k, v in st["s"].items() if v != "-")
    extra = " ".join(f"{k}={st[k]}" for k in ("hd", "is", "tr", "mst", "owe") if st[k] not in ("-", "FALSE"))
    return f"{st['ph']} [{s}] {extra}".strip()


# 1. every idea can still reach merged or a stop by the user
done = {n for n in G if ph(n) == "Done"}
stop = {n for n in G if ph(n) == "Stopped"}
can_end = back_reach(done | stop, G)
show("EveryStateCanReachMergedOrStop", [n for n in G if n not in can_end], "no way to Done or to a user stop")
# 1b. the same for merged alone, from states where tickets are already filed (nobody can "stop" a running pipeline)
can_merge = back_reach(done, G)
tr_ph = [n for n in G if n not in can_merge and not terminal(n) and any(v != "-" for v in states[n]["s"].values())]
show("FiledStatesCanStillReachMerged", tr_ph, "tickets are filed but merged is out of reach (a user stop does not count)")

# 2. no state where nobody acts and nothing wakes anyone
WAITS = {"GAsked", "GConfirm", "SAsked", "TQuiz", "PPresent", "PBlocked", "PAmbig", "PReapprove", "PGaps", "WNoFog", "WFogAsk", "MAsk"}


def attention(n):
    st = states[n]
    if terminal(n) or st["ph"] in WAITS or st["hd"] in ("bcq", "bcp", "bca") or st["is"] == "pr" or st["tr"] in ("batch", "sum"):
        return True
    if {"Help", "HAnn"} & set(st["s"].values()):
        return True  # the maestro messaged the master
    if st["ph"] in ("Idea", "WIdle"):
        return True  # the user holds the baton by design
    started = st["hd"] != "-" or st["is"] != "-" or st["tr"] != "-" or "Claimed" in st["s"].values()
    if st["ph"] == "Exec" and st["mst"] == "none" and st["owe"] == "FALSE" and not started:
        return True  # no maestro exists: the user picks the executor
    return False


auto = nx.DiGraph([(u, v) for u, v, d in G.edges(data=True) if any(not is_user(a) for a in d["acts"])])
auto.add_nodes_from(G)
wakes = back_reach([n for n in G if attention(n)], auto)
stalled = [n for n in G if n not in wakes]
sinks = [n for n in stalled if auto.out_degree(n) == 0]  # where it actually stops; the rest of `stalled` only leads there


def why(n):
    st = states[n]
    tk = [v for v in st["s"].values() if v != "-"]
    if st["s"]["S"] == "Epic" and all(st["s"][t] == "Merged" for t in st["s"] if t != "S"):
        return "every ticket merged, epic still open, maestro asleep, nobody nudges it"
    if st["mst"] == "off" and "Ready" in tk and st["hd"] == "-" and st["is"] != "run":
        return "tickets ready, maestro asleep (heartbeat paused or deleted), nobody told to wake it"
    if set(tk) <= {"Merged", "HReady"} and "HReady" in tk:
        return "only ready-for-human tasks left; nobody tells the person"
    return "other: " + describe(st)


if not sinks:
    print("PASS NoSilentStall")
else:
    print(f"FAIL NoSilentStall: {len(stalled)} states cannot reach a prompt, a wake or the end; {len(sinks)} of them are dead ends")
    seen = {}
    for n in sorted(sinks, key=depth):
        seen.setdefault(why(n), n)
    for reason, n in seen.items():
        print(f"     - {reason} ({sum(1 for x in sinks if why(x) == reason)} states); shortest path ({depth(n)} steps):")
        for i, w in enumerate(path(n)):
            print(f"         {i}. {w}")

# 3. no loop only the agent can leave: a cycle made of automation steps with no prompt in it
loops = [c for c in nx.strongly_connected_components(auto) if len(c) > 1 or any(auto.has_edge(n, n) for n in c)]
loops = [c for c in loops if not any(attention(n) for n in c)]
if not loops:
    print("PASS NoAgentOnlyLoop")
else:
    sig = Counter(tuple(sorted({ph(n) for n in c})) for c in loops)
    best = min((n for c in loops for n in c), key=depth)
    print(f"FAIL NoAgentOnlyLoop: {len(loops)} cycles of automation steps, no user prompt inside. phases: {dict(sig)}")
    print(f"     shortest path into one ({depth(best)} steps):")
    for i, w in enumerate(path(best)):
        print(f"       {i}. {w}")

# 4. approval points really require the user: every step that leaves a wait for the user is a user step
AWAIT_VAR = [("ph", WAITS), ("hd", {"bcp", "bca"}), ("is", {"pr"}), ("tr", {"sum"})]
bad_edges = []
for u, v, d in G.edges(data=True):
    for var, vals in AWAIT_VAR:
        if states[u][var] in vals and states[u][var] != states[v][var] and not all(is_user(a) for a in d["acts"]):
            bad_edges.append((u, v))
show("ApprovalsRequireTheUser", sorted({u for u, _ in bad_edges}), "an agent step leaves a state that waits for the user")

# 5. every route can reach merged: the idea runs through each skill chain and ends in Done
for r in ("spec", "plan", "wayfinder"):
    ok = any(ph(n) == "Done" and states[n]["route"] == r for n in G)
    print(f"{'PASS' if ok else 'FAIL'} RouteReachesMerged[{r}]")
