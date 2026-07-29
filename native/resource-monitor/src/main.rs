use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

const PROTOCOL_VERSION: u32 = 2;
const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;
const PROCESS_START_TIME_PRECISION_MS: u64 = 1_000;
const HISTORY_RETENTION_MS: u64 = 60 * 60_000;
const MAX_HISTORY_SNAPSHOTS: usize = 3_600;
const INPUT_QUEUE_CAPACITY: usize = 64;
const MAX_HISTORY_RETAINED_ENTRIES: usize = 20_000;
const MAX_HISTORY_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROCESS_NAME_BYTES: usize = 1_024;
const MAX_PROCESS_COMMAND_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_STATUS_BYTES: usize = 256;
const HISTORY_CHUNK_SNAPSHOTS: usize = 32;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProcess {
    pid: u32,
    #[serde(default)]
    start_time_ms: Option<u64>,
}

impl ExternalProcess {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        #[serde(default)]
        external_processes: Vec<ExternalProcess>,
    },
    SetExternalProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    SetStreaming {
        version: u32,
        enabled: bool,
    },
    SampleNow {
        version: u32,
        request_id: String,
    },
    ReadHistory {
        version: u32,
        request_id: String,
        window_ms: u64,
    },
    Shutdown {
        version: u32,
    },
}

