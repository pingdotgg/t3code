//! What scrollback keeps of the output. Live output goes to viewers unchanged; history drops
//! terminal *queries* (cursor position, device attributes, colour queries, ...), because a
//! client replaying history would answer them again and type the replies into the shell.
//! The rules follow `sanitizeTerminalHistoryChunk` in `apps/server/src/terminal/Manager.ts`.

const ESC: u8 = 0x1b;
const ST_C1: char = '\u{9c}';
/// An unterminated sequence longer than this is kept as text instead of buffered further.
const MAX_PENDING: usize = 4096;

/// Strips queries from a stream of output, carrying a sequence split across chunks.
#[derive(Debug, Default)]
pub(crate) struct HistoryFilter {
    pending: String,
}

impl HistoryFilter {
    pub(crate) fn reset(&mut self) {
        self.pending = String::new();
    }

    /// The part of `data` history keeps. An incomplete trailing sequence waits for the next
    /// chunk.
    pub(crate) fn filter(&mut self, data: &str) -> String {
        if self.pending.is_empty() && !data.as_bytes().contains(&ESC) {
            return data.to_owned();
        }
        let mut input = std::mem::take(&mut self.pending);
        input.push_str(data);
        let bytes = input.as_bytes();
        let mut out = String::with_capacity(input.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != ESC {
                let next = bytes[i..]
                    .iter()
                    .position(|&b| b == ESC)
                    .map_or(bytes.len(), |p| i + p);
                out.push_str(&input[i..next]);
                i = next;
                continue;
            }
            match sequence_end(&input, i) {
                None => {
                    if input.len() - i > MAX_PENDING {
                        out.push_str(&input[i..]);
                    } else {
                        self.pending = input[i..].to_owned();
                    }
                    return out;
                }
                Some((end, strip)) => {
                    if !strip {
                        out.push_str(&input[i..end]);
                    }
                    i = end;
                }
            }
        }
        out
    }
}

/// Where the sequence starting with ESC at `start` ends, and whether history drops it.
/// `None` when the input ends inside it.
fn sequence_end(input: &str, start: usize) -> Option<(usize, bool)> {
    let bytes = input.as_bytes();
    let kind = *bytes.get(start + 1)?;
    match kind {
        b'[' => {
            for (offset, &b) in bytes[start + 2..].iter().enumerate() {
                let at = start + 2 + offset;
                let cancelled = b == 0x18 || b == 0x1a;
                if cancelled || (0x40..=0x7e).contains(&b) {
                    let body = &input[start + 2..at];
                    return Some((at + 1, !cancelled && strip_csi(body, b)));
                }
            }
            None
        }
        b']' | b'P' | b'^' | b'_' => {
            let end = string_end(input, start + 2)?;
            let content = strip_terminator(&input[start + 2..end]);
            let strip = match kind {
                b']' => strip_osc(content),
                b'P' => strip_dcs(content),
                _ => false,
            };
            Some((end, strip))
        }
        _ => {
            let mut cursor = start + 1;
            while cursor < bytes.len() && (0x20..=0x2f).contains(&bytes[cursor]) {
                cursor += 1;
            }
            let b = *bytes.get(cursor)?;
            // A second ESC starts the next sequence.
            let end = if b == ESC {
                cursor
            } else if (0x30..=0x7e).contains(&b) {
                cursor + 1
            } else {
                start + 1
            };
            Some((end, false))
        }
    }
}

/// End of an OSC/DCS/PM/APC string: after BEL, C1 ST, CAN or SUB, after `ESC \`, or at an
/// ESC that starts something else (as xterm.js does).
fn string_end(input: &str, from: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            0x07 | 0x18 | 0x1a => return Some(i + 1),
            ESC => {
                let next = *bytes.get(i + 1)?;
                return Some(if next == b'\\' { i + 2 } else { i });
            }
            // U+009C, the C1 string terminator, in UTF-8.
            0xc2 if bytes.get(i + 1) == Some(&0x9c) => return Some(i + 2),
            _ => i += 1,
        }
    }
    None
}

fn strip_terminator(value: &str) -> &str {
    value
        .strip_suffix("\u{1b}\\")
        .or_else(|| value.strip_suffix('\u{7}'))
        .or_else(|| value.strip_suffix(ST_C1))
        .unwrap_or(value)
}

fn all(body: &str, allowed: &[u8]) -> bool {
    body.bytes()
        .all(|b| b.is_ascii_digit() || allowed.contains(&b))
}

fn strip_csi(body: &str, last: u8) -> bool {
    match last {
        b'n' => true,
        b'R' => all(body, b";?"),
        b'c' => all(body, b">=;?"),
        // DECRQM queries; setters have no `$`.
        b'p' | b'y' => body.strip_suffix('$').is_some_and(|rest| all(rest, b";?")),
        // XTVERSION; DECSCUSR (` q`) stays.
        b'q' => body.strip_prefix('>').is_some_and(|rest| all(rest, b";")),
        // Kitty keyboard query; restore-cursor (bare `u`) stays.
        b'u' => body.starts_with('?'),
        _ => false,
    }
}

