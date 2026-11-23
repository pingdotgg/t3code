/**
 * Run after `systemctl --user daemon-reload`. The user manager's -.slice shares the cgroup of
 * user@<uid>.service and reports it to systemd-oomd as `auto` on reload, which drops the system
 * manager's `kill` watch (systemd/systemd#43174). Mirroring that policy onto -.slice restores the
 * watch and keeps it through later reloads. Best effort: exits 0 when there is nothing to mirror.
 */
export const RESTORE_OOMD_WATCH_SCRIPT = [
  "unit=$(systemctl --user show --property=ControlGroup --value -- -.slice) || exit 0",
  "unit=${unit##*/}",
  "case $unit in user@*.service) ;; *) exit 0 ;; esac",
  'show() { systemctl show --property="$1" --value "$unit"; }',
  '[ "$(show ManagedOOMMemoryPressure)" = kill ] || exit 0',
  "limit=$(show ManagedOOMMemoryPressureLimit)",
  "case $limit in '' | *[!0-9]*) exit 0 ;; esac",
  // The limit is a fraction of 2^32; set-property takes a percentage.
  "p=$(( (limit * 10000 + 2147483648) / 4294967296 ))",
  'set -- ManagedOOMMemoryPressure=kill "ManagedOOMMemoryPressureLimit=$((p / 100)).$(printf %02d $((p % 100)))%"',
  "duration=$(show ManagedOOMMemoryPressureDurationUSec)",
  'case $duration in "" | infinity) ;; *) set -- "$@" "ManagedOOMMemoryPressureDurationSec=$duration" ;; esac',
  'exec systemctl --user set-property --runtime -- -.slice "$@"',
  "",
].join("\n");