impl Command {
    fn version(&self) -> u32 {
        match self {
            Self::Configure { version, .. }
            | Self::SetExternalProcesses { version, .. }
            | Self::SetSampleInterval { version, .. }
            | Self::SetStreaming { version, .. }
            | Self::SampleNow { version, .. }
            | Self::ReadHistory { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }
}

enum Input {
    Command(Command),
    Invalid(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    cumulative_cpu_time: bool,
    current_cpu_percent: bool,
    resident_memory: bool,
    virtual_memory: bool,
    io_bytes: bool,
    process_start_time: bool,
    process_tree: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sidecar_version: &'static str,
    sidecar_pid: u32,
    platform: &'static str,
    arch: &'static str,
    capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    ppid: u32,
    start_time_ms: u64,
    run_time_ms: u64,
    name: String,
    command: String,
    status: String,
    cpu_percent: f32,
    cpu_time_ms: u64,
    resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_semantics: IoSemantics,
}

impl ProcessSample {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.name.len())
            .saturating_add(self.command.len())
            .saturating_add(self.status.len())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sequence: u64,
    sampled_at_unix_ms: u64,
    collection_duration_micros: u64,
    scanned_process_count: usize,
    retained_process_count: usize,
    inaccessible_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    external_processes: Vec<ExternalProcess>,
    processes: Vec<ProcessSample>,
}

impl SnapshotEvent {
    fn retained_entry_count(&self) -> usize {
        self.processes
            .len()
            .saturating_add(self.external_processes.len())
    }

    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(
                self.processes
                    .iter()
                    .map(ProcessSample::estimated_history_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.external_processes
                    .iter()
                    .map(ExternalProcess::estimated_history_bytes)
                    .sum::<usize>(),
            )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChunkEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    done: bool,
    snapshots: &'a [SnapshotEvent],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    code: &'static str,
    message: String,
    recoverable: bool,
}

#[derive(Debug, Clone)]
struct CollectorConfig {
    root_pid: u32,
    sample_interval: Option<Duration>,
    external_processes: HashMap<u32, Option<u64>>,
}

#[derive(Default)]
struct HistoryRecorder {
    snapshots: VecDeque<SnapshotEvent>,
    retained_entry_count: usize,
    retained_bytes: usize,
}

impl HistoryRecorder {
    fn record(&mut self, snapshot: &SnapshotEvent) {
        self.record_with_limits(
            snapshot,
            MAX_HISTORY_SNAPSHOTS,
            MAX_HISTORY_RETAINED_ENTRIES,
            MAX_HISTORY_RETAINED_BYTES,
        );
    }

    fn record_with_limits(
        &mut self,
        snapshot: &SnapshotEvent,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let mut retained = snapshot.clone();
        retained.request_id = None;
        self.retained_entry_count = self
            .retained_entry_count
            .saturating_add(retained.retained_entry_count());
        self.retained_bytes = self
            .retained_bytes
            .saturating_add(retained.estimated_history_bytes());
        self.snapshots.push_back(retained);
        self.trim_to_limits(
            snapshot.sampled_at_unix_ms,
            max_snapshots,
            max_retained_entries,
            max_retained_bytes,
        );
    }

    fn trim_to_limits(
        &mut self,
        now_ms: u64,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let mut future_entry_count = 0usize;
        let mut future_bytes = 0usize;
        self.snapshots.retain(|snapshot| {
            let keep = snapshot.sampled_at_unix_ms <= now_ms;
            if !keep {
                future_entry_count =
                    future_entry_count.saturating_add(snapshot.retained_entry_count());
                future_bytes = future_bytes.saturating_add(snapshot.estimated_history_bytes());
            }
            keep
        });
        self.retained_entry_count = self.retained_entry_count.saturating_sub(future_entry_count);
        self.retained_bytes = self.retained_bytes.saturating_sub(future_bytes);

        while self.snapshots.front().is_some_and(|snapshot| {
            snapshot.sampled_at_unix_ms < now_ms.saturating_sub(HISTORY_RETENTION_MS)
                || self.snapshots.len() > max_snapshots
                || self.retained_entry_count > max_retained_entries
                || self.retained_bytes > max_retained_bytes
        }) {
            if let Some(removed) = self.snapshots.pop_front() {
                self.retained_entry_count = self
                    .retained_entry_count
                    .saturating_sub(removed.retained_entry_count());
                self.retained_bytes = self
                    .retained_bytes
                    .saturating_sub(removed.estimated_history_bytes());
            }
        }
    }

    fn read(&self, window_ms: u64, now_ms: u64) -> Vec<SnapshotEvent> {
        let started_at_ms = now_ms.saturating_sub(window_ms.min(HISTORY_RETENTION_MS));
        self.snapshots
            .iter()
            .filter(|snapshot| {
                snapshot.sampled_at_unix_ms >= started_at_ms
                    && snapshot.sampled_at_unix_ms <= now_ms
            })
            .cloned()
            .collect()
    }
}

struct Collector {
    system: System,
    sequence: u64,
    cpu_baseline_refreshed_at: Option<Instant>,
}

impl Collector {
    fn new() -> Self {
        Self {
            system: System::new(),
            sequence: 0,
            cpu_baseline_refreshed_at: None,
        }
    }

    fn prime_cpu_usage(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    fn sample(&mut self, config: &CollectorConfig, request_id: Option<String>) -> SnapshotEvent {
        if let Some(delay) =
            remaining_cpu_measurement_delay(self.cpu_baseline_refreshed_at.take(), Instant::now())
        {
            thread::sleep(delay);
        }
        let collection_started = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());

        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                let ppid = process.parent().map(Pid::as_u32).unwrap_or(0);
                (pid, ppid, process.start_time().saturating_mul(1_000))
            })
            .collect::<Vec<_>>();
        let external_processes = config
            .external_processes
            .iter()
            .filter_map(|(pid, expected_start_time_ms)| {
                let (_, _, actual_start_time_ms) = rows
                    .iter()
                    .find(|(candidate_pid, _, _)| candidate_pid == pid)?;
                matches_external_identity(*actual_start_time_ms, *expected_start_time_ms).then_some(
                    ExternalProcess {
                        pid: *pid,
                        start_time_ms: Some(*actual_start_time_ms),
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut roots = external_processes
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots);
        let tracked_process_count = tracked.len();
        let mut processes = tracked
            .into_iter()
            .filter_map(|pid| {
                let process = self.system.process(Pid::from_u32(pid))?;
                let disk_usage = process.disk_usage();
                let command = if process.cmd().is_empty() {
                    process.name().to_string_lossy().into_owned()
                } else {
                    process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                };

                Some(ProcessSample {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    start_time_ms: process.start_time().saturating_mul(1_000),
                    run_time_ms: process.run_time().saturating_mul(1_000),
                    name: truncate_utf8(
                        process.name().to_string_lossy().into_owned(),
                        MAX_PROCESS_NAME_BYTES,
                    ),
                    command: truncate_utf8(command, MAX_PROCESS_COMMAND_BYTES),
                    status: truncate_utf8(
                        format!("{:?}", process.status()),
                        MAX_PROCESS_STATUS_BYTES,
                    ),
                    cpu_percent: process.cpu_usage(),
                    cpu_time_ms: process.accumulated_cpu_time(),
                    resident_bytes: process.memory(),
                    virtual_bytes: process.virtual_memory(),
                    io_read_bytes: disk_usage.total_read_bytes,
                    io_write_bytes: disk_usage.total_written_bytes,
                    io_semantics: io_semantics(),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);

        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: unix_time_ms(),
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count: self.system.processes().len(),
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
        }
    }
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_cmd(UpdateKind::Always)
        .without_tasks()
}

fn inaccessible_process_count(selected: usize, materialized: usize) -> usize {
    selected.saturating_sub(materialized)
}

fn remaining_cpu_measurement_delay(
    baseline_refreshed_at: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    baseline_refreshed_at
        .and_then(|baseline| MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(now.duration_since(baseline)))
        .filter(|delay| !delay.is_zero())
}

fn matches_external_identity(
    actual_start_time_ms: u64,
    expected_start_time_ms: Option<u64>,
) -> bool {
    // sysinfo reports process starts at whole-second precision. Normalize the
    // higher-resolution Electron timestamp to that same bucket instead of
    // accepting adjacent seconds, which could attach a quickly reused PID.
    expected_start_time_ms.is_none_or(|expected| {
        actual_start_time_ms == expected - (expected % PROCESS_START_TIME_PRECISION_MS)
    })
}

fn select_tracked_pids(rows: &[(u32, u32, u64)], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<(u32, u64)>>::new();
    let mut start_time_by_pid = HashMap::<u32, u64>::new();
    for (pid, ppid, start_time_ms) in rows {
        children_by_parent
            .entry(*ppid)
            .or_default()
            .push((*pid, *start_time_ms));
        start_time_by_pid.insert(*pid, *start_time_ms);
    }

    let mut tracked = HashSet::new();
    let mut visited_identities = HashSet::new();
    let mut queue = roots
        .iter()
        .filter_map(|pid| {
            start_time_by_pid
                .get(pid)
                .map(|start_time_ms| (*pid, *start_time_ms))
        })
        .collect::<VecDeque<_>>();

    while let Some((pid, start_time_ms)) = queue.pop_front() {
        if !visited_identities.insert((pid, start_time_ms)) {
            continue;
        }
        tracked.insert(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(
                children
                    .iter()
                    .copied()
                    .filter(|(_, child_start_time_ms)| *child_start_time_ms >= start_time_ms),
            );
        }
    }

    tracked
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    value
}

fn io_semantics() -> IoSemantics {
    if cfg!(target_os = "windows") {
        IoSemantics::AllIo
    } else {
        IoSemantics::Storage
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clamp_sample_interval(sample_interval_ms: u64) -> Option<Duration> {
    (sample_interval_ms > 0).then(|| {
        Duration::from_millis(
            sample_interval_ms.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS),
        )
    })
}

fn spawn_input_reader() -> Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(Input::Invalid(format!(
                        "failed reading command stream: {error}"
                    )));
                    return;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if sender.send(Input::Command(command)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    if sender
                        .send(Input::Invalid(format!("invalid command: {error}")))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

fn sample_now_deadline(
    current: Option<Instant>,
    interval: Option<Duration>,
    now: Instant,
) -> Option<Instant> {
    current.or_else(|| interval.map(|duration| now + duration))
}

fn write_event<T: Serialize>(writer: &mut impl Write, event: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_error(
    writer: &mut impl Write,
    code: &'static str,
    message: impl Into<String>,
    recoverable: bool,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            code,
            message: message.into(),
            recoverable,
        },
    )
}

fn write_history(
    writer: &mut impl Write,
    request_id: &str,
    snapshots: &[SnapshotEvent],
) -> io::Result<()> {
    if snapshots.is_empty() {
        return write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: true,
                snapshots,
            },
        );
    }

    let chunk_count = snapshots.len().div_ceil(HISTORY_CHUNK_SNAPSHOTS);
    for (index, chunk) in snapshots.chunks(HISTORY_CHUNK_SNAPSHOTS).enumerate() {
        write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: index + 1 == chunk_count,
                snapshots: chunk,
            },
        )?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let mut writer = BufWriter::new(io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                cumulative_cpu_time: true,
                current_cpu_percent: true,
                resident_memory: true,
                virtual_memory: true,
                io_bytes: true,
                process_start_time: true,
                process_tree: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut collector = Collector::new();
    let mut history = HistoryRecorder::default();
    let mut config: Option<CollectorConfig> = None;
    let mut next_sample_at: Option<Instant> = None;
    let mut streaming_enabled = false;

    loop {
        if next_sample_at.is_some_and(|deadline| deadline <= Instant::now()) {
            if let Some(current) = config.as_ref() {
                if let Some(interval) = current.sample_interval {
                    let event = collector.sample(current, None);
                    history.record(&event);
                    if streaming_enabled {
                        write_event(&mut writer, &event)?;
                    }
                    next_sample_at = Some(Instant::now() + interval);
                } else {
                    next_sample_at = None;
                }
            } else {
                next_sample_at = None;
            }
            continue;
        }

        let timeout = next_sample_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));

        match receiver.recv_timeout(timeout) {
            Ok(Input::Invalid(message)) => {
                write_error(&mut writer, "invalid-command", message, true)?;
            }
            Ok(Input::Command(command)) => {
                if command.version() != PROTOCOL_VERSION {
                    write_error(
                        &mut writer,
                        "protocol-mismatch",
                        format!(
                            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                            command.version()
                        ),
                        false,
                    )?;
                    continue;
                }

                match command {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        external_processes,
                        ..
                    } => {
                        let sample_interval = clamp_sample_interval(sample_interval_ms);
                        config = Some(CollectorConfig {
                            root_pid,
                            sample_interval,
                            external_processes: external_processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect(),
                        });
                        collector.prime_cpu_usage();
                        next_sample_at = sample_interval.map(|_| Instant::now());
                    }
                    Command::SetExternalProcesses { processes, .. } => {
                        if let Some(current) = config.as_mut() {
                            current.external_processes = processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect();
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before external processes",
                                true,
                            )?;
                        }
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        if let Some(current) = config.as_mut() {
                            current.sample_interval = clamp_sample_interval(sample_interval_ms);
                            next_sample_at = current
                                .sample_interval
                                .map(|interval| Instant::now() + interval);
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before changing the sample interval",
                                true,
                            )?;
                        }
                    }
                    Command::SetStreaming { enabled, .. } => {
                        streaming_enabled = enabled;
                    }
                    Command::SampleNow { request_id, .. } => {
                        if let Some(current) = config.as_ref() {
                            let event = collector.sample(current, Some(request_id));
                            history.record(&event);
                            write_event(&mut writer, &event)?;
                            next_sample_at = sample_now_deadline(
                                next_sample_at,
                                current.sample_interval,
                                Instant::now(),
                            );
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before sampling",
                                true,
                            )?;
                        }
                    }
                    Command::ReadHistory {
                        request_id,
                        window_ms,
                        ..
                    } => {
                        if config.is_some() {
                            let snapshots = history.read(window_ms, unix_time_ms());
                            write_history(&mut writer, &request_id, &snapshots)?;
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before reading history",
                                true,
                            )?;
                        }
                    }
                    Command::Shutdown { .. } => return Ok(()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_roots_and_all_descendants() {
        let rows = vec![
            (10, 1, 1_000),
            (11, 10, 1_100),
            (12, 11, 1_200),
            (20, 1, 2_000),
            (21, 20, 2_100),
            (30, 99, 3_000),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([10, 20]));

        assert_eq!(tracked, HashSet::from([10, 11, 12, 20, 21]));
    }

    #[test]
    fn rejects_descendants_older_than_a_reused_parent_pid() {
        let rows = vec![
            (20, 1, 5_000),
            (21, 20, 4_000),
            (22, 20, 5_100),
            (23, 21, 5_200),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([20]));

        assert_eq!(tracked, HashSet::from([20, 22]));
    }

    #[test]
    fn ignores_missing_roots() {
        let rows = vec![(10, 1, 1_000), (11, 10, 1_100)];
        let tracked = select_tracked_pids(&rows, &HashSet::from([99]));

        assert!(tracked.is_empty());
    }

    #[test]
    fn validates_external_process_start_identity() {
        assert!(matches_external_identity(10_000, None));
        assert!(matches_external_identity(10_000, Some(10_999)));
        assert!(!matches_external_identity(10_000, Some(11_000)));
        assert!(!matches_external_identity(10_000, Some(9_999)));
    }

    #[test]
    fn decodes_protocol_commands() {
        let configure = serde_json::from_str::<Command>(
            r#"{"version":2,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"externalProcesses":[{"pid":7}]}"#,
        )
        .expect("configure command");

        match configure {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                external_processes,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1_000);
                assert_eq!(external_processes[0].pid, 7);
                assert_eq!(external_processes[0].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let read_history = serde_json::from_str::<Command>(
            r#"{"version":2,"type":"readHistory","requestId":"history-1","windowMs":60000}"#,
        )
        .expect("read history command");
        assert!(matches!(
            read_history,
            Command::ReadHistory {
                request_id,
                window_ms: 60_000,
                ..
            } if request_id == "history-1"
        ));
    }

    #[test]
    fn clamps_sample_interval() {
        assert_eq!(clamp_sample_interval(0), None);
        assert_eq!(clamp_sample_interval(1), Some(Duration::from_millis(250)));
        assert_eq!(
            clamp_sample_interval(100_000),
            Some(Duration::from_millis(60_000))
        );
    }

    #[test]
    fn counts_selected_processes_that_could_not_be_materialized() {
        assert_eq!(inaccessible_process_count(5, 3), 2);
        assert_eq!(inaccessible_process_count(3, 5), 0);
    }

    #[test]
    fn waits_for_a_cpu_measurement_window_after_priming() {
        let baseline = Instant::now();

        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline),
            Some(MINIMUM_CPU_UPDATE_INTERVAL)
        );
        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline + MINIMUM_CPU_UPDATE_INTERVAL),
            None
        );
        assert_eq!(remaining_cpu_measurement_delay(None, baseline), None);
    }

