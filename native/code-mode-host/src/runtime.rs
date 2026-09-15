use crate::{Command, Event, emit};
use rquickjs::{Context, Ctx, Error, Exception, Function, Promise, Runtime};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender},
    },
    time::{Duration, Instant},
};

fn js_error(ctx: &Ctx<'_>, error: Error) -> String {
    let text = if matches!(error, Error::Exception) {
        let value = ctx.catch();
        if let Some(exception) = value.as_exception() {
            exception
                .message()
                .unwrap_or_else(|| "JavaScript exception".into())
        } else if let Some(text) = value.as_string() {
            text.to_string()
                .unwrap_or_else(|_| "JavaScript exception".into())
        } else {
            "JavaScript exception".into()
        }
    } else {
        error.to_string()
    };
    text.chars().take(2_000).collect()
}

/// Each thread owns its VM. Only JSON strings and the tool allowlist enter the guest.
pub fn evaluate(
    execution_id: &str,
    code: &str,
    tools: Vec<String>,
    cancelled: Arc<AtomicBool>,
    commands: &Receiver<Command>,
    events: &SyncSender<Event>,
) -> Result<Value, String> {
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(1)));
    let interrupt_deadline = deadline.clone();
    let interrupt_cancel = cancelled.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupt_cancel.load(Ordering::Relaxed)
            || Instant::now() >= *interrupt_deadline.lock().unwrap()
    })));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    context.with(|ctx| {
        evaluate_context(
            ctx,
            Script {
                execution_id,
                code,
                tools,
            },
            cancelled,
            commands,
            events,
            deadline,
        )
    })
}

struct Script<'a> {
    execution_id: &'a str,
    code: &'a str,
    tools: Vec<String>,
}

