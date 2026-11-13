//! `server.getHostResources`, `server.getProcessDiagnostics` and `server.signalProcess`: the
//! machine's memory and CPUs, the server's process tree (provider CLIs, their tools), and
//! SIGINT/SIGKILL for one of those descendants. Reads `ps` and `/proc/meminfo` rather than a
//! system-information crate; both exist on every Linux and macOS host the server runs on.

use std::process::Command;

use serde_json::{Value, json};

use crate::auth::{iso8601, now_ms};

/// `HostResourcesSnapshot`. `cpuUtilization` is left null: it needs two samples over time.
pub fn host_resources() -> Value {
    let cpu_count = std::thread::available_parallelism().map_or(1, |n| n.get());
    let (total, available) = memory().unwrap_or((0, 0));
    json!({
        "sampledAt": now_ms(),
        "cpuUtilization": null,
        "cpuCount": cpu_count,
        "availableMemoryBytes": available,
        "totalMemoryBytes": total,
    })
}

/// Total and available memory in bytes.
fn memory() -> Option<(u64, u64)> {
    if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
        let field = |name: &str| -> Option<u64> {
            let line = text.lines().find(|l| l.starts_with(name))?;
            Some(line.split_whitespace().nth(1)?.parse::<u64>().ok()? * 1024)
        };
        return Some((field("MemTotal:")?, field("MemAvailable:")?));
    }
    // macOS: total from sysctl, available as free plus inactive pages from vm_stat.
    let total: u64 = run("sysctl", &["-n", "hw.memsize"])?.trim().parse().ok()?;
    let vm = run("vm_stat", &[])?;
    let page: u64 = vm
        .lines()
        .next()?
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let pages = |name: &str| -> u64 {
        vm.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
            .unwrap_or(0)
    };
    Some((
        total,
        (pages("Pages free") + pages("Pages inactive")) * page,
    ))
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Clone, Debug, PartialEq)]
struct Row {
    pid: i64,
    ppid: i64,
    pgid: i64,
    status: String,
    cpu: f64,
    rss_bytes: i64,
    elapsed: String,
    command: String,
}

/// One `ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=` line.
fn parse_row(line: &str) -> Option<Row> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let ppid = fields.next()?.parse().ok()?;
    let pgid = fields.next()?.parse().ok()?;
    let status = fields.next()?.to_owned();
    let cpu = fields.next()?.parse().ok()?;
    let rss_kib: i64 = fields.next()?.parse().ok()?;
    let elapsed = fields.next()?.to_owned();
    let command = fields.collect::<Vec<_>>().join(" ");
    Some(Row {
        pid,
        ppid,
        pgid,
        status,
        cpu,
        rss_bytes: rss_kib * 1024,
        elapsed,
        command,
    })
}

/// `[[dd-]hh:]mm:ss` in seconds.
fn elapsed_seconds(text: &str) -> Option<i64> {
    let (days, rest) = match text.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().ok()?, rest),
        None => (0, text),
    };
    let parts: Vec<i64> = rest
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    let seconds = parts.iter().fold(0, |acc, p| acc * 60 + p);
    Some(days * 86_400 + seconds)
}

/// Start time from the elapsed time, to the second. Two reads may differ by one second.
fn start_time_ms(row: &Row, now: u64) -> i64 {
    let elapsed = elapsed_seconds(&row.elapsed).unwrap_or(0);
    ((now / 1000) as i64 - elapsed) * 1000
}

/// The server and its descendants, parents before children, with depth from the server.
fn tree(rows: &[Row], root: i64) -> Vec<(Row, i64, Vec<i64>)> {
    let mut out = Vec::new();
    let mut stack = vec![(root, 0)];
    while let Some((pid, depth)) = stack.pop() {
        let Some(row) = rows.iter().find(|r| r.pid == pid) else {
            continue;
        };
        let children: Vec<i64> = rows
            .iter()
            .filter(|r| r.ppid == pid)
            .map(|r| r.pid)
            .collect();
        for child in children.iter().rev() {
            stack.push((*child, depth + 1));
        }
        out.push((row.clone(), depth, children));
    }
    out
}

fn read_rows() -> Result<Vec<Row>, String> {
    let text = run(
        "ps",
        &["-axo", "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command="],
    )
    .ok_or("could not run ps")?;
    Ok(text.lines().filter_map(parse_row).collect())
}

