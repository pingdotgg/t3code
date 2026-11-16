"""Maestro model 1, plain Python. Successor function only; no checker library.
State is a tuple so it hashes. Toggles live in CFG so the same file makes the faithful and the injected-bug variants."""
from dataclasses import dataclass

ISSUES = ["A", "B", "C"]
DEPS = {"A": [], "B": ["A"], "C": []}  # B is blocked by A
W = 2  # worker slots (N)
NUDGE_MAX = 1  # real skill: 3; reduced to keep the graph small


@dataclass(frozen=True)
class Cfg:
    recheck: bool = True  # maestro re-checks labels right before claiming
    restart: int = 0  # how many times the maestro thread may lose its memory
    master_skips_nudge: bool = False  # master decides in the GitHub UI and never nudges


# state = (s, rq, nud, wk, pend, wake, hb, owe, restarts)
# s[i]  in Ready | Claimed | ClaimedHelp | Help | Merged   (labels on the issue)
# wk[w] in ("Idle",) | ("Run", i) | ("Fin", i, result)
# hb    in on | paused | deleted
def init():
    n = len(ISSUES)
    return (("Ready",) * n, (False,) * n, (0,) * n, (("Idle",),) * W, None, True, "on", False, 0)


def holds(wk, i):
    return sum(1 for x in wk if x[0] != "Idle" and x[1] == i)


def unblocked(s, i):
    return all(s[ISSUES.index(d)] == "Merged" for d in DEPS[ISSUES[i]])


def put(t, k, v):
    return t[:k] + (v,) + t[k + 1 :]


def requeue(s, rq, i):
    return (put(s, i, "Help"), rq) if rq[i] else (put(s, i, "Ready"), put(rq, i, True))