fn evaluate_context<'js>(
    ctx: Ctx<'js>,
    script: Script<'_>,
    cancelled: Arc<AtomicBool>,
    commands: &Receiver<Command>,
    events: &SyncSender<Event>,
    deadline: Arc<Mutex<Instant>>,
) -> Result<Value, String> {
    let Script {
        execution_id,
        code,
        tools,
    } = script;
    let pending = Rc::new(RefCell::new(
        HashMap::<u32, (Function<'_>, Function<'_>)>::new(),
    ));
    let result = (|| {
        let allowlist: HashSet<_> = tools.iter().cloned().collect();
        let call_pending = pending.clone();
        let call_events = events.clone();
        let call_execution = execution_id.to_owned();
        let total = Cell::new(0u32);
        let call = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String, args: String| -> rquickjs::Result<Promise<'js>> {
                if !allowlist.contains(&name) { return Err(Exception::throw_message(&ctx, "Unknown code mode tool")); }
                if total.get() >= 32 || call_pending.borrow().len() >= 8 { return Err(Exception::throw_message(&ctx, "Code mode allows 32 calls per execution and 8 calls in flight.")); }
                if args.len() > 64 * 1024 { return Err(Exception::throw_message(&ctx, "Tool arguments exceed 64 KiB.")); }
                let args: Value = serde_json::from_str(&args).map_err(|_| Exception::throw_message(&ctx, "Invalid tool JSON"))?;
                let (promise, resolve, reject) = ctx.promise()?;
                let id = total.get();
                total.set(id + 1);
                call_pending.borrow_mut().insert(id, (resolve, reject));
                emit(&call_events, json!({"type":"call", "executionId":call_execution, "id":id, "tool":name, "args":args})).map_err(|_| Exception::throw_message(&ctx, "Code host output queue is full"))?;
                Ok(promise)
            },
        ).map_err(|e| js_error(&ctx, e))?;
        ctx.globals()
            .set("__t3_call", call)
            .map_err(|e| js_error(&ctx, e))?;
        let log_events = events.clone();
        let log_execution = execution_id.to_owned();
        let logs = Cell::new(0);
        let log = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, text: String| -> rquickjs::Result<()> {
                if logs.get() >= 20 || text.len() > 2_000 {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Code mode allows 20 log entries of at most 2 KiB.",
                    ));
                }
                logs.set(logs.get() + 1);
                emit(
                    &log_events,
                    json!({"type":"log","executionId":log_execution,"text":text}),
                )
                .map_err(|_| Exception::throw_message(&ctx, "Code host output queue is full"))
            },
        )
        .map_err(|e| js_error(&ctx, e))?;
        ctx.globals()
            .set("__t3_log", log)
            .map_err(|e| js_error(&ctx, e))?;
        let program = format!(
            r#"(() => {{
                const encode = JSON.stringify, decode = JSON.parse, call = __t3_call, log = __t3_log;
                const t3 = Object.freeze(Object.fromEntries({}.map(name => [name, args => call(name, encode(args ?? {{}})).then(decode, json => {{
                    const error = decode(json); throw Object.assign(new Error(error.message ?? 'Tool call failed'), error);
                }})])));
                const console = Object.freeze({{log: (...values) => log(encode(values))}});
                return (async () => {{ {}
 }})().then(value => encode(value ?? null));
            }})()"#,
            serde_json::to_string(&tools).unwrap(),
            code
        );
        let mut remaining = Duration::from_secs(1);
        let started = Instant::now();
        *deadline.lock().unwrap() = started + remaining;
        let promise: Promise = ctx.eval(program).map_err(|e| js_error(&ctx, e))?;
        remaining = remaining.saturating_sub(started.elapsed());
        let mut journal_bytes = 0;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Code mode execution cancelled.".into());
            }
            let started = Instant::now();
            *deadline.lock().unwrap() = started + remaining;
            let result = promise.finish::<String>();
            remaining = remaining.saturating_sub(started.elapsed());
            match result {
                Ok(json) => {
                    if !pending.borrow().is_empty() {
                        return Err(
                            "Script returned with unawaited tool calls; await every call.".into(),
                        );
                    }
                    if json.len() > 64 * 1024 {
                        return Err("Code mode output exceeds 64 KiB.".into());
                    }
                    return serde_json::from_str(&json).map_err(|e| e.to_string());
                }
                Err(Error::WouldBlock) => {}
                Err(error) => return Err(js_error(&ctx, error)),
            }
            match commands.recv().map_err(|_| "Code host is shutting down")? {
                Command::Reply { id, failed, value } => {
                    let (resolve, reject) = pending
                        .borrow_mut()
                        .remove(&id)
                        .ok_or("Unknown code host reply")?;
                    let mut json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
                    journal_bytes += json.len();
                    let failed = if json.len() > 64 * 1024 || journal_bytes > 256 * 1024 {
                        json = "{\"message\":\"Code mode results exceed 64 KiB per value or 256 KiB total.\"}".into();
                        true
                    } else {
                        failed
                    };
                    (if failed { reject } else { resolve })
                        .call::<_, ()>((json,))
                        .map_err(|e| js_error(&ctx, e))?;
                }
                Command::Cancel | Command::Stop => {
                    return Err("Code mode execution cancelled.".into());
                }
                Command::Start { .. } => return Err("Code host worker is already busy".into()),
            }
        }
    })();
    // Native callbacks retain JS resolvers; clear them even on cancellation to break cycles.
    pending.borrow_mut().clear();
    let _ = ctx.globals().remove("__t3_call");
    let _ = ctx.globals().remove("__t3_log");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn run(code: &str, replies: Vec<Command>) -> (Result<Value, String>, Vec<Value>) {
        let (sender, commands) = mpsc::sync_channel(64);
        for reply in replies {
            sender.send(reply).unwrap();
        }
        let (events, receiver) = mpsc::sync_channel(256);
        let result = evaluate(
            "test",
            code,
            vec!["test".into()],
            Arc::new(AtomicBool::new(false)),
            &commands,
            &events,
        );
        let emitted = receiver
            .try_iter()
            .filter_map(|event| match event {
                Event::Output(value) => Some(value),
                _ => None,
            })
            .collect();
        (result, emitted)
    }

    #[test]
    fn fresh_heaps_and_callback_cleanup() {
        assert_eq!(
            run(
                "globalThis.saved = __t3_call; Object.freeze(globalThis); return typeof process;",
                vec![]
            )
            .0
            .unwrap(),
            json!("undefined")
        );
        assert_eq!(
            run("return typeof saved", vec![]).0.unwrap(),
            json!("undefined")
        );
    }

    #[test]
    fn concurrent_calls_and_structured_rejection() {
        let (result, events) = run(
            "return await Promise.all([t3.test({n:1}), t3.test({n:2}).catch(e => ({code:e.code,message:e.message}))]);",
            vec![
                Command::Reply {
                    id: 0,
                    failed: false,
                    value: json!({"ok":true}),
                },
                Command::Reply {
                    id: 1,
                    failed: true,
                    value: json!({"code":"denied","message":"Denied"}),
                },
            ],
        );
        assert_eq!(
            result.unwrap(),
            json!([{"ok":true},{"code":"denied","message":"Denied"}])
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["args"], json!({"n":1}));
        assert_eq!(events[1]["args"], json!({"n":2}));
    }

    #[test]
    fn budgets_and_failed_vm_cleanup() {
        assert!(
            run("while(true) {}", vec![])
                .0
                .unwrap_err()
                .contains("interrupted")
        );
        assert!(
            run("return new ArrayBuffer(32000000)", vec![])
                .0
                .unwrap_err()
                .contains("out of memory")
        );
        assert!(
            run("return 'x'.repeat(70000)", vec![])
                .0
                .unwrap_err()
                .contains("64 KiB")
        );
        assert!(
            run(
                "return Promise.all(Array.from({length:9},()=>t3.test({})))",
                vec![]
            )
            .0
            .unwrap_err()
            .contains("8 calls")
        );
        assert_eq!(run("return 3", vec![]).0.unwrap(), json!(3));
    }
}
