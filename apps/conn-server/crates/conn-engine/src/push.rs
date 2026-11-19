//! Whether a shell command an agent ran pushes, as `PullRequestSyncReactor.ts` decides it
//! (`isPushCommand`): the script unwrapped from Codex's `sh -lc`, heredoc bodies, quoted
//! strings and comments removed, then a `git push` (or a stack tool's push) where a command
//! starts. A push makes the thread's pull request watches forget whether checks were running.

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `shellScript`: the script inside `[/path/](ba|z|da|k)?sh -[l]c <quoted pieces>`.
fn shell_script(input: &str) -> String {
    let trimmed = input.trim_start_matches(is_space);
    let word_end = trimmed.find(is_space).unwrap_or(trimmed.len());
    let word = trimmed.get(..word_end).unwrap_or_default();
    let name = word.rsplit('/').next().unwrap_or_default();
    if !matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh") {
        return input.to_owned();
    }
    let rest = trimmed.get(word_end..).unwrap_or_default();
    let after_space = rest.trim_start_matches(is_space);
    if after_space.len() == rest.len() {
        return input.to_owned();
    }
    let Some(after_flag) = after_space
        .strip_prefix("-lc")
        .or_else(|| after_space.strip_prefix("-c"))
    else {
        return input.to_owned();
    };
    let wrapped = after_flag.trim_start_matches(is_space);
    if wrapped.len() == after_flag.len() || !wrapped.starts_with(['"', '\'']) {
        return input.to_owned();
    }
    // `"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)`, pieces joined.
    let chars: Vec<char> = wrapped.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        match c {
            '"' => {
                let mut j = i + 1;
                let mut piece = String::new();
                let mut closed = false;
                while let Some(&d) = chars.get(j) {
                    if d == '"' {
                        closed = true;
                        break;
                    }
                    if d == '\\'
                        && let Some(&e) = chars.get(j + 1)
                    {
                        if matches!(e, '"' | '\\' | '$' | '`') {
                            piece.push(e);
                        } else {
                            piece.push(d);
                            piece.push(e);
                        }
                        j += 2;
                        continue;
                    }
                    piece.push(d);
                    j += 1;
                }
                if closed {
                    out.push_str(&piece);
                    i = j + 1;
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            '\'' => match chars
                .get(i + 1..)
                .and_then(|r| r.iter().position(|d| *d == '\''))
            {
                Some(end) => {
                    out.extend(chars.get(i + 1..i + 1 + end).unwrap_or_default());
                    i += end + 2;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            },
            '\\' if chars.get(i + 1).is_some() => {
                out.extend(chars.get(i + 1));
                i += 2;
            }
            c if is_space(c) => i += 1,
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `HEREDOC_BODY` → `<<`.
fn without_heredocs(script: &str) -> String {
    let chars: Vec<char> = script.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if let Some(end) = heredoc_at(&chars, i) {
            out.push_str("<<");
            i = end;
        } else {
            out.extend(chars.get(i));
            i += 1;
        }
    }
    out
}

fn heredoc_at(chars: &[char], start: usize) -> Option<usize> {
    let at = |i: usize| chars.get(i).copied();
    if at(start) != Some('<') || at(start + 1) != Some('<') {
        return None;
    }
    let mut i = start + 2;
    if at(i) == Some('-') {
        i += 1;
    }
    while matches!(at(i), Some(' ' | '\t')) {
        i += 1;
    }
    let quote = at(i).filter(|c| matches!(c, '\'' | '"'));
    if quote.is_some() {
        i += 1;
    }
    let word_start = i;
    while at(i).is_some_and(is_word) {
        i += 1;
    }
    if i == word_start {
        return None;
    }
    let word: String = chars.get(word_start..i)?.iter().collect();
    if let Some(q) = quote {
        if at(i) != Some(q) {
            return None;
        }
        i += 1;
    }
    while at(i).is_some_and(|c| c != '\n') {
        i += 1;
    }
    at(i)?;
    // The body: lines until one that is the word alone, else the rest of the script.
    let mut line_start = i + 1;
    loop {
        if line_start > chars.len() {
            return Some(chars.len());
        }
        let line_end = chars
            .get(line_start..)
            .and_then(|r| r.iter().position(|c| *c == '\n'))
            .map_or(chars.len(), |p| line_start + p);
        let line: String = chars.get(line_start..line_end)?.iter().collect();
        if line.trim_matches([' ', '\t']) == word {
            return Some(line_end);
        }
        if line_end >= chars.len() {
            return Some(chars.len());
        }
        line_start = line_end + 1;
    }
}

/// `QUOTED_OR_COMMENT` → `''`.
fn without_quotes(script: &str) -> String {
    let chars: Vec<char> = script.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        let end = match c {
            '\'' => chars
                .get(i + 1..)
                .and_then(|r| r.iter().position(|d| *d == '\''))
                .map(|p| i + 1 + p + 1),
            '"' => {
                let mut j = i + 1;
                let mut found = None;
                while let Some(&d) = chars.get(j) {
                    if d == '\\' && j + 1 < chars.len() {
                        j += 2;
                        continue;
                    }
                    if d == '"' {
                        found = Some(j + 1);
                        break;
                    }
                    j += 1;
                }
                found
            }
            '#' if i == 0
                || chars
                    .get(i - 1)
                    .is_some_and(|p| is_space(*p) || matches!(p, ';' | '&' | '|' | '(')) =>
            {
                Some(
                    chars
                        .get(i..)
                        .and_then(|r| r.iter().position(|d| *d == '\n'))
                        .map_or(chars.len(), |p| i + p),
                )
            }
            _ => None,
        };
        match end {
            Some(end) => {
                out.push_str("''");
                i = end;
            }
            None => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn skip_spaces(chars: &[char], mut i: usize) -> usize {
    while chars.get(i).copied().is_some_and(is_space) {
        i += 1;
    }
    i
}

/// `\s+` then `word`: the position after it.
fn spaced_word(chars: &[char], i: usize, word: &str) -> Option<usize> {
    let j = skip_spaces(chars, i);
    (j > i).then_some(())?;
    literal(chars, j, word)
}

fn literal(chars: &[char], i: usize, word: &str) -> Option<usize> {
    let mut j = i;
    for c in word.chars() {
        (chars.get(j) == Some(&c)).then_some(())?;
        j += 1;
    }
    Some(j)
}

/// `(?=$|[\s;&|)])`.
fn ends_word(chars: &[char], i: usize) -> bool {
    chars
        .get(i)
        .is_none_or(|c| is_space(*c) || matches!(c, ';' | '&' | '|' | ')'))
}

/// The push alternatives at `i`.
fn push_at(chars: &[char], i: usize) -> bool {
    if let Some(mut j) = literal(chars, i, "git") {
        loop {
            if let Some(end) = spaced_word(chars, j, "push")
                && ends_word(chars, end)
            {
                return true;
            }
            // `\s+-[cC]\s+\S+`
            let k = skip_spaces(chars, j);
            if k == j || chars.get(k) != Some(&'-') || !matches!(chars.get(k + 1), Some('c' | 'C'))
            {
                break;
            }
            let v = skip_spaces(chars, k + 2);
            if v == k + 2 || chars.get(v).is_none() {
                break;
            }
            let mut w = v;
            while chars.get(w).is_some_and(|c| !is_space(*c)) {
                w += 1;
            }
            j = w;
        }
    }
    let chain = |words: &[&str]| -> bool {
        let Some((first, rest)) = words.split_first() else {
            return false;
        };
        let mut j = match literal(chars, i, first) {
            Some(j) => j,
            None => return false,
        };
        for word in rest {
            match spaced_word(chars, j, word) {
                Some(next) => j = next,
                None => return false,
            }
        }
        ends_word(chars, j)
    };
    chain(&["gh", "stack", "push"])
        || chain(&["gh", "stack", "submit"])
        || chain(&["cafe", "stack", "submit"])
        || chain(&["jj", "git", "push"])
}

/// `\s*(?:(?:\w+=\S*|env|time|nohup|timeout\s+\S+)\s+)*` then a push.
fn command_at(chars: &[char], i: usize) -> bool {
    let mut j = skip_spaces(chars, i);
    loop {
        if push_at(chars, j) {
            return true;
        }
        // Each prefix alternative must be followed by `\s+`, as the regex backtracks.
        let mut candidates: Vec<usize> = Vec::new();
        let mut k = j;
        while chars.get(k).copied().is_some_and(is_word) {
            k += 1;
        }
        if k > j && chars.get(k) == Some(&'=') {
            k += 1;
            while chars.get(k).is_some_and(|c| !is_space(*c)) {
                k += 1;
            }
            candidates.push(k);
        }
        for word in ["env", "time", "nohup"] {
            candidates.extend(literal(chars, j, word));
        }
        if let Some(end) = literal(chars, j, "timeout") {
            let v = skip_spaces(chars, end);
            if v > end && chars.get(v).is_some() {
                let mut w = v;
                while chars.get(w).is_some_and(|c| !is_space(*c)) {
                    w += 1;
                }
                candidates.push(w);
            }
        }
        let Some(next) = candidates
            .into_iter()
            .map(|end| (end, skip_spaces(chars, end)))
            .find(|(end, next)| next > end)
            .map(|(_, next)| next)
        else {
            return false;
        };
        j = next;
    }
}

/// `isPushCommand`.
pub(crate) fn is_push_command(input: &str) -> bool {
    let code = without_quotes(&without_heredocs(&shell_script(input)));
    let chars: Vec<char> = code.chars().collect();
    if command_at(&chars, 0) {
        return true;
    }
    for i in 0..chars.len() {
        let c = chars.get(i).copied().unwrap_or(' ');
        if matches!(c, ';' | '&' | '|' | '(' | '{' | '`' | '\n') && command_at(&chars, i + 1) {
            return true;
        }
        let boundary = i == 0 || chars.get(i - 1).is_none_or(|p| !is_word(*p));
        if boundary {
            for word in ["do", "then", "else"] {
                if let Some(end) = literal(&chars, i, word)
                    && chars.get(end).copied().is_some_and(is_space)
                    && command_at(&chars, end + 1)
                {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::is_push_command;

    /// The inputs of T3's `PullRequestSyncReactor.test.ts` ("reopens a watch's checks when its
    /// thread's agent pushes", "a Codex shell wrapper after a push"), and more.
    #[test]
    fn pushes_are_told_apart_from_text_about_them() {
        for push in [
            "git push",
            "cd app && git -C . push --force-with-lease",
            "/bin/zsh -lc \"gh stack submit --auto\"",
            "/bin/zsh -lc \"git push -u origin feature 2>&1 | tail -2 && gh pr create --fill\"",
            "git -c user.name=x push origin HEAD",
            "GIT_TRACE=1 timeout 30 git push",
            "jj git push",
            "if true; then git push; fi",
            "bash -c 'git push'",
        ] {
            assert!(is_push_command(push), "{push}");
        }
        for other in [
            "git status && echo 'then git push'",
            "echo \"git push\"",
            "git pushx",
            "git status # git push",
            "cat <<EOF\ngit push\nEOF",
            "mygit push",
            "gh pr create --fill",
        ] {
            assert!(!is_push_command(other), "{other}");
        }
    }
}
