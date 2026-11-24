//! A time string read as T3 reads one with Effect's `DateTime.make`: JavaScript's `Date.parse`
//! (V8's `DateParser`, `src/date/dateparser*.{h,cc}` and `ParseDateTimeString` in
//! `src/date/date.cc`), after Effect appends `Z` to a string it finds no zone in.
//!
//! The port keeps V8's steps and names, so a reader can hold the two side by side. A time
//! without a zone is local: the caller gives the local offset, as V8 asks ICU for it.
//!
//! Porting notes:
//! - Mapping: `DateParser::Parse` is `parse`, `ParseES5DateTime` `parse_es5_date_time`,
//!   the composers and `KeywordTable` keep their names; `ParseDateTimeString` with `MakeDay`,
//!   `MakeTime` and `TimeClip` is [`date_parse`]; Effect's `makeUnsafe` with `hasZone` is
//!   [`effect_date_time_make`].
//! - Kept quirks: V8 reads UTF-16 units and stops at a NUL; a day composer reads its count
//!   after filling it, so `"12"` is 2001-12-01; time-zone offsets overflow as V8's unsigned
//!   32-bit sum does, against 32-bit Smis (Node builds V8 without pointer compression).
//! - Proof: `conn-engine`'s `date_input_matches_t3s` holds T3's own answers for each string of
//!   `tools/gen-date-cases.mjs` in five zones.

/// Milliseconds since the epoch of `text` as Effect's `DateTime.make(text)` gives it, or `None`
/// where that is `Option.none()`. `local_offset_ms(t)` is the local zone's offset in
/// milliseconds at the local time `t` (milliseconds of the local calendar since 1970-01-01),
/// with a skipped time read before the gap and a repeated one at its first occurrence.
pub fn effect_date_time_make(text: &str, local_offset_ms: impl Fn(i64) -> i64) -> Option<i64> {
    if has_zone(text) {
        date_parse(text, local_offset_ms)
    } else {
        date_parse(&format!("{text}Z"), local_offset_ms)
    }
}

/// Effect's `hasZone`: `/Z|GMT|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/` or `/z$|gmt$/i`.
fn has_zone(text: &str) -> bool {
    let bytes = text.as_bytes();
    let tail = |n: usize| bytes.len().checked_sub(n).and_then(|at| bytes.get(at..));
    let sign_digits = |part: Option<&[u8]>| {
        part.is_some_and(|p| {
            p.split_first().is_some_and(|(sign, digits)| {
                matches!(sign, b'+' | b'-') && digits.iter().all(u8::is_ascii_digit)
            })
        })
    };
    let colon_offset = tail(6).is_some_and(|p| {
        matches!(p.first(), Some(b'+' | b'-'))
            && p.get(3) == Some(&b':')
            && [1, 2, 4, 5]
                .iter()
                .all(|&i| p.get(i).is_some_and(u8::is_ascii_digit))
    });
    text.contains('Z')
        || text.contains("GMT")
        || sign_digits(tail(3))
        || sign_digits(tail(5))
        || colon_offset
        || text.ends_with(']')
        || text.ends_with('z')
        || tail(3).is_some_and(|p| p.eq_ignore_ascii_case(b"gmt"))
}

/// `Date.parse(text)`: milliseconds since the epoch, or `None` for `NaN`.
pub fn date_parse(text: &str, local_offset_ms: impl Fn(i64) -> i64) -> Option<i64> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let out = parse(&units)?;
    let day = make_day(out.year, out.month, out.day)?;
    let time = i64::from(out.hour) * 3_600_000
        + i64::from(out.minute) * 60_000
        + i64::from(out.second) * 1000
        + i64::from(out.millisecond);
    let mut date = day * MS_PER_DAY + time;
    match out.utc_offset {
        None => {
            if !(-MAX_TIME_BEFORE_UTC_MS..=MAX_TIME_BEFORE_UTC_MS).contains(&date) {
                return None;
            }
            date -= local_offset_ms(date);
        }
        Some(seconds) => date -= i64::from(seconds) * 1000,
    }
    (-MAX_TIME_MS..=MAX_TIME_MS).contains(&date).then_some(date)
}

