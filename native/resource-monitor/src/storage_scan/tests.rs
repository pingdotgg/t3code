use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "t3-storage-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn finish(scan: &mut Scan, limit: usize) -> u64 {
    let mut previous = 0;
    loop {
        let progress = scan.step(limit, Duration::from_secs(1)).unwrap();
        assert!(progress.bytes >= previous);
        previous = progress.bytes;
        if progress.done {
            return progress.bytes;
        }
    }
}

#[test]
fn measures_allocations_and_preserves_hardlinks_across_batches() {
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    let nested = root.join("nested");
    fs::create_dir_all(&nested).unwrap();
    let local = root.join("local");
    let internal = nested.join("internal");
    fs::write(&local, vec![0; 8192]).unwrap();
    fs::write(&internal, vec![0; 16384]).unwrap();
    fs::hard_link(&internal, root.join("internal-link")).unwrap();
    let external = fixture.0.join("external");
    fs::write(&external, vec![0; 32768]).unwrap();
    fs::hard_link(&external, root.join("shared")).unwrap();
    fs::hard_link(&external, nested.join("shared-again")).unwrap();
    let expected: u64 = [&root, &nested, &local, &internal]
        .iter()
        .map(|p| file_info(p).unwrap().bytes)
        .sum();
    assert_eq!(finish(&mut Scan::new(root.clone()), 1), expected);
    assert_eq!(
        finish(&mut Scan::new(root), BATCH_ENTRIES_PER_WORKER),
        expected
    );
}

#[test]
fn includes_empty_directory_allocations() {
    let fixture = Fixture::new();
    let nested = fixture.0.join("empty");
    fs::create_dir(&nested).unwrap();
    let expected = file_info(&fixture.0).unwrap().bytes + file_info(&nested).unwrap().bytes;
    assert_eq!(finish(&mut Scan::new(fixture.0.clone()), 1), expected);
}

#[cfg(unix)]
#[test]
fn excludes_sparse_holes_and_does_not_follow_symlink_cycles() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    fs::create_dir(&root).unwrap();
    let sparse = root.join("sparse");
    fs::File::create(&sparse)
        .unwrap()
        .set_len(1024 * 1024 * 1024)
        .unwrap();
    let link = root.join("cycle");
    symlink(&fixture.0, &link).unwrap();
    let expected: u64 = [&root, &sparse, &link]
        .iter()
        .map(|p| file_info(p).unwrap().bytes)
        .sum();
    assert!(expected < 1024 * 1024);
    assert_eq!(finish(&mut Scan::new(root), 1), expected);
}

#[cfg(windows)]
#[test]
fn does_not_traverse_directory_junctions() {
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    fs::create_dir(&root).unwrap();
    let junction = root.join("cycle");
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&fixture.0)
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result);
    let expected = file_info(&root).unwrap().bytes + file_info(&junction).unwrap().bytes;
    let bytes = finish(&mut Scan::new(root), 1);
    fs::remove_dir(&junction).unwrap();
    assert_eq!(bytes, expected);
}

#[test]
fn finishes_large_worktrees_with_bounded_batches() {
    let fixture = Fixture::new();
    for i in 0..20_001 {
        fs::File::create(fixture.0.join(i.to_string())).unwrap();
    }
    let mut scan = Scan::new(fixture.0.clone());
    let first = scan.step(32, Duration::from_secs(1)).unwrap();
    assert!(!first.done);
    assert_eq!(finish(&mut scan, 256), file_info(&fixture.0).unwrap().bytes);
}

#[test]
fn reports_invalid_roots_and_commands() {
    let fixture = Fixture::new();
    let file = fixture.0.join("file");
    fs::write(&file, b"content").unwrap();
    for (input, root) in [("next\n", file), ("invalid\n", fixture.0.clone())] {
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output, root).unwrap();
        let event: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(event["version"], 1);
        assert!(event["error"].is_string());
        assert!(event.get("done").is_none());
    }
}

#[test]
fn protocol_waits_for_requests_and_finishes_with_one_response() {
    let fixture = Fixture::new();
    let mut output = Vec::new();
    serve("".as_bytes(), &mut output, fixture.0.join("does-not-exist")).unwrap();
    assert!(output.is_empty());
    serve("next\nnext\n".as_bytes(), &mut output, fixture.0.clone()).unwrap();
    let event: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(event["done"], true);
    assert_eq!(event["bytes"], file_info(&fixture.0).unwrap().bytes);
}

