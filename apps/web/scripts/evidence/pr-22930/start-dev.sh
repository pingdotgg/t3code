#!/usr/bin/env bash
# usage: start-dev.sh before|after  -> prints PID (session leader), log at logs/dev-<b>.log
b=$1; EV=/tmp/ev-22930
[ $b = after ] && wt=$HOME/wt/pr-22930 || wt=$EV/before
export PATH="$EV/fixture/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/vite-plus/bin:$PATH"
export XDG_DATA_HOME=$EV/fixture/xdg
cd $wt
setsid vp run dev --home-dir $EV/home-$b > $EV/logs/dev-$b.log 2>&1 < /dev/null &
echo $! > $EV/logs/dev-$b.pid; cat $EV/logs/dev-$b.pid
