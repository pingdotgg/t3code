//! Windows Job Object ownership for the sidecar process tree.
//!
//! macOS gets orphan safety from `AppDelegate.applicationShouldTerminate`,
//! which awaits an explicit SIGTERM/SIGKILL of the child before the app quits.
//! Windows has no signal equivalent and no way to run cleanup after a hard
//! crash, so the sidecar is instead assigned to a Job Object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Two properties follow:
//!
//! - If this process exits for **any** reason — clean quit, panic, Task
//!   Manager "End task", power loss on the app process — the kernel closes the
//!   job handle and kills every process still in the job. A node sidecar can
//!   never be orphaned holding the port and the SQLite base dir.
//! - `terminate()` kills the whole tree atomically, including the provider
//!   CLIs (codex, claude, …) the server spawned. That is strictly better than
//!   the macOS force path, which SIGKILLs only node and leaves grandchildren.
//!
//! On non-Windows hosts (this crate type-checks on macOS/Linux so the shared
//! logic stays testable) every operation is an explicit no-op.

/// Owns the job the sidecar tree is assigned to.
pub struct ProcessJob {
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
}

// The handle is only ever used through `&self` Win32 calls, which are
// thread-safe, and closed once in `Drop`.
unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Creates a job whose closure kills every member process.
    #[cfg(windows)]
    pub fn create() -> Result<Self, std::io::Error> {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: a null name and null security attributes create an unnamed,
        // process-private job; the returned handle is owned by `self`.
        let handle = unsafe { CreateJobObjectW(None, None) }
            .map_err(|error| std::io::Error::other(error.to_string()))?;

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `limits` outlives the call and its size is the exact size of
        // the struct the information class expects.
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .unwrap_or(u32::MAX),
            )
        };
        if let Err(error) = result {
            // SAFETY: `handle` is a valid job handle that nothing else owns.
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            return Err(std::io::Error::other(error.to_string()));
        }

        Ok(Self { handle })
    }

    #[cfg(not(windows))]
    pub fn create() -> Result<Self, std::io::Error> {
        Ok(Self {})
    }

    /// Adds an already-running process to the job. Called immediately after
    /// spawn; a child that exits before this lands simply fails the call,
    /// which is not fatal — the supervisor's own kill path still applies.
    #[cfg(windows)]
    pub fn assign(&self, pid: u32) -> Result<(), std::io::Error> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        // SAFETY: opening a process by id with the two rights the job needs.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) }
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        // SAFETY: both handles are valid and owned locally.
        let result = unsafe { AssignProcessToJobObject(self.handle, process) };
        // SAFETY: the process handle is no longer needed; job membership
        // survives closing it.
        let _ = unsafe { CloseHandle(process) };
        result.map_err(|error| std::io::Error::other(error.to_string()))
    }

    #[cfg(not(windows))]
    pub fn assign(&self, _pid: u32) -> Result<(), std::io::Error> {
        Ok(())
    }

    /// Kills every process still in the job. Used as the force path once the
    /// graceful shutdown grace period expires.
    #[cfg(windows)]
    pub fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: `self.handle` is a valid job handle for the job's lifetime.
        let _ = unsafe { TerminateJobObject(self.handle, 1) };
    }

    #[cfg(not(windows))]
    pub fn terminate(&self) {}
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            // Closing the last handle triggers KILL_ON_JOB_CLOSE.
            // SAFETY: the handle is valid and owned exclusively by `self`.
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creating_and_dropping_a_job_is_infallible_on_this_host() {
        let job = ProcessJob::create().expect("creates a job");
        // Assigning a pid that cannot exist must fail on Windows and no-op
        // elsewhere; either way it must not panic or poison the job.
        let _ = job.assign(u32::MAX);
        drop(job);
    }
}
