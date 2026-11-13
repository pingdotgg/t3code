//! Newline framing for a child's stdout with a per-line cap, so one runaway line cannot grow
//! memory without bound.

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// One framed line, or the size of a line that was dropped for being too long.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    Text(String),
    Oversized(usize),
}

/// Reads `\n`-framed lines until EOF. Blank lines are skipped; a line longer than `max_bytes`
/// is reported as [`Line::Oversized`]. A final line without a newline is dropped: the CLIs
/// always end their lines. Stops early when `sink` returns `false`.
pub async fn read_lines<F, Fut>(reader: impl AsyncRead + Unpin, max_bytes: usize, sink: F)
where
    F: FnMut(Line) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    frame(reader, max_bytes, false, sink).await;
}

/// [`read_lines`], but a final line without a newline is delivered too (stderr tails).
pub async fn read_lines_keeping_last<F, Fut>(
    reader: impl AsyncRead + Unpin,
    max_bytes: usize,
    sink: F,
) where
    F: FnMut(Line) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    frame(reader, max_bytes, true, sink).await;
}

/// The line buffer is released after a line longer than this.
const KEPT_BUFFER_BYTES: usize = 64 * 1024;

async fn frame<F, Fut>(
    reader: impl AsyncRead + Unpin,
    max_bytes: usize,
    keep_last: bool,
    mut sink: F,
) where
    F: FnMut(Line) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut line: Vec<u8> = Vec::new();
    let mut dropped = 0usize;
    while let Ok(buf) = reader.fill_buf().await {
        if buf.is_empty() {
            if keep_last {
                let item = if dropped > 0 {
                    Some(Line::Oversized(dropped))
                } else {
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    (!text.is_empty()).then(|| Line::Text(text.to_owned()))
                };
                if let Some(item) = item {
                    sink(item).await;
                }
            }
            break;
        }
        let (chunk, found_newline) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (&buf[..i], true),
            None => (buf, false),
        };
        let consumed = chunk.len() + usize::from(found_newline);
        if dropped > 0 || line.len() + chunk.len() > max_bytes {
            dropped += chunk.len() + line.len();
            line.clear();
        } else {
            line.extend_from_slice(chunk);
        }
        reader.consume(consumed);
        if !found_newline {
            continue;
        }
        let item = if dropped > 0 {
            Some(Line::Oversized(std::mem::take(&mut dropped)))
        } else {
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            (!text.is_empty()).then(|| Line::Text(text.to_owned()))
        };
        line.clear();
        // Release the big buffer after a large line instead of keeping it for the session.
        if line.capacity() > KEPT_BUFFER_BYTES {
            line = Vec::new();
        }
        if let Some(item) = item
            && !sink(item).await
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_utf8_and_a_final_line_survive_in_the_lossy_reader() {
        let input: &[u8] = b"ok\n\xff\xfe bad\nlast";
        let mut got = Vec::new();
        read_lines_keeping_last(input, 32, |line| {
            got.push(line);
            async { true }
        })
        .await;
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], Line::Text("ok".into()));
        assert!(matches!(&got[1], Line::Text(t) if t.ends_with("bad")));
        assert_eq!(got[2], Line::Text("last".into()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn frames_lines_and_drops_oversized_ones() {
        let input = format!("{{\"a\":1}}\n{}\n\n{{\"b\":2}}\n{{\"tail\"", "x".repeat(40));
        let mut got = Vec::new();
        read_lines(input.as_bytes(), 32, |line| {
            got.push(line);
            async { true }
        })
        .await;
        assert_eq!(
            got,
            vec![
                Line::Text("{\"a\":1}".into()),
                Line::Oversized(40),
                Line::Text("{\"b\":2}".into()),
            ]
        );
    }
}