const MS_PER_DAY: i64 = 86_400_000;
/// `DateCache::kMaxTimeInMs`.
const MAX_TIME_MS: i64 = 864_000_000 * 10_000_000;
/// `DateCache::kMaxTimeBeforeUTCInMs`: `kMaxTimeInMs` plus 30 days.
const MAX_TIME_BEFORE_UTC_MS: i64 = MAX_TIME_MS + MS_PER_DAY * 30;
/// `kNone`: a missing value.
const NONE: i32 = i32::MAX;
/// `kMaxSignificantDigits`: digits after it are read but not counted.
const MAX_SIGNIFICANT_DIGITS: usize = 9;
/// `Smi::kMaxValue` with 32-bit Smis, as Node's V8 builds them (no pointer compression).
const SMI_MAX: u32 = i32::MAX as u32;

/// `MakeDay` with V8's range check (`kMinYear`, `kMaxYear`); the month is 0 to 11 here.
fn make_day(year: i32, month: i32, date: i32) -> Option<i64> {
    if !(-1_000_000..=1_000_000).contains(&year) {
        return None;
    }
    let y = i64::from(year);
    let m = usize::try_from(month).ok()?;
    const YEAR_DELTA: i64 = 399_999;
    let days = |y: i64| {
        let y = y + YEAR_DELTA;
        365 * y + y / 4 - y / 100 + y / 400
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let from_month: [i64; 12] = if leap {
        [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
    } else {
        [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    };
    Some(days(y) - days(1970) + from_month.get(m)? - 1 + i64::from(date))
}

/// The parser's output (`DateParser::OUTPUT_SIZE` slots); `utc_offset` in seconds.
struct Output {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millisecond: i32,
    utc_offset: Option<i32>,
}

fn between(x: i32, lo: i32, hi: i32) -> bool {
    (lo..=hi).contains(&x)
}

/// ECMAScript `WhiteSpace` (`IsWhiteSpace`): TAB, VT, FF, ZWNBSP and the `Zs` category.
fn is_white_space(c: u32) -> bool {
    matches!(
        c,
        0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `IsWhiteSpaceOrLineTerminator`: also LF, CR, LS and PS.
fn is_white_space_or_line_terminator(c: u32) -> bool {
    is_white_space(c) || matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// `InputReader`: one UTF-16 unit at a time; a NUL ends the input, as in V8.
struct InputReader<'a> {
    index: usize,
    buffer: &'a [u16],
    ch: u32,
}

impl<'a> InputReader<'a> {
    fn new(buffer: &'a [u16]) -> Self {
        let mut reader = Self {
            index: 0,
            buffer,
            ch: 0,
        };
        reader.next();
        reader
    }

    fn next(&mut self) {
        self.ch = self.buffer.get(self.index).map_or(0, |&u| u32::from(u));
        self.index += 1;
    }

    fn position(&self) -> usize {
        self.index
    }

    fn read_unsigned_numeral(&mut self) -> i32 {
        let mut n: i32 = 0;
        let mut i = 0;
        while self.ch == u32::from(b'0') {
            self.next();
        }
        while self.is_ascii_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                // At most nine digits: below `i32::MAX`.
                n = n * 10 + (self.ch - u32::from(b'0')) as i32;
            }
            i += 1;
            self.next();
        }
        n
    }

    fn read_word(&mut self, prefix: &mut [u32; 3]) -> usize {
        let mut len = 0;
        while self.is_ascii_alpha_or_above() && !self.is_white_space_char() {
            if let Some(slot) = prefix.get_mut(len) {
                *slot = self.ch | 0x20;
            }
            self.next();
            len += 1;
        }
        for slot in prefix.iter_mut().skip(len) {
            *slot = 0;
        }
        len
    }

    fn skip(&mut self, c: u8) -> bool {
        if self.ch == u32::from(c) {
            self.next();
            return true;
        }
        false
    }

    fn skip_white_space(&mut self) -> bool {
        if is_white_space_or_line_terminator(self.ch) {
            self.next();
            return true;
        }
        false
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch != 0) {
                break;
            }
        }
        true
    }

    fn is_end(&self) -> bool {
        self.ch == 0
    }

    fn is_ascii_digit(&self) -> bool {
        (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
    }

    fn is_ascii_alpha_or_above(&self) -> bool {
        self.ch >= u32::from(b'A')
    }

    fn is_white_space_char(&self) -> bool {
        is_white_space(self.ch)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum KeywordType {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy)]
enum Token {
    Invalid,
    Unknown,
    Number {
        value: i32,
        length: usize,
    },
    Symbol(u8),
    WhiteSpace,
    EndOfInput,
    Keyword {
        kind: KeywordType,
        value: i32,
        length: usize,
    },
}

impl Token {
    fn is_number(self) -> bool {
        matches!(self, Token::Number { .. })
    }
    fn number(self) -> i32 {
        match self {
            Token::Number { value, .. } => value,
            _ => 0,
        }
    }
    fn length(self) -> usize {
        match self {
            Token::Number { length, .. } | Token::Keyword { length, .. } => length,
            Token::Symbol(_) | Token::Unknown => 1,
            _ => 0,
        }
    }
    fn is_symbol(self, c: u8) -> bool {
        matches!(self, Token::Symbol(s) if s == c)
    }
    fn is_fixed_length_number(self, length: usize) -> bool {
        matches!(self, Token::Number { length: l, .. } if l == length)
    }
    fn is_ascii_sign(self) -> bool {
        self.is_symbol(b'-') || self.is_symbol(b'+')
    }
    fn ascii_sign(self) -> i32 {
        if self.is_symbol(b'-') { -1 } else { 1 }
    }
    fn is_keyword_type(self, kind: KeywordType) -> bool {
        matches!(self, Token::Keyword { kind: k, .. } if k == kind)
    }
    fn is_keyword_z(self) -> bool {
        matches!(
            self,
            Token::Keyword {
                kind: KeywordType::TimeZoneName,
                length: 1,
                value: 0
            }
        )
    }
}

/// `KeywordTable`: a three-letter lower-case prefix, its kind and value.
const KEYWORDS: [([u8; 3], KeywordType, i32); 27] = [
    (*b"jan", KeywordType::MonthName, 1),
    (*b"feb", KeywordType::MonthName, 2),
    (*b"mar", KeywordType::MonthName, 3),
    (*b"apr", KeywordType::MonthName, 4),
    (*b"may", KeywordType::MonthName, 5),
    (*b"jun", KeywordType::MonthName, 6),
    (*b"jul", KeywordType::MonthName, 7),
    (*b"aug", KeywordType::MonthName, 8),
    (*b"sep", KeywordType::MonthName, 9),
    (*b"oct", KeywordType::MonthName, 10),
    (*b"nov", KeywordType::MonthName, 11),
    (*b"dec", KeywordType::MonthName, 12),
    (*b"am\0", KeywordType::AmPm, 0),
    (*b"pm\0", KeywordType::AmPm, 12),
    (*b"ut\0", KeywordType::TimeZoneName, 0),
    (*b"utc", KeywordType::TimeZoneName, 0),
    (*b"z\0\0", KeywordType::TimeZoneName, 0),
    (*b"gmt", KeywordType::TimeZoneName, 0),
    (*b"cdt", KeywordType::TimeZoneName, -5),
    (*b"cst", KeywordType::TimeZoneName, -6),
    (*b"edt", KeywordType::TimeZoneName, -4),
    (*b"est", KeywordType::TimeZoneName, -5),
    (*b"mdt", KeywordType::TimeZoneName, -6),
    (*b"mst", KeywordType::TimeZoneName, -7),
    (*b"pdt", KeywordType::TimeZoneName, -7),
    (*b"pst", KeywordType::TimeZoneName, -8),
    (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

/// `KeywordTable::Lookup`: a word longer than its keyword matches only a month name.
fn lookup(prefix: &[u32; 3], len: usize) -> (KeywordType, i32) {
    for (word, kind, value) in KEYWORDS {
        let same = word.iter().zip(prefix).all(|(&w, &p)| u32::from(w) == p);
        if same && (len <= 3 || kind == KeywordType::MonthName) {
            return (kind, value);
        }
    }
    (KeywordType::Invalid, 0)
}

/// `DateStringTokenizer`: one token of look-ahead.
struct Tokenizer<'a> {
    input: InputReader<'a>,
    next: Token,
}

impl<'a> Tokenizer<'a> {
    fn new(buffer: &'a [u16]) -> Self {
        let mut input = InputReader::new(buffer);
        let next = scan(&mut input);
        Self { input, next }
    }

    fn next(&mut self) -> Token {
        let result = self.next;
        self.next = scan(&mut self.input);
        result
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn skip_symbol(&mut self, c: u8) -> bool {
        if self.next.is_symbol(c) {
            self.next = scan(&mut self.input);
            return true;
        }
        false
    }
}

fn scan(input: &mut InputReader<'_>) -> Token {
    let pre_pos = input.position();
    if input.is_end() {
        return Token::EndOfInput;
    }
    if input.is_ascii_digit() {
        let value = input.read_unsigned_numeral();
        return Token::Number {
            value,
            length: input.position() - pre_pos,
        };
    }
    for c in *b":-+.)" {
        if input.skip(c) {
            return Token::Symbol(c);
        }
    }
    if input.is_ascii_alpha_or_above() && !input.is_white_space_char() {
        let mut prefix = [0; 3];
        let length = input.read_word(&mut prefix);
        let (kind, value) = lookup(&prefix, length);
        return Token::Keyword {
            kind,
            value,
            length,
        };
    }
    if input.skip_white_space() {
        return Token::WhiteSpace;
    }
    if input.skip_parentheses() {
        return Token::Unknown;
    }
    input.next();
    Token::Unknown
}

/// `ReadMilliseconds`: the first three significant digits of the numeral.
fn read_milliseconds(token: Token) -> i32 {
    let mut number = token.number();
    let mut length = token.length();
    if length < 3 {
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        }
    } else if length > 3 {
        length = length.min(MAX_SIGNIFICANT_DIGITS);
        let mut factor = 1;
        loop {
            factor *= 10;
            length -= 1;
            if length <= 3 {
                break;
            }
        }
        number /= factor;
    }
    number
}

struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }
    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && between(n, 0, 59)
    }
    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    fn is_empty(&self) -> bool {
        self.hour == NONE
    }
    /// The offset in seconds; `Err` when it does not fit a Smi.
    fn write(&self) -> Result<Option<i32>, ()> {
        if self.sign == NONE {
            return Ok(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        // V8 computes this in unsigned 32-bit arithmetic.
        let total = (hour as u32)
            .wrapping_mul(3600)
            .wrapping_add((minute as u32).wrapping_mul(60));
        if total > SMI_MAX {
            return Err(());
        }
        let total = total as i32;
        Ok(Some(if self.sign < 0 { -total } else { total }))
    }
}

struct TimeComposer {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && between(n, 0, 59))
            || (self.index == 2 && between(n, 0, 59))
            || (self.index == 3 && between(n, 0, 999))
    }
    fn add(&mut self, n: i32) -> bool {
        match self.comp.get_mut(self.index) {
            Some(slot) => {
                *slot = n;
                self.index += 1;
                true
            }
            None => false,
        }
    }
    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.add(0) {}
        true
    }
    fn write(&mut self, out: &mut Output) -> bool {
        while self.add(0) {}
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return false;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        if (!between(hour, 0, 23)
            || !between(minute, 0, 59)
            || !between(second, 0, 59)
            || !between(millisecond, 0, 999))
            && (hour != 24 || minute != 0 || second != 0 || millisecond != 0)
        {
            return false;
        }
        out.hour = hour;
        out.minute = minute;
        out.second = second;
        out.millisecond = millisecond;
        true
    }
}