    #[test]
    fn retains_bounded_history_without_request_ids() {
        let mut history = HistoryRecorder::default();
        for sequence in 0..=MAX_HISTORY_SNAPSHOTS {
            history.record(&SnapshotEvent {
                version: PROTOCOL_VERSION,
                event_type: "snapshot",
                sequence: sequence as u64,
                sampled_at_unix_ms: sequence as u64 * 1_000,
                collection_duration_micros: 1,
                scanned_process_count: 0,
                retained_process_count: 0,
                inaccessible_process_count: 0,
                request_id: Some("request".to_owned()),
                external_processes: vec![ExternalProcess {
                    pid: 7,
                    start_time_ms: Some(1_000),
                }],
                processes: Vec::new(),
            });
        }

        assert_eq!(history.snapshots.len(), MAX_HISTORY_SNAPSHOTS);
        assert!(
            history
                .snapshots
                .iter()
                .all(|snapshot| snapshot.request_id.is_none())
        );
        assert!(history.snapshots.iter().all(|snapshot| {
            snapshot.external_processes.len() == 1
                && snapshot.external_processes[0].pid == 7
                && snapshot.external_processes[0].start_time_ms == Some(1_000)
        }));
        assert_eq!(
            history
                .read(10_000, MAX_HISTORY_SNAPSHOTS as u64 * 1_000)
                .len(),
            11
        );
    }

