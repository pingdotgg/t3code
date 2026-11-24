#!/usr/bin/env python3
"""Prove first paint, unopened child messages and reconnect in a real GPUI window.

Pass the automation-enabled conn-app binary and the conn-server binary. Run on
nick-vm. All server, app and project data are created in a private temp directory.
"""
import argparse
from datetime import datetime, timedelta, timezone
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

from e2e import AutomationClient


def until(check, description):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}")


@contextmanager
def running(args, env, directory, log):
    with (directory / log).open("a") as output:
        proc = subprocess.Popen(args, cwd=directory, env=env, stdout=output, stderr=output)
        try:
            yield proc
        finally:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


@contextmanager
def gui_lock():
    lock = Path("/tmp/vm-gui.lock")
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            time.sleep(20)
    try:
        yield
    finally:
        lock.rmdir()


def seed(directory, env, server):
    stage = directory / "fixture"
    subprocess.run([sys.executable, Path(__file__).with_name("seed-parity.py"),
                    "--dev-dir", stage], check=True, env=env)
    engine = directory / "state" / "engine.sqlite"
    with running(server, env, directory, "server.log"):
        def ready():
            if not engine.exists():
                return False
            with sqlite3.connect(engine) as db:
                return db.execute("SELECT 1 FROM sqlite_master WHERE name='entities'").fetchone()
        until(ready, "server schema")
    # Use the running binary's schema. The seeder's empty receipts table differs between versions.
    with sqlite3.connect(engine) as db:
        db.execute("ATTACH ? AS seed", (str(stage / "userdata" / "engine.sqlite"),))
        for table in ("projects", "threads", "entities", "turn_item_positions", "meta"):
            columns = [c[1] for c in db.execute(f"PRAGMA seed.table_info({table})")]
            fields = ", ".join(columns)
            db.execute(f"INSERT OR REPLACE INTO main.{table} ({fields}) SELECT {fields} FROM seed.{table}")


