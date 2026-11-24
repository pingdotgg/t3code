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
               CONN_GPUI_ORBIT_SYNC="0", CONN_GPUI_AUTOMATION=str(automation),
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
        automation.unlink(missing_ok=True)
        stack.enter_context(running([app], env, directory, "gpui.log"))
        until(lambda: automation.exists() and automation.read_text().strip(), "GPUI automation")
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

    with gui_lock():
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

        # Seed a long local prefix. Its oldest body deliberately cannot decode as a Message.
        # The server still has just two messages, as on a bounded warm reconciliation.
        with sqlite3.connect(database) as db:
            for rank in range(-998, 0):
                message_id = f"prior-{rank}"
                body = "invalid outside preview" if rank == -998 else json.dumps({"Assistant": {
                    "id": message_id, "markdown": f"Previously cached {rank}",
                    "created_at": None, "run_id": None}})
                db.execute("INSERT INTO messages(position,environment,thread,id,body) VALUES (?,?,?,?,?)",
                           (rank,url,child,message_id,body))
        assert count_messages() == 1000

        def prefix():
            with sqlite3.connect(database) as db:
                return db.execute("SELECT id,body FROM messages WHERE environment=? AND thread=? "
                                  "AND id LIKE 'prior-%' ORDER BY position", (url,child)).fetchall()

        before = prefix()
        with ExitStack() as warm:
            client = start_app(warm)
            client.call({"cmd": "select", "id": child})
            warm_open = client.call({"cmd": "dump"})
            assert warm_open["chatMetrics"]["totalEntries"] == 100
            preview = warm_open["timeline"]
            assert preview["entryCount"] == 100 and not preview["synchronized"]
            assert "Previously cached -98" in preview["entries"][0]
            # Change the live payload to observe the commit, rather than racing the background writer.
            warm_reply = "Warm server reply"
            with sqlite3.connect(state / "engine.sqlite") as db:
                db.execute("UPDATE entities SET body=json_set(body,'$.text',?) WHERE thread_id=? "
                           "AND id IN (?,?)", (warm_reply, child, f"msg-{child}-a1", f"ti-{child}-a1"))
            warm.enter_context(running(server, env, directory, "server.log"))
            until(lambda: saved_reply(warm_reply), "warm tail commit")
            assert count_messages() == 1000 and prefix() == before
            print("Warm open: rendered the newest 100 of 1000 with an undecodable oldest body. "
                  "After a two-message live refresh, all 998 older IDs and bodies remained in order.")

        def set_server_settlement(age_hours):
            at = None if age_hours is None else (
                datetime.now(timezone.utc) - timedelta(hours=age_hours)
            ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            override = "settled" if at else "active"
            with sqlite3.connect(state / "engine.sqlite") as db:
                db.execute("UPDATE threads SET shell=json_set(shell,'$.settledAt',?,'$.settledOverride',?), "
                           "thread=json_set(thread,'$.settledAt',?,'$.settledOverride',?) WHERE id=?",
                           (at,override,at,override,child))
            return at

        # Advance only the fixture server's settlement timestamp. GPUI must receive it over the wire.
        for hours in (23, 25):
            at = set_server_settlement(hours)
            with ExitStack() as settled:
                settled.enter_context(running(server, env, directory, "server.log"))
                client = start_app(settled)
                until(lambda: any(t["id"] == child and t["settledAt"] == at
                                  for t in json.loads((cache / "shell").read_text())["threads"]),
                      "live settlement reaches cached shell")
                if hours == 23:
                    assert count_messages() == 1000
                else:
                    until(lambda: count_messages() == 0, "expired child rows deleted")
                with sqlite3.connect(database) as db:
                    assert bool(db.execute("SELECT 1 FROM thread_outlines WHERE thread=?",
                                           (child,)).fetchone()) == (hours == 23)
                assert client.call({"cmd": "dump"})["selected"] != child

        set_server_settlement(None)
        with ExitStack() as active:
            active.enter_context(running(server, env, directory, "server.log"))
            client = start_app(active)
            until(lambda: saved_reply(warm_reply) and count_messages() == 2, "unsettled child refetch")
            assert client.call({"cmd": "dump"})["selected"] != child
            print("Retention: a server-reported settlement kept 1000 SQLite rows at 23 hours, "
                  "removed all 1000 at 25 hours, then refetched 2 when unsettled.")


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
    assert not database.exists()
    with gui_lock():
        with ExitStack() as fresh:
            fresh.enter_context(running(server, env, directory, "server.log"))
            client = start_app(fresh)
            until(lambda: len(markers()) == 701, "background whole-thread outline")
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
        # Model a device that accumulated the latest 1000 bodies before going offline.
        with sqlite3.connect(database) as db:
            db.execute("DELETE FROM messages WHERE environment=? AND thread=?", (url,child))
            for n in range(201, 702):
                for role in ("u","a"):
                    if (n,role) in ((201,"u"), (440,"a")):
                        continue
                    eid = f"ti-{child}-{role}{n}"
                    common = dict(id=eid, created_at=None, run_id=None)
                    message = ({"User":dict(common,text=f"Outline u {n}",created_by_agent=False,
                                            attachments=[],is_steer=False)} if role=="u" else
                               {"Assistant":dict(common,markdown=f"Outline a {n}")})
                    db.execute("INSERT INTO messages(environment,thread,id,body) VALUES (?,?,?,?)",
                               (url,child,eid,json.dumps(message)))
        with ExitStack() as offline:
            client = start_app(offline)
            client.call({"cmd":"select","id":child})
            assert metrics()["tocTurns"] == 701 and metrics()["totalEntries"] == 100
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("server", type=Path)
    parser.add_argument("--outline", action="store_true")
    args = parser.parse_args()
    directory = Path(tempfile.mkdtemp(prefix="conn-offline-proof-"))
    print(f"Proof directory: {directory}", flush=True)
    prove(args.app.resolve(), args.server.resolve(), directory, args.outline)