    #[test]
    fn excludes_and_trims_future_history_after_the_clock_moves_backward() {
        let mut history = HistoryRecorder::default();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 2_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
        };
        history.record(&snapshot);

        assert!(history.read(0, 1_000).is_empty());

        history.record(&SnapshotEvent {
            sequence: 2,
            sampled_at_unix_ms: 1_000,
            ..snapshot
        });
        assert_eq!(history.snapshots.len(), 1);
        assert_eq!(
            history.snapshots.front().map(|entry| entry.sequence),
            Some(2)
        );
    }

    #[test]
    fn bounds_history_by_estimated_process_bytes() {
        let mut history = HistoryRecorder::default();
        let command = "x".repeat(128);
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot_bytes =
            std::mem::size_of::<SnapshotEvent>() + process.estimated_history_bytes();
        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    version: PROTOCOL_VERSION,
                    event_type: "snapshot",
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    collection_duration_micros: 1,
                    scanned_process_count: 1,
                    retained_process_count: 1,
                    inaccessible_process_count: 0,
                    request_id: None,
                    external_processes: Vec::new(),
                    processes: vec![ProcessSample {
                        pid: sequence as u32 + 1,
                        start_time_ms: sequence * 1_000,
                        ..process.clone()
                    }],
                },
                3,
                3,
                snapshot_bytes * 2,
            );
        }

        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn counts_external_processes_toward_history_limits() {
        let mut history = HistoryRecorder::default();
        let external_processes = (1..=128)
            .map(|pid| ExternalProcess {
                pid,
                start_time_ms: Some(u64::from(pid) * 1_000),
            })
            .collect::<Vec<_>>();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 0,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes,
            processes: Vec::new(),
        };
        let snapshot_bytes = snapshot.estimated_history_bytes();
        let snapshot_entries = snapshot.retained_entry_count();

        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    ..snapshot.clone()
                },
                3,
                snapshot_entries * 2,
                snapshot_bytes * 2,
            );
        }

        assert_eq!(history.retained_entry_count, snapshot_entries * 2);
        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn truncates_process_strings_at_utf8_boundaries() {
        let value = "é".repeat(MAX_PROCESS_NAME_BYTES);
        let truncated = truncate_utf8(value, MAX_PROCESS_NAME_BYTES - 1);

        assert!(truncated.len() < MAX_PROCESS_NAME_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn refreshes_commands_without_enumerating_linux_tasks() {
        let refresh_kind = process_refresh_kind();

        assert_eq!(refresh_kind.cmd(), UpdateKind::Always);
        assert!(!refresh_kind.tasks());
        assert!(refresh_kind.cpu());
        assert!(refresh_kind.memory());
        assert!(refresh_kind.disk_usage());
    }

    #[test]
    fn sample_now_does_not_postpone_an_existing_periodic_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(
            sample_now_deadline(
                Some(deadline),
                Some(Duration::from_secs(5)),
                now + Duration::from_millis(100)
            ),
            Some(deadline)
        );
    }
}