/// `ServerProcessDiagnosticsResult`.
pub fn process_diagnostics() -> Value {
    let server_pid = i64::from(std::process::id());
    let now = now_ms();
    let (processes, error) = match read_rows() {
        Ok(rows) => (tree(&rows, server_pid), json!({ "_tag": "None" })),
        Err(message) => (
            Vec::new(),
            json!({ "_tag": "Some", "value": { "message": message } }),
        ),
    };
    let entries: Vec<Value> = processes
        .iter()
        .map(|(row, depth, children)| {
            json!({
                "pid": row.pid,
                "startTimeMs": start_time_ms(row, now),
                "ppid": row.ppid,
                "pgid": row.pgid,
                "status": row.status,
                "cpuPercent": row.cpu,
                "rssBytes": row.rss_bytes,
                "elapsed": row.elapsed,
                "command": row.command,
                "depth": depth,
                "childPids": children,
            })
        })
        .collect();
    json!({
        "serverPid": server_pid,
        "readAt": iso8601(now),
        "processCount": entries.len(),
        "totalRssBytes": processes.iter().map(|(r, _, _)| r.rss_bytes).sum::<i64>(),
        "totalCpuPercent": processes.iter().map(|(r, _, _)| r.cpu).sum::<f64>(),
        "processes": entries,
        "error": error,
    })
}

/// `server.signalProcess`: only a live descendant of this server whose start time matches.
pub fn signal_process(pid: i64, started_at_ms: i64, signal: &str) -> Value {
    let refuse = |message: String| json!({ "pid": pid, "signal": signal, "signaled": false, "message": { "_tag": "Some", "value": message } });
    let server_pid = i64::from(std::process::id());
    if pid == server_pid {
        return refuse("Refusing to signal the Conn Server process.".into());
    }
    let rows = match read_rows() {
        Ok(rows) => rows,
        Err(_) => {
            return refuse(format!(
                "Could not refresh process {pid}; refusing to signal a stale identity."
            ));
        }
    };
    let now = now_ms();
    let known = tree(&rows, server_pid).into_iter().any(|(row, depth, _)| {
        depth > 0 && row.pid == pid && same_start(start_time_ms(&row, now), started_at_ms)
    });
    if !known {
        return refuse(format!(
            "Process {pid} is not a signalable Conn Server descendant."
        ));
    }
    let signal_number = if signal == "SIGKILL" {
        rustix::process::Signal::KILL
    } else {
        rustix::process::Signal::INT
    };
    let target = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw);
    match target.map(|pid| rustix::process::kill_process(pid, signal_number)) {
        Some(Ok(())) => {
            json!({ "pid": pid, "signal": signal, "signaled": true, "message": { "_tag": "None" } })
        }
        _ => refuse("Failed to signal process.".into()),
    }
}

/// Whether two start times name the same process: within two seconds of each other.
fn same_start(a: i64, b: i64) -> bool {
    a.abs_diff(b) <= 2000
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A caller sends `startTimeMs`; no value may overflow the comparison.
    #[test]
    fn start_times_compare_without_overflow() {
        assert!(same_start(10_000, 8_000));
        assert!(!same_start(10_000, 7_999));
        assert!(!same_start(1_000, i64::MIN));
        assert!(!same_start(i64::MAX, -1));
    }

    #[test]
    fn reads_ps_lines_and_elapsed_times() {
        let row =
            parse_row("  412   1  412 Ss    0.5  2048   01-02:03:04 /usr/bin/claude --print x")
                .unwrap();
        assert_eq!(row.pid, 412);
        assert_eq!(row.rss_bytes, 2048 * 1024);
        assert_eq!(row.command, "/usr/bin/claude --print x");
        assert_eq!(elapsed_seconds("01-02:03:04"), Some(93_784));
        assert_eq!(elapsed_seconds("03:04"), Some(184));
        assert_eq!(elapsed_seconds("x"), None);
    }

    #[test]
    fn the_tree_holds_only_descendants() {
        let row = |pid, ppid| Row {
            pid,
            ppid,
            pgid: pid,
            status: "S".into(),
            cpu: 0.0,
            rss_bytes: 0,
            elapsed: "00:01".into(),
            command: String::new(),
        };
        let rows = vec![
            row(1, 0),
            row(10, 1),
            row(11, 10),
            row(12, 10),
            row(13, 11),
            row(20, 1),
        ];
        let found: Vec<(i64, i64)> = tree(&rows, 10)
            .iter()
            .map(|(r, d, _)| (r.pid, *d))
            .collect();
        assert_eq!(found, vec![(10, 0), (11, 1), (13, 2), (12, 1)]);
    }

    #[test]
    fn reads_this_machine() {
        let host = host_resources();
        assert!(host["cpuCount"].as_u64().unwrap() >= 1);
        assert!(host["totalMemoryBytes"].as_u64().unwrap() > 0);
        let diagnostics = process_diagnostics();
        assert_eq!(
            diagnostics["processes"][0]["pid"],
            i64::from(std::process::id())
        );
        let refused = signal_process(i64::from(std::process::id()), 0, "SIGINT");
        assert_eq!(refused["signaled"], false);
        assert_eq!(signal_process(1, 0, "SIGKILL")["signaled"], false);
    }
}
