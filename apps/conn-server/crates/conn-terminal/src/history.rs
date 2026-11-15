//! Bounded scrollback and UTF-8 decoding of PTY bytes.

/// The tail of a terminal's output: at most `cap` bytes (cut at a code point boundary) and
/// about `max_lines` lines.
#[derive(Debug, Default)]
pub(crate) struct History {
    text: String,
    cap: usize,
    max_lines: usize,
    newlines: usize,
}

impl History {
    pub(crate) fn new(cap: usize, max_lines: usize) -> Self {
        Self {
            text: String::new(),
            cap,
            max_lines,
            newlines: 0,
        }
    }

    pub(crate) fn push(&mut self, data: &str) {
        self.text.push_str(data);
        self.newlines += count_newlines(data);
        // Trim with slack so a busy terminal copies the buffer once per quarter of the cap,
        // not once per read.
        if self.text.len() > self.cap + self.cap / 4
            || self.newlines > self.max_lines + self.max_lines / 4
        {
            let mut start = tail_start(&self.text, self.cap);
            let lines = count_newlines(&self.text[start..]);
            if lines > self.max_lines {
                let drop = lines - self.max_lines;
                let bytes = &self.text.as_bytes()[start..];
                let mut seen = 0;
                for (i, b) in bytes.iter().enumerate() {
                    if *b == b'\n' {
                        seen += 1;
                        if seen == drop {
                            start += i + 1;
                            break;
                        }
                    }
                }
            }
            self.text.drain(..start);
            self.newlines = count_newlines(&self.text);
            self.text.shrink_to(self.cap + self.cap / 4);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.text = String::new();
        self.newlines = 0;
    }

    /// The last `max` bytes (all of it when `max` is `None`), at most `cap`.
    pub(crate) fn tail(&self, max: Option<usize>) -> &str {
        let max = max.unwrap_or(usize::MAX).min(self.cap);
        &self.text[tail_start(&self.text, max)..]
    }
}

fn count_newlines(text: &str) -> usize {
    text.bytes().filter(|b| *b == b'\n').count()
}

/// Where the last `max` bytes of `text` start, moved forward to a char boundary.
pub(crate) fn tail_start(text: &str, max: usize) -> usize {
    if text.len() <= max {
        return 0;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    start
}

/// Decodes a byte stream as UTF-8 across reads: a code point split between two reads is held
/// back until its rest arrives; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> String {
        let joined;
        let input: &[u8] = if self.pending.is_empty() {
            bytes
        } else {
            self.pending.extend_from_slice(bytes);
            joined = std::mem::take(&mut self.pending);
            &joined
        };
        let keep = incomplete_suffix(input);
        let (complete, rest) = input.split_at(input.len() - keep);
        self.pending.extend_from_slice(rest);
        String::from_utf8_lossy(complete).into_owned()
    }

    /// What is left when the stream ends.
    pub(crate) fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

/// Length of a trailing, possibly valid but unfinished UTF-8 sequence (0 to 3 bytes).
fn incomplete_suffix(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let need = match byte {
            0b1100_0000..=0b1101_1111 => 2,
            0b1110_0000..=0b1110_1111 => 3,
            0b1111_0000..=0b1111_0111 => 4,
            _ => return 0,
        };
        return if need > back { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_tail_at_a_char_boundary() {
        let mut history = History::new(8, 100);
        history.push("abcdef");
        history.push("ghij€");
        assert!(history.tail(None).len() <= 8);
        assert!(history.tail(None).ends_with("ghij€"));
        assert_eq!(history.tail(Some(4)), "j€");
        assert_eq!(history.tail(Some(3)), "€");
        assert_eq!(history.tail(Some(2)), "");
        for _ in 0..100 {
            history.push("0123456789");
        }
        assert!(history.tail(None).len() <= 10);
        history.clear();
        assert_eq!(history.tail(None), "");
    }

    #[test]
    fn keeps_about_max_lines() {
        let mut history = History::new(1 << 20, 10);
        for i in 0..100 {
            history.push(&format!("line {i}\n"));
        }
        let lines = history.tail(None).lines().count();
        assert!((10..=13).contains(&lines), "{lines}");
        assert!(history.tail(None).ends_with("line 99\n"));
    }

    #[test]
    fn decodes_code_points_split_across_reads() {
        let mut stream = Utf8Stream::default();
        let euro = "€".as_bytes();
        assert_eq!(stream.decode(&[b'a', euro[0]]), "a");
        assert_eq!(stream.decode(&euro[1..2]), "");
        assert_eq!(stream.decode(&[euro[2], b'b']), "€b");
        assert_eq!(stream.decode(&[0xff, b'c']), "\u{fffd}c");
        assert_eq!(stream.decode(&[0xe2]), "");
        assert_eq!(stream.finish(), "\u{fffd}");
    }
}
