use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, ReadDir};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const VERSION: u32 = 1;
// Fail through the scan protocol instead of retaining an unbounded directory frontier.
const MAX_PENDING_DIRECTORIES: usize = 65_536;
const MAX_SAFE_BYTES: u64 = (1 << 53) - 1;

fn enqueue_directory(pending: &Mutex<Vec<PathBuf>>, path: PathBuf) -> io::Result<()> {
    let mut pending = pending.lock().unwrap();
    if pending.len() >= MAX_PENDING_DIRECTORIES {
        return Err(io::Error::other("too many pending directories"));
    }
    pending.push(path);
    Ok(())
}

// Every reported total must remain exact when parsed as a JavaScript number.
fn add_bytes(total: u64, bytes: u64) -> io::Result<u64> {
    total
        .checked_add(bytes)
        .filter(|total| *total <= MAX_SAFE_BYTES)
        .ok_or_else(|| io::Error::other("storage usage exceeds the safe integer limit"))
}
const BATCH_ENTRIES_PER_WORKER: usize = 8_192;
const BATCH_TIME: Duration = Duration::from_millis(25);

struct FileInfo {
    directory: bool,
    bytes: u64,
    links: u64,
    identity: (u64, u128),
}

#[cfg(unix)]
fn file_info(path: &Path) -> io::Result<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    Ok(FileInfo {
        directory: metadata.is_dir(),
        bytes: metadata.blocks() * 512,
        links: metadata.nlink(),
        identity: (metadata.dev(), u128::from(metadata.ino())),
    })
}

#[cfg(windows)]
fn file_info(path: &Path) -> io::Result<FileInfo> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_COMPRESSED, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SPARSE_FILE, FILE_COMPRESSION_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FILE_STANDARD_INFO, FileCompressionInfo, FileIdInfo, FileStandardInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx,
    };
    // Inspect the link itself, including junctions; never open the target of a reparse point.
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    let handle = HANDLE(file.as_raw_handle());
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    let mut standard = FILE_STANDARD_INFO::default();
    // Both buffers have the Win32 layout and the handle remains owned by `file`.
    unsafe {
        GetFileInformationByHandle(handle, &mut identity).map_err(io::Error::other)?;
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
        .map_err(io::Error::other)?;
    }
    let directory = identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
        && identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0;
    let mut allocated = standard.AllocationSize;
    let mut id = FILE_ID_INFO::default();
    unsafe {
        if directory || standard.NumberOfLinks > 1 {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
            .map_err(io::Error::other)?;
        }
        if identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
            && identity.dwFileAttributes
                & (FILE_ATTRIBUTE_COMPRESSED.0 | FILE_ATTRIBUTE_SPARSE_FILE.0)
                != 0
        {
            let mut compression = FILE_COMPRESSION_INFO::default();
            GetFileInformationByHandleEx(
                handle,
                FileCompressionInfo,
                (&mut compression as *mut FILE_COMPRESSION_INFO).cast(),
                std::mem::size_of::<FILE_COMPRESSION_INFO>() as u32,
            )
            .map_err(io::Error::other)?;
            allocated = compression.CompressedFileSize;
        }
    }
    Ok(FileInfo {
        directory,
        bytes: u64::try_from(allocated).map_err(io::Error::other)?,
        links: u64::from(standard.NumberOfLinks),
        identity: (
            id.VolumeSerialNumber,
            u128::from_le_bytes(id.FileId.Identifier),
        ),
    })
}

fn directory_entry(entry: &fs::DirEntry) -> io::Result<bool> {
    if !entry.file_type()?.is_dir() {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        return Ok(entry.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0);
    }
    #[cfg(unix)]
    Ok(true)
}

// Files can disappear while a live worktree is being measured.
fn skip_missing<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Debug, Serialize)]
struct Progress {
    version: u32,
    bytes: u64,
    done: bool,
}

#[derive(Default)]
struct Directories {
    device: Option<u64>,
    visited: HashSet<(u64, u128)>,
}
impl Directories {
    fn visit(&mut self, identity: (u64, u128)) -> io::Result<()> {
        let device = *self.device.get_or_insert(identity.0);
        if device != identity.0 {
            return Err(io::Error::other(
                "directory crosses the root filesystem boundary",
            ));
        }
        if !self.visited.insert(identity) {
            return Err(io::Error::other("directory identity was already visited"));
        }
        Ok(())
    }
}

#[derive(Default)]
struct Worker {
    current: Option<ReadDir>,
    // A hardlinked file only contributes once all of its links were found in this worktree.
    linked: HashMap<(u64, u128), (u64, u64, u64)>,
    bytes: u64,
}

