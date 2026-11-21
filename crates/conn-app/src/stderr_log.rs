//! Prints GPUI's warnings and errors to stderr. GPUI reports dropped frames, failed draws and
//! similar problems only through the `log` facade, which stays silent without a logger.

struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}: {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLog = StderrLog;

/// Installs the logger once at startup. A second call (or another logger) is ignored.
pub(crate) fn install() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}
