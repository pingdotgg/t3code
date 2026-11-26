"""Maestro model 1, plain Python. Successor function only; no checker library.
State is a tuple so it hashes. Toggles live in CFG so the same file makes the faithful and the injected-bug variants."""
from dataclasses import dataclass

ISSUES = ["A", "B"]  # a third free issue multiplies the graph past what fits in memory once review and stalls exist
DEPS = {"A": [], "B": ["A"]}  # B is blocked by A
W = 2  # worker slots (N)
NUDGE_MAX = 1  # real skill: 3; reduced to keep the graph small
RETRIES = 2  # fresh workers after the first attempt fails, before needs-help


@dataclass(frozen=True)
class Cfg:
    recheck: bool = True  # maestro re-checks labels right before claiming
    restart: int = 0  # how many times the maestro thread may lose its memory
    master_skips_nudge: bool = False  # master decides in the GitHub UI and never nudges


# state = (s, rq, nud, wk, pend, wake, hb, owe, restarts, pr)
# s[i]  in Ready | Review | Claimed | ClaimedHelp | Help | Merged   (labels on the issue)
# pr[i] the builder opened the PR and labelled ready-for-review, so the next claim is a review
# wk[w] in ("Idle",) | ("Run", i) | ("Fin", i, result)
# hb    in on | paused | deleted
def init():
    n = len(ISSUES)
    return (("Ready",) * n, (0,) * n, (0,) * n, (("Idle",),) * W, None, True, "on", False, 0, (False,) * n)


def holds(wk, i):
    return sum(1 for x in wk if x[0] != "Idle" and x[1] == i)


def unblocked(s, i):
    return all(s[ISSUES.index(d)] == "Merged" for d in DEPS[ISSUES[i]])


def put(t, k, v):
    return t[:k] + (v,) + t[k + 1 :]


def open_(pr, i):
    return "Review" if pr[i] else "Ready"


def requeue(s, rq, pr, i):  # rq[i] counts failed attempts: died, gave up, stalled and stopped, out of nudges
    return (put(s, i, "Help"), rq) if rq[i] >= RETRIES else (put(s, i, open_(pr, i)), put(rq, i, rq[i] + 1))


def settled(v):  # the worker's part is over: merged, or handed to review
    return v in ("Merged", "Review")


