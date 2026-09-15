mod runtime;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Start {
        #[serde(rename = "executionId")]
        execution_id: String,
        code: String,
        tools: Vec<String>,
    },
    Reply {
        #[serde(rename = "executionId")]
        execution_id: String,
        id: u32,
        failed: bool,
        value: Value,
    },
    Cancel {
        #[serde(rename = "executionId")]
        execution_id: String,
    },
    Stats,
}
enum Command {
    Start {
        execution_id: String,
        code: String,
        tools: Vec<String>,
    },
    Reply {
        id: u32,
        failed: bool,
        value: Value,
    },
    Cancel,
    Stop,
}
enum Event {
    Request(Request),
    Output(Value),
    Complete {
        worker: u32,
        execution_id: String,
        result: Result<Value, String>,
    },
    Exited(u32),
    Shutdown,
}
struct Worker {
    sender: SyncSender<Command>,
    cancelled: Arc<AtomicBool>,
    execution: Option<String>,
    idle_since: Instant,
    handle: thread::JoinHandle<()>,
}
fn emit(events: &SyncSender<Event>, value: Value) -> Result<(), ()> {
    events.try_send(Event::Output(value)).map_err(|_| ())
}
fn output(sender: &SyncSender<Value>, value: Value) {
    if sender.try_send(value).is_err() {
        std::process::exit(1);
    }
}