struct DayComposer {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn add(&mut self, n: i32) -> bool {
        match self.comp.get_mut(self.index) {
            Some(slot) => {
                *slot = n;
                self.index += 1;
                true
            }
            None => false,
        }
    }
    fn write(&mut self, out: &mut Output) -> bool {
        if self.index < 1 {
            return false;
        }
        // Missing parts default to 1. V8 reads the count after this fill, so it is always 3:
        // a single number with a named month is never read as a day alone.
        while self.add(1) {}
        let [c0, c1, c2] = self.comp;
        let (mut year, month, day) = if self.named_month == NONE {
            if self.is_iso_date || !between(c0, 1, 31) {
                (c0, c1, c2)
            } else {
                (c2, c0, c1)
            }
        } else if !between(c0, 1, 31) {
            (c0, self.named_month, c1)
        } else {
            (c1, self.named_month, c0)
        };
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !between(month, 1, 12) || !between(day, 1, 31) {
            return false;
        }
        out.year = year;
        out.month = month - 1;
        out.day = day;
        true
    }
}

/// `ParseES5DateTime`: the next token for the legacy parser, `EndOfInput` when the string was
/// a whole ES5 date-time, `Invalid` when it can be nothing.
fn parse_es5_date_time(
    scanner: &mut Tokenizer<'_>,
    day: &mut DayComposer,
    time: &mut TimeComposer,
    tz: &mut TimeZoneComposer,
) -> Token {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 12) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 1, 31)
            {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !scanner.peek().is_keyword_type(KeywordType::TimeSeparator) {
        if !matches!(scanner.peek(), Token::EndOfInput) {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return Token::Invalid;
        }
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !between(scanner.peek().number(), 0, 59)
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return Token::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !between(scanner.peek().number(), 0, 59)
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_symbol(b'+') || scanner.peek().is_symbol(b'-') {
            tz.set_sign(if scanner.next().is_symbol(b'+') {
                1
            } else {
                -1
            });
            if scanner.peek().is_fixed_length_number(4) {
                let hourmin = scanner.next().number();
                let (hour, min) = (hourmin / 100, hourmin % 100);
                if !between(hour, 0, 23) || !between(min, 0, 59) {
                    return Token::Invalid;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                if !scanner.peek().is_fixed_length_number(2)
                    || !between(scanner.peek().number(), 0, 23)
                {
                    return Token::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return Token::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2)
                    || !between(scanner.peek().number(), 0, 59)
                {
                    return Token::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if !matches!(scanner.peek(), Token::EndOfInput) {
            return Token::Invalid;
        }
    }
    // A date-only form without a zone is UTC; a date-time form is local.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    Token::EndOfInput
}

/// `DateParser::Parse`.
fn parse(units: &[u16]) -> Option<Output> {
    let mut scanner = Tokenizer::new(units);
    let mut tz = TimeZoneComposer {
        sign: NONE,
        hour: NONE,
        minute: NONE,
    };
    let mut time = TimeComposer {
        comp: [0; 4],
        index: 0,
        hour_offset: NONE,
    };
    let mut day = DayComposer {
        comp: [0; 3],
        index: 0,
        named_month: NONE,
        is_iso_date: false,
    };
    let next_unhandled = parse_es5_date_time(&mut scanner, &mut day, &mut time, &mut tz);
    if matches!(next_unhandled, Token::Invalid) {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    let mut token = next_unhandled;
    while !matches!(token, Token::EndOfInput) {
        match token {
            Token::Number { value: n, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    let ms = read_milliseconds(scanner.next());
                    if ms < 0 {
                        return None;
                    }
                    time.add_final(ms);
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    let peek = scanner.peek();
                    if !matches!(peek, Token::EndOfInput | Token::WhiteSpace)
                        && !peek.is_keyword_z()
                        && !peek.is_ascii_sign()
                    {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == KeywordType::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == KeywordType::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol(b'-');
                } else if kind == KeywordType::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    if has_read_number {
                        return None;
                    }
                    if scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            _ if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
                tz.set_sign(token.ascii_sign());
                let mut n = 0;
                let mut length = 0;
                if scanner.peek().is_number() {
                    let next_token = scanner.next();
                    length = next_token.length();
                    n = next_token.number();
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 2 || length == 1 {
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 4 || length == 3 {
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return None;
                }
            }
            _ if (token.is_ascii_sign() || token.is_symbol(b')')) && has_read_number => {
                return None;
            }
            _ => {}
        }
        token = scanner.next();
    }
    let mut out = Output {
        year: 0,
        month: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        utc_offset: None,
    };
    if !day.write(&mut out) || !time.write(&mut out) {
        return None;
    }
    out.utc_offset = tz.write().ok()?;
    Some(out)
}