def maestro(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs, pr = st
    if not wake:
        return
    out = []
    for w, x in enumerate(wk):
        if x[0] != "Fin":
            continue
        _, i, r = x
        n, I = f"W{w+1}", ISSUES[i]
        if settled(s[i]):
            out.append((f"maestro reaps {n}: {I} {s[i].lower()}", (s, rq, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs, pr)))
        elif s[i] == "ClaimedHelp":
            out.append((f"maestro reaps {n}: {I} needs-help, tells master", (put(s, i, "Help"), rq, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs, pr)))
        elif r == "quit" and nud[i] < NUDGE_MAX:
            out.append((f"maestro nudges {n}: {I} still open", (s, rq, put(nud, i, nud[i] + 1), put(wk, w, ("Run", i)), pend, wake, hb, owe, rs, pr)))
        else:  # died, gave up, stopped as stalled, or out of nudges
            s2, rq2 = requeue(s, rq, pr, i)
            lab = f"maestro retries {I} (worker {n} {'quit' if r == 'quit' else 'died'})" if rq[i] < RETRIES else f"maestro gives up on {I}: attempts used, needs-help"
            out.append((lab, (s2, rq2, nud, put(wk, w, ("Idle",)), pend, wake, hb, owe, rs, pr)))
    for i, I in enumerate(ISSUES):  # orphan needs-help after a restart: the skill's first tick reaps it (gap 1 fix)
        if s[i] == "ClaimedHelp" and holds(wk, i) == 0:
            out.append((f"maestro reaps orphan {I}: needs-help, tells master", (put(s, i, "Help"), rq, nud, wk, pend, wake, hb, owe, rs, pr)))
    for i, I in enumerate(ISSUES):  # orphan: in-progress, nobody holds it, not mid-claim
        if s[i] == "Claimed" and pend != i and holds(wk, i) == 0:
            s2, rq2 = requeue(s, rq, pr, i)
            out.append((f"maestro requeues orphan {I}", (s2, rq2, nud, wk, pend, wake, hb, owe, rs, pr)))
    for w, x in enumerate(wk):  # stuck detection: no push, comment or label change for too long; `t3 thread stop`, then retried
        if x[0] == "Run" and s[x[1]] == "Claimed":
            out.append((f"maestro stops W{w+1}, stalled on {ISSUES[x[1]]}", (s, rq, nud, put(wk, w, ("Fin", x[1], "died")), pend, wake, hb, owe, rs, pr)))
    if pend is None and any(x[0] == "Idle" for x in wk):
        for i, I in enumerate(ISSUES):
            ok = s[i] in ("Ready", "Review") if cfg.recheck else s[i] in ("Ready", "Review", "Claimed")  # stale search result may still list a claimed issue
            if ok and unblocked(s, i) and holds(wk, i) == 0:  # an issue whose last thread still runs is skipped
                what = "review of " if s[i] == "Review" else ""
                out.append((f"maestro claims {what}{I} (adds in-progress)", (put(s, i, "Claimed"), rq, nud, wk, i, wake, hb, owe, rs, pr)))
    if pend is not None:
        for w, x in enumerate(wk):
            if x[0] == "Idle":
                out.append((f"maestro spawns W{w+1} on {ISSUES[pend]}", (s, rq, nud, put(wk, w, ("Run", pend)), None, wake, hb, owe, rs, pr)))
    if not [o for o in out if ", stalled on " not in o[0]]:  # tick has nothing left to do: end it and manage the heartbeat
        busy = any(x[0] != "Idle" for x in wk)
        front = any(s[i] in ("Ready", "Review") and unblocked(s, i) for i in range(len(ISSUES)))
        waiting_on_people = any(v == "Help" for v in s) or any(s[i] != "Merged" and not unblocked(s, i) for i in range(len(ISSUES)))
        hb2 = "deleted" if all(v == "Merged" for v in s) else ("paused" if not busy and not front and pend is None and not waiting_on_people else hb)  # gap 2 fix
        out.append(("maestro ends tick" + ("" if hb2 == hb else f", heartbeat {hb2}"), (s, rq, nud, wk, pend, False, hb2, owe, rs, pr)))
    yield from out


def workers(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs, pr = st
    for w, x in enumerate(wk):
        if x[0] != "Run":
            continue
        i, n, I = x[1], f"W{w+1}", ISSUES[x[1]]

        def fin(r, v=None, pr2=pr):
            s2 = s if v is None else put(s, i, v)
            return (s2, rq, nud, put(wk, w, ("Fin", i, r)), pend, True, hb, owe, rs, pr2)

        if pr[i]:
            yield f"{n} reviews and merges {I}", fin("merged", "Merged")
        else:
            s2, w2 = put(s, i, "Review"), put(wk, w, ("Fin", i, "pr"))  # handoff starts the review phase's own retry budget
            yield f"{n} opens the PR, labels {I} ready-for-review", (s2, put(rq, i, 0), nud, w2, pend, True, hb, owe, rs, put(pr, i, True))
        yield f"{n} labels {I} needs-help", fin("help", "ClaimedHelp")
        yield f"{n} quits early on {I}", fin("quit")
        yield f"{n} dies or gives up on {I}", fin("died")


def heartbeat(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs, pr = st
    if hb == "on" and not wake:
        yield "heartbeat fires", (s, rq, nud, wk, pend, True, hb, owe, rs, pr)
    if rs < cfg.restart:  # maestro thread restarts: forgets pending claim and unreaped finished workers
        wk2 = tuple(("Idle",) if x[0] == "Fin" else x for x in wk)
        yield "maestro restarts, loses memory", (s, rq, (0,) * len(ISSUES), wk2, None, True, "deleted" if all(v == "Merged" for v in s) else "on", owe, rs + 1, pr)


def master(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs, pr = st
    for i, I in enumerate(ISSUES):
        if s[i] == "Help":
            o = not cfg.master_skips_nudge
            yield f"master finishes {I} by hand", (put(s, i, "Merged"), rq, nud, wk, pend, wake, hb, o, rs, pr)
            yield f"master removes needs-help on {I}", (put(s, i, open_(pr, i)), rq, nud, wk, pend, wake, hb, o, rs, pr)
    hb2 = "on" if hb == "paused" else hb
    if owe:
        yield "master nudges maestro", (s, rq, nud, wk, pend, True, hb2, False, rs, pr)


def spontaneous_nudge(st, cfg):
    s, rq, nud, wk, pend, wake, hb, owe, rs, pr = st
    if not owe:
        yield "someone nudges maestro", (s, rq, nud, wk, pend, True, "on" if hb == "paused" else hb, owe, rs, pr)


def successors(st, cfg):
    """yields (label, next, kind). kind 'auto' = maestro, workers, heartbeat, an owed nudge. 'human' = a decision or a poke nobody was told to make.
    A stall stop is 'human' too: an alarm the dispatcher may raise, never one it must."""
    for lab, nx in maestro(st, cfg):
        yield lab, nx, "human" if ", stalled on " in lab else "auto"
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
    return all(unblocked(s, i) for i in range(len(ISSUES)) if s[i] in ("Claimed", "ClaimedHelp", "Review", "Merged"))


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
    if s[i] == "Review":
        return "ready-for-review"
    if s[i] == "Claimed":
        if pend == i:
            return "claimed, worker not started"
        for x in wk:
            if x[0] == "Run" and x[1] == i:
                return "reviewer running" if st[9][i] else "builder running"
            if x[0] == "Fin" and x[1] == i:
                return "worker ended, maestro not yet looked"
        return "in-progress but nobody owns it"
    return {"ClaimedHelp": "needs-help raised, worker ending, maestro not yet looked", "Help": "needs-help, master decides", "Merged": "merged"}[s[i]]
