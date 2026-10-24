#!/usr/bin/env python3
"""Seed the stopped worktree's review-guide capture fixture."""
import argparse
import json
from pathlib import Path
import socket
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("state", choices=("null", "zero", "one", "three"))
parser.add_argument("--bootstrap", action="store_true")
parser.add_argument("--server-port", type=int, default=15360)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
home = root / ".t3" / "userdata"
with socket.socket() as probe:
    if probe.connect_ex(("127.0.0.1", args.server_port)) == 0:
        parser.error("Stop the task server before seeding its database")
data = json.loads(Path(__file__).with_name("data.json").read_text())
db = home / "statev2.sqlite"
if not db.is_file():
    parser.error("Start and stop the isolated app once to initialize its schema")
with sqlite3.connect(db) as connection:
    if args.bootstrap:
        for table, row in (("projection_projects", data["project"]),
                           ("orchestration_v2_projection_threads", data["thread"])):
            row = dict(row)
            if table == "projection_projects":
                row["workspace_root"] = str(root)
            columns = ",".join(row)
            placeholders = ",".join("?" for _ in row)
            connection.execute(f"INSERT OR REPLACE INTO {table} ({columns}) VALUES ({placeholders})", tuple(row.values()))
    ref = data["reference"]
    key = (ref["host"], ref["repository"], ref["number"])
    connection.execute("DELETE FROM pull_request_review_guides WHERE host=? AND repository=? AND number=?", key)
    if args.state != "null":
        guide = dict(data["guide"])
        count = {"zero": 0, "one": 1, "three": 3}[args.state]
        guide["stops"] = guide["stops"][:count]
        connection.execute("INSERT INTO pull_request_review_guides VALUES (?,?,?,?)", (*key, json.dumps(guide)))
settings_file = home / "settings.json"
settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
settings["reviewGuidesEnabled"] = True
settings_file.write_text(json.dumps(settings, indent=2) + "\n")
print(f"Seeded {args.state} guide in {db}")