def prove(app, server_bin, directory, outline=False):
    home = directory / "home"
    home.mkdir()
    config = directory / "config"
    automation = directory / "automation-port"
    token = directory / "bearer"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = str(sock.getsockname()[1])
    url = f"http://127.0.0.1:{port}/"
    env = dict(os.environ, HOME=str(home), CONN_GPUI_SERVER=url, CONN_GPUI_CONFIG_DIR=str(config),
               CONN_GPUI_ORBIT_SYNC="0", CONN_GPUI_PERF_LOG="1", CONN_GPUI_AUTOMATION=str(automation),
               CONN_GPUI_DISABLE_CONTROL_SOCKET="1", CONN_GPUI_TOKEN_FILE=str(token),
               CONN_MODEL_MANIFEST_URL="off")
    state = directory / "state"
    server = [server_bin, "serve", "--host", "127.0.0.1", "--port", port, "--state-dir",
              state, "--sdk-host", "/usr/bin/false", "--no-browser"]
    seed(directory, env, server)
    with token.open("wb") as out:
        subprocess.run([server_bin, "auth", "session", "issue", "--state-dir", state,
                        "--token-only"], env=env, stdout=out, check=True)

    def start_app(stack):
        stack.enter_context(gui_lock())
        automation.unlink(missing_ok=True)
        proc = stack.enter_context(running([app], env, directory, "gpui.log"))
        def listening():
            if proc.poll() is not None:
                raise RuntimeError(f"GPUI exited with {proc.returncode}. See {directory/'gpui.log'}")
            return automation.exists() and automation.read_text().strip()
        until(listening, "GPUI automation")
        client = AutomationClient(int(automation.read_text()))
        stack.callback(client.close)
        return client

    child = "thread-parity-sub-1"
    marker = "Inspect subagent card spacing tokens"
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    cache = config / "offline-v1" / digest(url)
    database = cache.parent / "messages.sqlite3"

    def count_messages(thread=child):
        with sqlite3.connect(database) as db:
            return db.execute("SELECT count(*) FROM messages WHERE environment=? AND thread=?",
                              (url,thread)).fetchone()[0]

    def saved_reply(text):
        if not (cache / "shell").exists():
            return False
        with sqlite3.connect(database) as db:
            return db.execute("SELECT 1 FROM messages WHERE environment=? AND thread=? AND instr(body,?)>0",
                              (url,child,text)).fetchone()

    if outline:
        prove_outline(directory, url, child, database, server, env, start_app)
        return

    with ExitStack() as online:
        online.enter_context(running(server, env, directory, "server.log"))
        client = start_app(online)
        until(lambda: saved_reply(marker), "background child and shell writes")
        first = client.call({"cmd": "dump"})
        assert first["selected"] != child
        until(lambda: count_messages(first["selected"]) > 0, "offline startup thread written")
        print(f"Online: {len(first['threads'])} threads, selected {first['selected']}, "
              f"{count_messages()} messages saved for unopened {child}.")

    with ExitStack() as offline:
        client = start_app(offline)
        startup = client.call({"cmd": "dump"})
        assert startup["threads"] == first["threads"]
        assert startup["timeline"]["entryCount"] > 0 and not startup["timeline"]["synchronized"]
        print(f"Offline startup: {startup['timeline']['entryCount']} cached messages, "
              f"{len(startup['threads'])} threads, status {startup['status']}.")
        client.call({"cmd": "select", "id": child})
        opened = client.call({"cmd": "dump"})
        assert opened["selected"] == child and marker in str(opened["timeline"]["entries"])
        assert not opened["timeline"]["synchronized"]
        assert opened["chatMetrics"]["totalEntries"] == 2
        client.call({"cmd": "screenshot", "path": str(directory / "offline-child.png")})
        print(f"Offline child: {opened['timeline']['entryCount']} messages, "
              f"chat metrics {opened['chatMetrics']}.")

        title = "Reconciled offline spike child"
        reply = "Fresh server reply"
        with sqlite3.connect(state / "engine.sqlite") as db:
            db.execute("UPDATE threads SET shell=json_set(shell,'$.title',?), "
                       "thread=json_set(thread,'$.title',?) WHERE id=?", (title, title, child))
            db.execute("UPDATE entities SET body=json_set(body,'$.text',?) WHERE thread_id=? "
                       "AND id IN (?,?)", (reply, child, f"msg-{child}-a1", f"ti-{child}-a1"))
        offline.enter_context(running(server, env, directory, "server.log"))
        def reconciled():
            data = client.call({"cmd": "dump"})
            return (data["selected"] == child and data["timeline"]["synchronized"]
                    and reply in str(data["timeline"]["entries"])
                    and data["timeline"]["entryCount"] == 2
                    and any(t["id"] == child and t["title"] == title for t in data["threads"]))
        until(reconciled, "live child and changed sidebar title")
        until(lambda: saved_reply(reply), "reconciled SQLite rows")
        print(f"Reconnected: selected {child}, synchronized, title '{title}', reply '{reply}'.")



def append_turns(engine, child, start, end):
    with sqlite3.connect(engine) as db:
        for n in range(start, end + 1):
            for offset, role in enumerate(("u", "a")):
                ordinal = 2 * n - 1 + offset
                for kind, prefix in (("messages", "msg"), ("turnItems", "ti")):
                    base = f"{prefix}-{child}-{role}"
                    body = json.loads(db.execute(
                        "SELECT body FROM entities WHERE thread_id=? AND kind=? AND id=?",
                        (child, kind, base + "1")).fetchone()[0])
                    eid = base + str(n)
                    body.update(id=eid, text=f"Outline {role} {n}")
                    if kind == "turnItems":
                        body.update(ordinal=ordinal, messageId=f"msg-{child}-{role}{n}")
                        db.execute("INSERT INTO turn_item_positions VALUES (?,?,?)",
                                   (child, eid, ordinal))
                    db.execute("INSERT INTO entities(thread_id,kind,id,first_seq,seq,ordinal,body) "
                               "VALUES (?,?,?,1,1,?,?)",
                               (child, kind, eid, ordinal if kind == "turnItems" else None,
                                json.dumps(body)))