fn main() {
    let (events, receiver) = mpsc::sync_channel(256);
    let (writer, output_receiver) = mpsc::sync_channel::<Value>(256);
    thread::spawn(move || {
        let mut stdout = io::BufWriter::new(io::stdout().lock());
        for value in output_receiver {
            if serde_json::to_writer(&mut stdout, &value).is_err()
                || stdout.write_all(b"\n").is_err()
                || stdout.flush().is_err()
            {
                std::process::exit(1);
            }
        }
    });
    let input_events = events.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            // Do not allocate an unbounded line for malformed or stalled producers.
            let mut frame = Vec::new();
            loop {
                let bytes = match stdin.fill_buf() {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        let _ = input_events.send(Event::Shutdown);
                        return;
                    }
                };
                if bytes.is_empty() {
                    let _ = input_events.send(Event::Shutdown);
                    return;
                }
                let length = bytes
                    .iter()
                    .position(|&b| b == b'\n')
                    .map_or(bytes.len(), |i| i + 1);
                if frame.len() + length > 256 * 1024 {
                    std::process::exit(1);
                }
                let complete = bytes[length - 1] == b'\n';
                frame.extend_from_slice(&bytes[..length]);
                stdin.consume(length);
                if complete {
                    break;
                }
            }
            let request = match serde_json::from_slice(&frame) {
                Ok(value) => value,
                Err(_) => std::process::exit(1),
            };
            if input_events.send(Event::Request(request)).is_err() {
                return;
            }
        }
    });
    output(&writer, json!({"type":"ready", "pid":std::process::id()}));
    let mut workers = HashMap::<u32, Worker>::new();
    let mut next_worker = 0;
    loop {
        let event = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let retired: Vec<_> = workers
                    .iter()
                    .filter(|(_, w)| {
                        w.execution.is_none() && w.idle_since.elapsed() >= Duration::from_secs(60)
                    })
                    .map(|(&id, _)| id)
                    .collect();
                for id in retired {
                    let worker = workers.remove(&id).unwrap();
                    let _ = worker.sender.send(Command::Stop);
                    let _ = worker.handle.join();
                }
                continue;
            }
        };
        match event {
            Event::Request(Request::Start {
                execution_id,
                code,
                tools,
            }) => {
                if execution_id.is_empty()
                    || execution_id.len() > 128
                    || code.chars().count() > 32_000
                    || tools.len() > 512
                    || workers
                        .values()
                        .any(|w| w.execution.as_ref() == Some(&execution_id))
                {
                    std::process::exit(1);
                }
                let worker_id = if let Some((&id, _)) =
                    workers.iter().find(|(_, w)| w.execution.is_none())
                {
                    id
                } else {
                    if workers.len() >= 8 {
                        output(
                            &writer,
                            json!({"type":"done","executionId":execution_id,"failed":true,"value":{"message":"Code host allows 8 concurrent evaluations."}}),
                        );
                        continue;
                    }
                    next_worker += 1;
                    let worker_id = next_worker;
                    let (sender, commands) = mpsc::sync_channel(64);
                    let cancelled = Arc::new(AtomicBool::new(false));
                    let worker_cancelled = cancelled.clone();
                    let worker_events = events.clone();
                    let handle = thread::Builder::new()
                        .name(format!("code-mode-{worker_id}"))
                        .stack_size(2 * 1024 * 1024)
                        .spawn(move || {
                            loop {
                                match commands.recv() {
                                    Ok(Command::Start {
                                        execution_id,
                                        code,
                                        tools,
                                    }) => {
                                        let result = std::panic::catch_unwind(
                                            std::panic::AssertUnwindSafe(|| {
                                                runtime::evaluate(
                                                    &execution_id,
                                                    &code,
                                                    tools,
                                                    worker_cancelled.clone(),
                                                    &commands,
                                                    &worker_events,
                                                )
                                            }),
                                        )
                                        .unwrap_or_else(
                                            |_| Err("Code host worker panicked".into()),
                                        );
                                        // evaluate has dropped the context and runtime before this acknowledgment.
                                        if worker_events
                                            .send(Event::Complete {
                                                worker: worker_id,
                                                execution_id,
                                                result,
                                            })
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                    Ok(Command::Cancel | Command::Reply { .. }) => {}
                                    _ => break,
                                }
                            }
                            let _ = worker_events.send(Event::Exited(worker_id));
                        })
                        .expect("spawn code worker");
                    workers.insert(
                        worker_id,
                        Worker {
                            sender,
                            cancelled,
                            execution: None,
                            idle_since: Instant::now(),
                            handle,
                        },
                    );
                    worker_id
                };
                let worker = workers.get_mut(&worker_id).unwrap();
                worker.cancelled.store(false, Ordering::Relaxed);
                worker.execution = Some(execution_id.clone());
                output(
                    &writer,
                    json!({"type":"started","executionId":execution_id,"threadId":worker_id}),
                );
                if worker
                    .sender
                    .try_send(Command::Start {
                        execution_id,
                        code,
                        tools,
                    })
                    .is_err()
                {
                    std::process::exit(1);
                }
            }
            Event::Request(Request::Reply {
                execution_id,
                id,
                failed,
                value,
            }) => {
                if id >= 32 {
                    std::process::exit(1);
                }
                if let Some(worker) = workers
                    .values()
                    .find(|w| w.execution.as_ref() == Some(&execution_id))
                    && worker
                        .sender
                        .try_send(Command::Reply { id, failed, value })
                        .is_err()
                {
                    std::process::exit(1);
                }
            }
            Event::Request(Request::Cancel { execution_id }) => {
                if let Some(worker) = workers
                    .values()
                    .find(|w| w.execution.as_ref() == Some(&execution_id))
                {
                    worker.cancelled.store(true, Ordering::Relaxed);
                    let _ = worker.sender.try_send(Command::Cancel);
                }
            }
            Event::Request(Request::Stats) => {
                let pid = sysinfo::Pid::from_u32(std::process::id());
                let mut system = System::new();
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[pid]),
                    true,
                    ProcessRefreshKind::nothing().with_memory(),
                );
                output(
                    &writer,
                    json!({"type":"stats","pid":std::process::id(),"rssBytes":system.process(pid).map_or(0, |p| p.memory()),"workers":workers.len()}),
                );
            }
            Event::Output(value) => output(&writer, value),
            Event::Complete {
                worker,
                execution_id,
                result,
            } => {
                let slot = workers.get_mut(&worker).unwrap();
                slot.execution = None;
                slot.idle_since = Instant::now();
                let (failed, value) = match result {
                    Ok(value) => (false, value),
                    Err(message) => (true, json!({"message":message})),
                };
                output(
                    &writer,
                    json!({"type":"done","executionId":execution_id,"failed":failed,"value":value}),
                );
            }
            Event::Exited(id) => {
                if let Some(worker) = workers.remove(&id) {
                    let _ = worker.handle.join();
                }
            }
            Event::Shutdown => break,
        }
    }
    for worker in workers.values() {
        worker.cancelled.store(true, Ordering::Relaxed);
        let _ = worker.sender.try_send(Command::Stop);
    }
    // EOF shuts down the process; the supervisor reaps it and marks outstanding effects uncertain.
}
