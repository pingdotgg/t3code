#!/usr/bin/env bash
# run.sh <build> <row>
b=$1 r=$2; EV=/tmp/ev-22930; . $EV/drv/ids-$b.env
cp $EV/drv/state-$b.json $EV/drv/s-$b.json
BASE_URL=$BASE_URL ENV_ID=$ENV_ID THREAD_A=$THREAD_A THREAD_B=$THREAD_B STORAGE_STATE=$EV/drv/s-$b.json EV_DIR=$EV \
  timeout 400 node $(dirname "$0")/driver.mjs $r $EV/out/$b 2>&1 | cut -c1-600