impl Worker {
    fn step(
        &mut self,
        pending: &Mutex<Vec<PathBuf>>,
        directories: &Mutex<Directories>,
        limit: usize,
        deadline: Instant,
    ) -> io::Result<()> {
        for _ in 0..limit {
            if Instant::now() >= deadline {
                break;
            }
            if let Some(entries) = &mut self.current {
                if let Some(entry) = entries.next() {
                    let Some(entry) = skip_missing(entry)? else {
                        continue;
                    };
                    let path = entry.path();
                    let Some(is_directory) = skip_missing(directory_entry(&entry))? else {
                        continue;
                    };
                    if is_directory {
                        enqueue_directory(pending, path)?;
                    } else {
                        let Some(info) = skip_missing(file_info(&path))? else {
                            continue;
                        };
                        if info.directory {
                            enqueue_directory(pending, path)?;
                        } else if info.links <= 1 {
                            self.bytes = add_bytes(self.bytes, info.bytes)?;
                        } else {
                            self.linked
                                .entry(info.identity)
                                .or_insert((0, info.links, info.bytes))
                                .0 += 1;
                        }
                    }
                } else {
                    self.current = None;
                }
            } else {
                let directory = pending.lock().unwrap().pop();
                let Some(directory) = directory else {
                    break;
                };
                let Some(info) = skip_missing(file_info(&directory))? else {
                    continue;
                };
                if !info.directory {
                    return Err(io::Error::other(
                        "queued directory is no longer a directory",
                    ));
                }
                directories.lock().unwrap().visit(info.identity)?;
                let Some(entries) = skip_missing(fs::read_dir(directory))? else {
                    continue;
                };
                self.bytes = add_bytes(self.bytes, info.bytes)?;
                self.current = Some(entries);
            }
        }
        Ok(())
    }
}

fn worker_count(available_cpus: usize) -> usize {
    (available_cpus / 2).max(2)
}

struct Scan {
    pending: Mutex<Vec<PathBuf>>,
    directories: Mutex<Directories>,
    workers: Vec<Worker>,
}

impl Scan {
    fn new(root: PathBuf) -> Self {
        Self {
            pending: Mutex::new(vec![root]),
            directories: Mutex::new(Directories::default()),
            workers: (0..worker_count(
                std::thread::available_parallelism()
                    .map(|cpus| cpus.get())
                    .unwrap_or(4),
            ))
                .map(|_| Worker::default())
                .collect(),
        }
    }

    fn step(&mut self, limit: usize, budget: Duration) -> io::Result<Progress> {
        let deadline = Instant::now() + budget;
        let pending = &self.pending;
        let directories = &self.directories;
        let workers = self.workers.len();
        // Join every batch before replying: no filesystem work continues while the
        // client pauses requests, and dropping the scan closes every directory cursor.
        std::thread::scope(|scope| {
            let handles: Vec<_> = self
                .workers
                .iter_mut()
                .enumerate()
                .map(|(index, worker)| {
                    let allowance = limit / workers + usize::from(index < limit % workers);
                    scope.spawn(move || worker.step(pending, directories, allowance, deadline))
                })
                .collect();
            let mut result = Ok(());
            for handle in handles {
                if let Err(error) = handle.join().unwrap() {
                    result = Err(error);
                }
            }
            result
        })?;
        let done = self.pending.lock().unwrap().is_empty()
            && self.workers.iter().all(|worker| worker.current.is_none());
        if done {
            // Links can be discovered by different workers. Merge their counts before
            // deciding whether the allocation is exclusive to this worktree.
            let mut linked: HashMap<(u64, u128), (u64, u64, u64)> = HashMap::new();
            for worker in &mut self.workers {
                for (identity, (seen, total, bytes)) in worker.linked.drain() {
                    linked.entry(identity).or_insert((0, total, bytes)).0 += seen;
                }
            }
            for (seen, total, bytes) in linked.values() {
                if seen == total {
                    self.workers[0].bytes = add_bytes(self.workers[0].bytes, *bytes)?;
                }
            }
        }
        Ok(Progress {
            version: VERSION,
            bytes: self
                .workers
                .iter()
                .try_fold(0, |total, worker| add_bytes(total, worker.bytes))?,
            done,
        })
    }
}

fn serve(input: impl BufRead, mut output: impl Write, root: PathBuf) -> io::Result<()> {
    let mut scan = Scan::new(root);
    for line in input.lines() {
        let result = match line?.as_str() {
            "next" => scan.step(scan.workers.len() * BATCH_ENTRIES_PER_WORKER, BATCH_TIME),
            _ => Err(io::Error::other("expected next command")),
        };
        let done = match result {
            Ok(progress) => {
                serde_json::to_writer(&mut output, &progress)?;
                progress.done
            }
            Err(error) => {
                serde_json::to_writer(
                    &mut output,
                    &serde_json::json!({
                        "version": VERSION, "error": error.to_string(),
                    }),
                )?;
                true
            }
        };
        output.write_all(b"\n")?;
        output.flush()?;
        if done {
            break;
        }
    }
    Ok(())
}

pub fn run(root: PathBuf) -> io::Result<()> {
    serve(
        io::stdin().lock(),
        io::BufWriter::new(io::stdout().lock()),
        root,
    )
}

#[cfg(test)]
mod tests;