def prove_outline(directory, url, child, database, server, env, start_app):
    engine = directory / "state" / "engine.sqlite"
    def markers():
        if not database.exists():
            return []
        with sqlite3.connect(database) as db:
            row = db.execute("SELECT markers FROM thread_outlines WHERE environment=? AND thread=?",
                             (url, child)).fetchone()
            return json.loads(row[0]) if row else []

    def metrics():
        return client.call({"cmd": "dump"})["chatMetrics"]

    def click(turn):
        target = f"chat.toc.tick.{turn}"
        client.call({"cmd":"query", "axId":target})
        client.call({"cmd":"wait", "axId":target})
        sent = time.perf_counter()
        client.call({"cmd":"click", "axId":target})
        return sent

    def anchored(turn):
        expected = f"ti-{child}-u{turn}"
        data = metrics()
        return data["topPrompt"] == expected and data["anchorPrompt"] == expected and data["activeTocTurn"] == turn and not data["followingTail"]

    append_turns(engine, child, 2, 701)
    with sqlite3.connect(engine) as db:
        db.execute("UPDATE entities SET body=json_set(body,'$.type','command_execution',"
                   "'$.input','pwd','$.output','fixture','$.exitCode',0) WHERE thread_id=? AND id=?",
                   (child, f"ti-{child}-a440"))
        db.execute("DELETE FROM entities WHERE thread_id=? AND id=?", (child,f"msg-{child}-a440"))
    linked_dir = directory / "linked"
    linked_dir.mkdir()
    linked_server = list(server)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        linked_port = str(sock.getsockname()[1])
    linked_state = linked_dir / "state"
    linked_server[linked_server.index("--port") + 1] = linked_port
    linked_server[linked_server.index("--state-dir") + 1] = linked_state
    seed(linked_dir, env, linked_server)
    linked_child = child.replace("parity", "linked")
    with sqlite3.connect(linked_state / "engine.sqlite") as db:
        for table in ("projects","threads","entities","turn_item_positions"):
            for _,column,kind,*_ in db.execute(f"PRAGMA table_info({table})").fetchall():
                if kind.upper() == "TEXT":
                    db.execute(f"""UPDATE {table} SET "{column}"=replace(replace(replace("{column}",'thread-parity','thread-linked'),'thread-linked-main','thread-parity-main'),'proj-','linked-proj-')""")
        db.execute("UPDATE entities SET body=json_set(body,'$.text','Only on the linked server') WHERE thread_id='thread-parity-main' AND id IN ('msg-a1','ti-a1')")
    append_turns(linked_state / "engine.sqlite", linked_child, 2, 601)
    bearer = subprocess.check_output([server[0], "auth","session","issue","--state-dir",
                                      linked_state,"--token-only"], env=env, text=True).strip()
    config = Path(env["CONN_GPUI_CONFIG_DIR"])
    config.mkdir(exist_ok=True)
    (config/"orbit-sessions.json").write_text(json.dumps(dict(sessions={"proof-linked":dict(
        server_id="proof-linked", label="Linked fixture", url=f"http://127.0.0.1:{linked_port}",
        bearer=bearer, paired_at_unix=0)})))
    assert not database.exists()
    with ExitStack() as fresh:
        fresh.enter_context(running(server, env, directory, "server.log"))
        fresh.enter_context(running(linked_server, env, linked_dir, "server.log"))
        client = start_app(fresh)
        client.call({"cmd":"connect-saved-environment","id":"proof-linked"})
        until(lambda: len(markers()) == 701, "background whole-thread outline")
        expected = [f"ti-{child}-{role}{n}" for n in range(201,702) for role in ("u","a")
                    if (n,role) not in ((201,"u"),(440,"a"))]
        def cached_ids(owner, thread):
            with sqlite3.connect(database) as db:
                return [row[0] for row in db.execute(
                    "SELECT id FROM messages WHERE environment=? AND thread=? ORDER BY position",
                    (owner,thread))]
        until(lambda: cached_ids(url, child) == expected, "canonical newest 1000 for unopened child")
        linked_ids = [f"ti-{linked_child}-{role}{n}" for n in range(102,602) for role in ("u","a")]
        until(lambda: cached_ids("proof-linked", linked_child) == linked_ids, "1000 linked child IDs")
        assert not cached_ids(url, linked_child) and not cached_ids("proof-linked", child)
        listed = client.call({"cmd":"dump"})
        assert listed["selected"] not in (linked_child,child)
        assert {linked_child,child} <= {t["id"] for t in listed["threads"]}
        with sqlite3.connect(database) as db:
            duplicates = dict(db.execute("SELECT environment,body FROM messages WHERE thread='thread-parity-main' AND id='ti-a1'"))
            assert "Only on the linked server" in duplicates["proof-linked"]
            assert "Only on the linked server" not in duplicates[url]
        client.call({"cmd":"select","id":linked_child})
        until(lambda: client.call({"cmd":"dump"})["timeline"]["messageIds"] == linked_ids[-100:], "linked child opens its own latest 100")
        print("Same-ID parents kept distinct bodies. Opening the linked child displayed its own newest 100 IDs.",flush=True)
        print("Two real servers listed both unopened children with 1000 canonical rows each in their own environment.",flush=True)
        print("Verified all 1000 IDs in order from empty cache for unopened primary child.", flush=True)
        assert client.call({"cmd":"dump"})["selected"] != child
        with sqlite3.connect(database) as db:
            size = db.execute("SELECT length(CAST(markers AS BLOB)) FROM thread_outlines "
                              "WHERE environment=? AND thread=?", (url,child)).fetchone()[0]
            print(f"SQLite outline payload: {size} bytes for 701 markers.", flush=True)
        assert markers()[440]["entry_id"] == f"ti-{child}-u441"
        assert markers()[440]["assistant_preview"] == "Outline a 441"
        client.call({"cmd":"select", "id":child})
        click(1)
        until(lambda: anchored(1), "fresh device targeted window")
        print("Fresh device indexed 701 prompts for unopened child and jumped to turn 1.", flush=True)
    with ExitStack() as offline:
        client = start_app(offline)
        client.call({"cmd":"select","id":child})
        assert metrics()["tocTurns"] == 701 and metrics()["totalEntries"] == 100
        for _ in range(12):
            client.call({"cmd":"scroll","x":640,"y":350,"deltaY":20000})
            if metrics()["totalEntries"] > 100:
                break
        until(lambda: metrics()["totalEntries"] > 100, "offline wheel paging")
        paged = metrics()
        assert 98 <= paged["scrollTopItem"] <= 104, paged
        print(f"Offline scroll loaded {paged['totalEntries']} rows, anchored at virtual row {paged['scrollTopItem']} after prepending 100.", flush=True)
        sent = click(441)
        until(lambda: anchored(441), "exact offline jump 520 messages back")
        elapsed_ms = (time.perf_counter() - sent) * 1000
        print(f"Offline tick 441 click to observed exact anchor: {elapsed_ms:.1f} ms (one automation sample).", flush=True)
        client.call({"cmd":"screenshot","path":str(directory/"offline-anchor.png")})
        client.call({"cmd":"click","axId":"chat.toc.prev"})
        until(lambda: anchored(440), "previous canonical prompt beside dropped tool")
        client.call({"cmd":"click","axId":"chat.toc.next"})
        until(lambda: anchored(441), "next canonical prompt beside dropped tool")
        print("Previous and Next preserved canonical turns 440 and 441 across an omitted tool.", flush=True)
        click(1)
        until(lambda: metrics()["jumpError"] == "Connect to load this message", "offline miss")
        assert anchored(441)
        append_turns(engine, child, 702,702)
        offline.enter_context(running(server, env, directory, "server.log"))
        until(lambda: metrics()["tocTurns"] == 702, "reconnected outline with new tail")
        assert metrics()["jumpError"] is None, "offline notice survived reconnect"
        assert anchored(441)
        print("Reconnect cleared the offline notice before the next click; turn 441 stayed at the top.", flush=True)
        client.call({"cmd":"screenshot","path":str(directory/"reconnected-anchor.png")})
        click(1)
        until(lambda: anchored(1), "beyond-cap server window")
        client.call({"cmd":"screenshot","path":str(directory/"server-window.png")})
        client.call({"cmd":"click","axId":"chat.scroll-to-bottom"})
        until(lambda: metrics()["followingTail"] and metrics()["anchorPrompt"] is None,
              "return to latest")
        assert metrics()["activeTocTurn"] == 702
        client.call({"cmd":"screenshot","path":str(directory/"new-tail.png")})
        print("Offline SQLite jump to turn 441, offline miss, anchored reconnect, "
              "online turn 1 and return to new tail 702 passed.", flush=True)

        def scroll_past_cache():
            client.call({"cmd":"scroll","x":640,"y":350,"deltaY":50000})
            return metrics()["totalEntries"] > 1000
        until(scroll_past_cache, "online scrolling beyond SQLite history")
        print("Online wheel paging crossed the 1000 cached bodies.",flush=True)

    # One oversized tool closes the byte-bounded projection just before the newest conversation rows.
    def budget_fence(turn):
        with sqlite3.connect(engine) as db:
            db.execute("UPDATE entities SET body=json_set(body,'$.type','command_execution','$.output',?,"
                       "'$.input','fixture','$.exitCode',0) WHERE thread_id=? AND id=?",
                       ("z"*1100000,child,f"ti-{child}-a{turn}"))
            db.execute("DELETE FROM entities WHERE thread_id=? AND id=?", (child,f"msg-{child}-a{turn}"))
    budget_fence(701)
    def warm_phase(title, last_role="a"):
        with ExitStack() as phase:
            phase.enter_context(running(server,env,directory,"server.log"))
            current = start_app(phase)
            current.call({"cmd":"select","id":child})
            def visible():
                data = current.call({"cmd":"dump"})
                return data["timeline"]["synchronized"] and data["chatMetrics"]["totalEntries"] >= 100
            until(visible,title)
            until(lambda: cached_ids(url,child)[-1:] == [f"ti-{child}-{last_role}702"], "new canonical tail persisted")
            until(lambda: current.call({"cmd":"dump"})["timeline"]["messageIds"] == cached_ids(url,child)[-100:], "exact latest 100 visible IDs")
            until(lambda: len(cached_ids(url,child)) == 1000, "full cache after budget fence")
            return current.call({"cmd":"dump"})["timeline"]
    warm_phase("tiny snapshot restores newest 100")
    def fetches():
        return (directory/"gpui.log").read_text().count(f"offline.backfill thread={child} ")
    assert f"offline.snapshot thread={child} messages=2 bounded=true" in (directory/"gpui.log").read_text()
    previous = fetches()
    warm_phase("unchanged warm restart")
    assert fetches() == previous, "unchanged restart fetched the prefix again"
    print("Warm tiny bounded snapshot retained 100 visible bodies; unchanged restart skipped backfill.",flush=True)

    budget_fence(702)
    warm_phase("tool-only snapshot restores conversation","u")
    assert f"offline.snapshot thread={child} messages=0 bounded=true" in (directory/"gpui.log").read_text()
    assert cached_ids(url,child)[-1] == f"ti-{child}-u702"
    print("A zero-message bounded snapshot backfilled and displayed the preceding conversation.",flush=True)

    def settlement(hours):
        at = (datetime.now(timezone.utc)-timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.000Z") if hours else None
        override = "settled" if at else "active"
        with sqlite3.connect(engine) as db:
            db.execute("UPDATE threads SET shell=json_set(shell,'$.settledAt',?,'$.settledOverride',?), "
                       "thread=json_set(thread,'$.settledAt',?,'$.settledOverride',?) WHERE id=?",
                       (at,override,at,override,child))
        return at

    for hours in (23,25,None):
        at = settlement(hours)
        with ExitStack() as phase:
            phase.enter_context(running(server,env,directory,"server.log"))
            client = start_app(phase)
            shell = database.parent / hashlib.sha256(url.encode()).hexdigest() / "shell"
            until(lambda: any(t["id"] == child and t["settledAt"] == at for t in json.loads(shell.read_text())["threads"]), "settlement written")
            until(lambda: len(cached_ids(url,child)) == (0 if hours==25 else 1000), "retained message count")
            until(lambda: len(markers()) == (0 if hours==25 else 702), "retained outline")
            assert client.call({"cmd":"dump"})["selected"] != child
            assert len(cached_ids("proof-linked",linked_child)) == 1000
    print("23h retention, 25h expiry and unopened refetch to 1000 passed; linked cache stayed intact.",flush=True)

    at = settlement(24 - 12 / 3600)
    deadline = datetime.fromisoformat(at.replace("Z","+00:00")).timestamp() + 24*3600
    with ExitStack() as phase:
        phase.enter_context(running(server,env,directory,"server.log"))
        start_app(phase)
        until(lambda: any(t["id"] == child and t["settledAt"] == at for t in json.loads(shell.read_text())["threads"]), "near-expiry settlement")
        until(lambda: (database.parent/"settlement-deadlines").exists() and
              any(key == [url,child] for key,_ in json.loads((database.parent/"settlement-deadlines").read_text())),
              "observed deadline persisted")
    with sqlite3.connect(engine) as db:
        saved_thread = db.execute("SELECT * FROM threads WHERE id=?",(child,)).fetchone()
        db.execute("DELETE FROM threads WHERE id=?",(child,))
    with ExitStack() as phase:
        phase.enter_context(running(server,env,directory,"server.log"))
        start_app(phase)
        until(lambda: all(t["id"] != child for t in json.loads(shell.read_text())["threads"]), "thread left shell")
        assert len(cached_ids(url,child)) == 1000
    time.sleep(max(0,deadline-time.time())+0.1)
    with ExitStack() as phase:
        start_app(phase)
        until(lambda: not cached_ids(url,child), "offline expiry of omitted settled thread")
    with sqlite3.connect(engine) as db:
        db.execute(f"INSERT INTO threads VALUES ({','.join('?' for _ in saved_thread)})",saved_thread)
    settlement(None)
    with ExitStack() as phase:
        phase.enter_context(running(server,env,directory,"server.log"))
        start_app(phase)
        until(lambda: len(cached_ids(url,child)) == 1000, "refetch after omission")
    print("The settled child left the shell before its deadline. Offline restart expired its cache, and its return refetched 1000.",flush=True)

    with sqlite3.connect(engine) as db:
        db.execute("DELETE FROM entities WHERE thread_id=? AND kind IN ('messages','turnItems') AND id NOT IN (?,?,?,?)",
                   (child,*[f"{prefix}-{child}-{role}1" for prefix in ("ti","msg") for role in ("u","a")]))
        db.execute("DELETE FROM turn_item_positions WHERE thread_id=? AND item_id NOT IN (?,?)",
                   (child,f"ti-{child}-u1",f"ti-{child}-a1"))
    with ExitStack() as phase:
        phase.enter_context(running(server,env,directory,"server.log"))
        client = start_app(phase)
        until(lambda: cached_ids(url,child) == [f"ti-{child}-u1",f"ti-{child}-a1"], "authoritative rollback tail")
    print("A rolled-back server snapshot removed the obsolete cached tail.",flush=True)

    with sqlite3.connect(engine) as db:
        db.execute("DELETE FROM entities WHERE thread_id=? AND kind IN ('messages','turnItems')",(child,))
        db.execute("DELETE FROM turn_item_positions WHERE thread_id=?",(child,))
    with ExitStack() as phase:
        phase.enter_context(running(server,env,directory,"server.log"))
        client = start_app(phase)
        until(lambda: not cached_ids(url,child), "rollback to an empty conversation")
        assert len(cached_ids("proof-linked", linked_child)) == 1000
    print("An authoritative empty snapshot cleared the primary conversation and kept the linked cache.",flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("server", type=Path)
    parser.add_argument("--outline", action="store_true")
    args = parser.parse_args()
    directory = Path(tempfile.mkdtemp(prefix="gpui-offline-release-", dir="/tmp"))
    print(f"Proof directory: {directory}", flush=True)
    prove(args.app.resolve(), args.server.resolve(), directory, args.outline)