/// DECRQSS and XTGETTCAP.
fn strip_dcs(content: &str) -> bool {
    let rest = content
        .strip_prefix('0')
        .or_else(|| content.strip_prefix('1'))
        .unwrap_or(content);
    let mut chars = rest.chars();
    matches!(chars.next(), Some('$' | '+')) && matches!(chars.next(), Some('q' | 'r'))
}

/// Foreground, background and cursor colour queries and their replies.
fn strip_osc(content: &str) -> bool {
    ["10;", "11;", "12;"].iter().any(|p| {
        content
            .strip_prefix(p)
            .is_some_and(|rest| rest.starts_with('?') || rest.starts_with("rgb:"))
    })
}

/// Sent after history read from disk: leaves an alternate screen the old shell left open, and
/// turns off the input modes (mouse, bracketed paste, Kitty keyboard) a dead program set, so
/// the new shell does not receive their reports. Same bytes as `INHERITED_INPUT_RESET`.
pub(crate) const INHERITED_INPUT_RESET: &str = concat!(
    "\u{1b}[?1049h\u{1b}[<100u\u{1b}[=0;1u\u{1b}[?1049l",
    "\u{1b}[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l",
    "\u{1b}[?25;1035;1036h\u{1b}[<100u\u{1b}[=0;1u\u{1b}[>4m",
);

/// The suffix that makes inherited history safe to replay ahead of a new shell.
pub(crate) fn inherited_suffix(history: &str) -> String {
    if !history.as_bytes().contains(&ESC) {
        return String::new();
    }
    let mut alternate: Option<u32> = None;
    let bytes = history.as_bytes();
    let mut i = 0;
    while let Some(p) = bytes[i..].iter().position(|&b| b == ESC) {
        let at = i + p;
        i = at + 1;
        if bytes.get(at + 1) == Some(&b'c') {
            alternate = None;
            continue;
        }
        if !history[at + 1..].starts_with("[?") {
            continue;
        }
        let params_start = at + 3;
        let params_len = bytes[params_start..]
            .iter()
            .take_while(|b| b.is_ascii_digit() || **b == b';')
            .count();
        let end = params_start + params_len;
        let set = match bytes.get(end) {
            Some(b'h') => true,
            Some(b'l') => false,
            _ => continue,
        };
        if params_len == 0 {
            continue;
        }
        for mode in history[params_start..end].split(';') {
            if let Ok(mode @ (47 | 1047 | 1049)) = mode.parse::<u32>() {
                alternate = if set { alternate.or(Some(mode)) } else { None };
            }
        }
    }
    let leave = alternate.map_or_else(String::new, |mode| format!("\u{1b}7\u{1b}[?{mode}l"));
    format!("{leave}{INHERITED_INPUT_RESET}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> String {
        let mut filter = HistoryFilter::default();
        chunks.iter().map(|c| filter.filter(c)).collect()
    }

    #[test]
    fn strips_queries_and_keeps_everything_else() {
        let keep =
            "a\u{1b}[31mred\u{1b}[0m\u{1b}[2 q\u{1b}[u\u{1b}]0;title\u{7}\u{1b}=\u{1b}[?2004h";
        assert_eq!(run(&[keep]), keep);
        let queries = concat!(
            "\u{1b}[6n",
            "\u{1b}[12;40R",
            "\u{1b}[>c",
            "\u{1b}[?25$p",
            "\u{1b}[>q",
            "\u{1b}[?u",
            "\u{1b}]11;?\u{7}",
            "\u{1b}]10;rgb:ffff/ffff/ffff\u{1b}\\",
            "\u{1b}P$qm\u{1b}\\",
            "\u{1b}P+q544e\u{1b}\\",
        );
        assert_eq!(run(&["x", queries, "y"]), "xy");
    }

    #[test]
    fn carries_sequences_split_across_chunks() {
        assert_eq!(run(&["a\u{1b}", "[6", "nb"]), "ab");
        assert_eq!(run(&["a\u{1b}]11;", "?\u{1b}", "\\b"]), "ab");
        assert_eq!(run(&["a\u{1b}[3", "1mb"]), "a\u{1b}[31mb");
        // Multibyte text inside a string sequence, and the C1 terminator.
        let title = "\u{1b}]0;caf\u{e9} \u{1f600}\u{9c}x";
        assert_eq!(run(&[title]), title);
        assert_eq!(
            run(&["\u{1b}]0;\u{e9}", "\u{e9}\u{7}y"]),
            "\u{1b}]0;\u{e9}\u{e9}\u{7}y"
        );
        // CAN cancels a CSI; its text stays.
        assert_eq!(run(&["\u{1b}[6\u{18}x"]), "\u{1b}[6\u{18}x");
    }

    #[test]
    fn leaves_an_open_alternate_screen() {
        assert_eq!(inherited_suffix("plain"), "");
        assert_eq!(inherited_suffix("\u{1b}[1m"), INHERITED_INPUT_RESET);
        let open = inherited_suffix("\u{1b}[?1049hvim");
        assert_eq!(open, format!("\u{1b}7\u{1b}[?1049l{INHERITED_INPUT_RESET}"));
        assert_eq!(
            inherited_suffix("\u{1b}[?1049hvim\u{1b}[?1049l"),
            INHERITED_INPUT_RESET
        );
    }
}
