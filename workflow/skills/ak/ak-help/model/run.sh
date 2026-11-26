#!/bin/sh
# Rerun everything into a new folder: sh run.sh OUT_DIR   (one checker at a time, each under a 2 GB cap)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: sh run.sh OUT_DIR}
sc=$here/../../../pstack/factory/statechart/scripts/statechart
jar=${TLA2TOOLS:-$(mise where "http:tla2tools")/tla2tools.jar}
java=${JAVA:-$(mise which java --tool java@temurin-25)}
cap() { systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 -- "$@"; }
tlc() { cap "$java" -Xmx1200m -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 "$@"; }
mkdir -p "$out/work" && cp "$here/Pipeline.tla" "$here/Pipeline.cfg" "$here/Graph.cfg" "$out/work/"
rules=$(sed -n 's/^INVARIANTS //p' "$here/Pipeline.cfg")

: > "$out/rules.txt"
for r in $rules; do   # TLC stops at the first broken rule, so each rule gets its own run
  sed "s/^INVARIANTS.*/INVARIANTS $r/" "$here/Pipeline.cfg" > "$out/work/One.cfg"
  tlc -metadir "$out/work/meta" -config "$out/work/One.cfg" "$out/work/Pipeline.tla" > "$out/work/$r.out" 2>&1 || true
  v=PASS; grep -q "is violated" "$out/work/$r.out" && v=FAIL
  echo "$v $r ($(sed -n 's/^\([0-9]*\) states generated, \([0-9]*\) distinct.*/\2 distinct states/p' "$out/work/$r.out"))" | tee -a "$out/rules.txt"
done
cap "$sc" "$here/Pipeline.tla" --config "$here/Pipeline.cfg" --view "$here/view.mjs" --out "$out/paths" > /dev/null || [ $? -eq 1 ]    # exit 1 = a rule broke: the shortest paths are in report.md
cap "$sc" "$here/Pipeline.tla" --config "$here/Chart.cfg" --view "$here/view.mjs" --out "$out/chart" > /dev/null || [ $? -eq 1 ]
cap "$sc" "$here/Pipeline.tla" --config "$here/ExecChart.cfg" --view "$here/view.mjs" --out "$out/chart-exec" > /dev/null || [ $? -eq 1 ]
tlc -metadir "$out/work/meta2" -dump dot,actionlabels "$out/states.dot" -config "$out/work/Graph.cfg" "$out/work/Pipeline.tla" > "$out/work/graph.out" 2>&1
cap uv run --with networkx python "$here/check.py" "$out/states.dot" | tee "$out/graph-rules.txt"