def maestro(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs = st
    if not wake:
        return
    out = []
    for w, x in enumerate(wk):
        if x[0] != "Fin":
            continue
        _, i, r = x
        n, I = f"W{w+1}", ISSUES[i]
        if s[i] == "Merged":
            out.append((f"maestro reaps {n}: {I} merged", (s, rq, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs)))
        elif s[i] == "ClaimedHelp":
            out.append((f"maestro reaps {n}: {I} needs-help, tells master", (put(s, i, "Help"), rq, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs)))
        elif r == "quit" and nud[i] < NUDGE_MAX:
            out.append((f"maestro nudges {n}: {I} still open", (s, rq, put(nud, i, nud[i] + 1), put(wk, w, ("Run", i)), pend, wake, hb, owe, rs)))
        elif r == "quit":
            out.append((f"maestro gives up nudging {n}: {I} needs-help", (put(s, i, "Help"), rq, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs)))
        else:  # died
            s2, rq2 = requeue(s, rq, i)
            lab = f"maestro requeues {I} (worker {n} died)" if not rq[i] else f"maestro gives up on {I}: died twice, needs-help"
            out.append((lab, (s2, rq2, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs)))
    for i, I in enumerate(ISSUES):  # orphan needs-help after a restart: the skill's first tick reaps it (gap 1 fix)
        if s[i] == "ClaimedHelp" and holds(wk, i) == 0:
            out.append((f"maestro reaps orphan {I}: needs-help, tells master", (put(s, i, "Help"), rq, nud, wk, pend, wake, hb, owe, rs)))
    for i, I in enumerate(ISSUES):  # orphan: in-progress, nobody holds it, not mid-claim
        if s[i] == "Claimed" and pend != i and holds(wk, i) == 0:
            s2, rq2 = requeue(s, rq, i)
            out.append((f"maestro requeues orphan {I}", (s2, rq2, nud, wk, pend, wake, hb, owe, rs)))
    if pend is None and any(x[0] == "Idle" for x in wk):
        for i, I in enumerate(ISSUES):
            ok = s[i] == "Ready" if cfg.recheck else s[i] in ("Ready", "Claimed")  # stale search result may still list a claimed issue
            if ok and unblocked(s, i):
                out.append((f"maestro claims {I} (adds in-progress)", (put(s, i, "Claimed"), rq, nud, wk, i, wake, hb, owe, rs)))
    if pend is not None:
        for w, x in enumerate(wk):
            if x[0] == "Idle":
                out.append((f"maestro spawns W{w+1} on {ISSUES[pend]}", (s, rq, nud, put(wk, w, ("Run", pend)), None, wake, hb, owe, rs)))
    if not out:  # tick has nothing left to do: end it and manage the heartbeat
        busy = any(x[0] != "Idle" for x in wk)
        front = any(s[i] == "Ready" and unblocked(s, i) for i in range(len(ISSUES)))
        waiting_on_people = any(v == "Help" for v in s) or any(s[i] != "Merged" and not unblocked(s, i) for i in range(len(ISSUES)))
        hb2 = "deleted" if all(v == "Merged" for v in s) else ("paused" if not busy and not front and pend is None and not waiting_on_people else hb)  # gap 2 fix
        out.append(("maestro ends tick" + ("" if hb2 == hb else f", heartbeat {hb2}"), (s, rq, nud, wk, pend, False, hb2, owe, rs)))
    yield from out


def workers(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs = st
    for w, x in enumerate(wk):
        if x[0] != "Run":
            continue
        i, n, I = x[1], f"W{w+1}", ISSUES[x[1]]
        fin = lambda r, s2=s: (s2, rq, nud, put(wk, w, ("Fin", i, r)), pend, True, hb, owe, rs)
        yield f"{n} merges {I}", fin("merged", put(s, i, "Merged"))
        yield f"{n} labels {I} needs-help", fin("help", put(s, i, "ClaimedHelp"))
        yield f"{n} quits early on {I}", fin("quit")
        yield f"{n} dies on {I}", fin("died")


def heartbeat(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs = st
    if hb == "on" and not wake:
        yield "heartbeat fires", (s, rq, nud, wk, pend, True, hb, owe, rs)
    if rs < cfg.restart:  # maestro thread restarts: forgets pending claim and unreaped finished workers
        wk2 = tuple(("Idle",) if x[0] == "Fin" else x for x in wk)
        yield "maestro restarts, loses memory", (s, rq, (0,) * len(ISSUES), wk2, None, True, "deleted" if all(v == "Merged" for v in s) else "on", owe, rs + 1)


def master(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs = st
    for i, I in enumerate(ISSUES):
        if s[i] == "Help":
            o = not cfg.master_skips_nudge
            yield f"master finishes {I} by hand", (put(s, i, "Merged"), rq, nud, wk, pend, wake, hb, o, rs)
            yield f"master removes needs-help on {I}", (put(s, i, "Ready"), rq, nud, wk, pend, wake, hb, o, rs)
    hb2 = "on" if hb == "paused" else hb
    if owe:
        yield "master nudges maestro", (s, rq, nud, wk, pend, True, hb2, False, rs)


def spontaneous_nudge(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs = st
    if not owe:
        yield "someone nudges maestro", (s, rq, nud, wk, pend, True, "on" if hb == "paused" else hb, owe, rs)


def successors(st, cfg):
    """yields (label, next, kind). kind 'auto' = maestro, workers, heartbeat, an owed nudge. 'human' = a decision or a poke nobody was told to make."""
    for lab, nx in maestro(st, cfg):
        yield lab, nx, "auto"
    for lab, nx in workers(st, cfg):
        yield lab, nx, "auto"
    for lab, nx in heartbeat(st, cfg):
        yield lab, nx, "auto"
    for lab, nx in master(st, cfg):
        yield lab, nx, "auto" if lab == "master nudges maestro" else "human"
    for lab, nx in spontaneous_nudge(st, cfg):
        yield lab, nx, "human"


# --- rules ---
def one_worker_per_issue(st):
    return all(holds(st[3], i) <= 1 for i in range(len(ISSUES)))


def never_claim_blocked(st):
    s = st[0]
    return all(unblocked(s, i) for i in range(len(ISSUES)) if s[i] in ("Claimed", "ClaimedHelp", "Merged"))


def good(st):
    """nothing left for automation: each issue is merged, awaiting a human decision, or blocked behind one."""
    s = st[0]

    def waiting(i, seen=()):
        if s[i] in ("Merged", "Help"):
            return True
        return any(waiting(ISSUES.index(d)) for d in DEPS[ISSUES[i]] if s[ISSUES.index(d)] != "Merged")

    return all(waiting(i) for i in range(len(ISSUES)))


def merged(i):
    return lambda st: st[0][i] == "Merged"


# --- human-readable names, for the diagram ---
def issue_phase(st, i):
    s, wk, pend = st[0], st[3], st[4]
    if s[i] == "Ready":
        return "ready-for-agent" if unblocked(s, i) else "blocked"
    if s[i] == "Claimed":
        if pend == i:
            return "claimed, worker not started"
        for x in wk:
            if x[0] == "Run" and x[1] == i:
                return "worker running"
            if x[0] == "Fin" and x[1] == i:
                return "worker ended, maestro not yet looked"
        return "in-progress but nobody owns it"
    return {"ClaimedHelp": "needs-help raised, worker ending, maestro not yet looked", "Help": "needs-help, master decides", "Merged": "merged"}[s[i]]