#[cfg(unix)]
#[test]
fn rejects_a_directory_replaced_by_a_symlink_between_batches() {
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    let nested = root.join("nested");
    fs::create_dir_all(&nested).unwrap();
    let mut scan = Scan::new(root);
    // Open root, enqueue nested, then pause while its parent cursor stays open.
    scan.workers[0]
        .step(
            &scan.pending,
            &scan.directories,
            2,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    fs::remove_dir(&nested).unwrap();
    std::os::unix::fs::symlink(&fixture.0, &nested).unwrap();
    assert!(scan.step(10, Duration::from_secs(1)).is_err());
}

#[test]
fn combines_hardlinks_across_workers_and_resumes_each_cursor() {
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    fs::create_dir(&root).unwrap();
    let external = fixture.0.join("external");
    fs::write(&external, vec![0; 8192]).unwrap();
    let mut scan = Scan::new(root.clone());
    scan.pending.get_mut().unwrap().clear();
    // Keep this concurrency fixture independent of the host CPU count.
    scan.workers = (0..4).map(|_| Worker::default()).collect();
    let workers = scan.workers.len();
    let mut expected = file_info(&root).unwrap().bytes;
    let internal = root.join("0/internal");
    for index in 0..workers {
        let directory = root.join(index.to_string());
        fs::create_dir(&directory).unwrap();
        if index == 0 {
            fs::write(&internal, vec![0; 16384]).unwrap();
        } else {
            fs::hard_link(&internal, directory.join("internal")).unwrap();
        }
        fs::hard_link(&external, directory.join("external")).unwrap();
        let local = directory.join("local");
        fs::write(&local, vec![0; 4096]).unwrap();
        expected += file_info(&directory).unwrap().bytes + file_info(&local).unwrap().bytes;
        // Seed one open directory per worker to deterministically exercise links
        // split across workers, independent of the OS thread scheduling order.
        scan.workers[index].bytes = file_info(&directory).unwrap().bytes;
        scan.workers[index].current = Some(fs::read_dir(directory).unwrap());
    }
    scan.workers[0].bytes += file_info(&root).unwrap().bytes;
    expected += file_info(&internal).unwrap().bytes;
    assert!(!scan.step(workers, Duration::from_secs(1)).unwrap().done);
    assert_eq!(finish(&mut scan, workers), expected);
    // Repeated completion must not double-count the merged hardlink allocation.
    assert_eq!(
        scan.step(workers, Duration::from_secs(1)).unwrap().bytes,
        expected
    );
}

#[test]
fn sizes_workers_to_half_available_cpus_with_a_minimum_of_two() {
    for (cpus, expected) in [
        (1, 2),
        (2, 2),
        (3, 2),
        (4, 2),
        (5, 2),
        (8, 4),
        (16, 8),
        (64, 32),
    ] {
        assert_eq!(worker_count(cpus), expected);
    }
}

#[test]
fn rejects_repeated_directory_identity_across_workers() {
    let fixture = Fixture::new();
    let mut scan = Scan::new(fixture.0.clone());
    // A directory alias (including a bind mount) has the same device/inode.
    scan.pending.get_mut().unwrap().push(fixture.0.clone());
    assert!(
        scan.step(BATCH_ENTRIES_PER_WORKER, Duration::from_secs(1))
            .is_err()
    );
}

#[test]
fn refuses_a_different_filesystem_before_counting_it() {
    let mut directories = Directories::default();
    directories.visit((1, 42)).unwrap();
    assert!(directories.visit((2, 99)).is_err());
    assert!(!directories.visited.contains(&(2, 99)));
    directories.visit((1, 99)).unwrap();
}

#[test]
fn skips_a_directory_removed_after_it_was_queued() {
    let fixture = Fixture::new();
    let root = fixture.0.join("worktree");
    let nested = root.join("nested");
    fs::create_dir_all(&nested).unwrap();
    let mut scan = Scan::new(root.clone());
    scan.workers[0]
        .step(
            &scan.pending,
            &scan.directories,
            2,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(*scan.pending.lock().unwrap(), vec![nested.clone()]);
    fs::remove_dir(&nested).unwrap();
    let remaining = root.join("remaining");
    fs::create_dir(&remaining).unwrap();
    let file = remaining.join("file");
    fs::write(&file, vec![0; 8192]).unwrap();
    // Queue surviving work explicitly so cursor caching cannot affect the fixture.
    scan.pending.lock().unwrap().push(remaining.clone());
    scan.workers[0].current = None;
    let expected = scan.workers[0].bytes
        + file_info(&remaining).unwrap().bytes
        + file_info(&file).unwrap().bytes;
    assert_eq!(finish(&mut scan, 1), expected);
}

#[test]
fn finishes_with_zero_bytes_when_the_root_disappears() {
    let fixture = Fixture::new();
    assert_eq!(finish(&mut Scan::new(fixture.0.join("missing")), 1), 0);
}

#[test]
fn missing_path_handling_preserves_other_errors() {
    assert!(
        skip_missing::<()>(Err(io::ErrorKind::NotFound.into()))
            .unwrap()
            .is_none()
    );
    for kind in [
        io::ErrorKind::PermissionDenied,
        io::ErrorKind::InvalidData,
        io::ErrorKind::Interrupted,
    ] {
        assert_eq!(
            skip_missing::<()>(Err(kind.into())).unwrap_err().kind(),
            kind
        );
    }
}

#[test]
fn rejects_a_full_directory_queue_without_growing_it() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("child")).unwrap();
    let pending = Mutex::new(vec![fixture.0.clone(); MAX_PENDING_DIRECTORIES - 1]);
    enqueue_directory(&pending, fixture.0.clone()).unwrap();
    let mut worker = Worker {
        current: Some(fs::read_dir(&fixture.0).unwrap()),
        ..Worker::default()
    };
    let error = worker
        .step(
            &pending,
            &Mutex::new(Directories::default()),
            1,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "too many pending directories");
    assert_eq!(pending.lock().unwrap().len(), MAX_PENDING_DIRECTORIES);
}

#[test]
fn rejects_inexact_byte_totals_including_cross_worker_sums_and_hardlinks() {
    assert_eq!(add_bytes(MAX_SAFE_BYTES - 1, 1).unwrap(), MAX_SAFE_BYTES);
    assert!(add_bytes(MAX_SAFE_BYTES, 1).is_err());
    assert!(add_bytes(1, u64::MAX).is_err());
    let fixture = Fixture::new();
    for hardlink in [false, true] {
        let mut scan = Scan::new(fixture.0.clone());
        scan.pending.get_mut().unwrap().clear();
        scan.workers[0].bytes = MAX_SAFE_BYTES;
        if hardlink {
            scan.workers[1].linked.insert((1, 1), (1, 1, 1));
        } else {
            scan.workers[1].bytes = 1;
        }
        let error = scan.step(1, Duration::from_secs(1)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "storage usage exceeds the safe integer limit"
        );
    }
}
