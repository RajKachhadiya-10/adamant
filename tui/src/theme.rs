use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Color;

/// Blank row, prompt, blank row. The status and hint lines sit under that bar.
pub const COMPOSER_ROWS: u16 = 3;
pub const FOOTER_ROWS: u16 = COMPOSER_ROWS + 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    /// Behind everything that is not a card. `Reset` is the terminal's own background, the
    /// only colour iTerm makes transparent and blurs.
    pub canvas: Color,
    /// The composer and each prompt in the transcript: opaque cards on the glass.
    pub bar: Color,
    pub ink: Color,
    pub muted: Color,
    pub dim: Color,
    pub hint: Color,
    pub key: Color,
    /// Yellow stands where the Codex product name is bold white.
    pub accent: Color,
    pub blue: Color,
    pub red: Color,
    pub green: Color,
    pub border: Color,
    pub select: Color,
    pub cursor: Color,
    /// The character under the cursor block.
    pub cursor_ink: Color,
    /// The peak of the highlight that sweeps across "Working".
    pub glow: Color,
}

pub const DARK: Palette = Palette {
    canvas: Color::Reset,
    bar: Color::Rgb(36, 36, 36),
    ink: Color::Rgb(230, 230, 230),
    muted: Color::Rgb(140, 140, 140),
    dim: Color::Rgb(110, 110, 110),
    hint: Color::Rgb(120, 120, 120),
    key: Color::Rgb(176, 176, 176),
    accent: Color::Rgb(250, 204, 21),
    blue: Color::Rgb(88, 166, 255),
    red: Color::Rgb(249, 117, 131),
    green: Color::Rgb(63, 185, 80),
    border: Color::Rgb(72, 72, 72),
    select: Color::Rgb(46, 46, 46),
    cursor: Color::Rgb(220, 220, 220),
    cursor_ink: Color::Rgb(0, 0, 0),
    glow: Color::Rgb(255, 255, 255),
};

/// Dark ink on a light background. Bright yellow is unreadable on #fafafa, so the accent
/// is a dark amber, and the sweep darkens toward black instead of lightening.
pub const LIGHT: Palette = Palette {
    canvas: Color::Reset,
    bar: Color::Rgb(236, 236, 236),
    ink: Color::Rgb(24, 24, 24),
    muted: Color::Rgb(108, 108, 108),
    dim: Color::Rgb(138, 138, 138),
    hint: Color::Rgb(124, 124, 124),
    key: Color::Rgb(64, 64, 64),
    accent: Color::Rgb(161, 98, 7),
    blue: Color::Rgb(9, 105, 218),
    red: Color::Rgb(207, 34, 46),
    green: Color::Rgb(26, 127, 55),
    border: Color::Rgb(208, 208, 208),
    select: Color::Rgb(222, 222, 222),
    cursor: Color::Rgb(48, 48, 48),
    cursor_ink: Color::Rgb(250, 250, 250),
    glow: Color::Rgb(16, 16, 16),
};

/// The opaque black canvas, for terminals without transparency (`ADAMANT_THEME=solid`).
pub const SOLID: Palette = Palette {
    canvas: Color::Rgb(0, 0, 0),
    ..DARK
};

/// How long the terminal gets to say what its background is.
const ASK_TIMEOUT: Duration = Duration::from_millis(150);

static CHOSEN: OnceLock<Palette> = OnceLock::new();

/// Called once at startup; a later call keeps the first choice.
pub fn init(palette: Palette) {
    let _ = CHOSEN.set(palette);
}

pub fn palette() -> Palette {
    overridden()
        .or_else(|| CHOSEN.get().copied())
        .unwrap_or(DARK)
}

#[cfg(not(test))]
fn overridden() -> Option<Palette> {
    None
}

#[cfg(test)]
thread_local! {
    static TEST_PALETTE: std::cell::Cell<Option<Palette>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn overridden() -> Option<Palette> {
    TEST_PALETTE.with(std::cell::Cell::get)
}

/// Each test runs on its own thread, so this never leaks into another test.
#[cfg(test)]
pub fn use_for_test(palette: Palette) {
    TEST_PALETTE.with(|cell| cell.set(Some(palette)));
}

/// Needs raw mode, and must run before anything else reads the input: the reply comes
/// back as input, and the key reader would type it into the composer. The flag is set
/// when the terminal did not answer in time, so an answer may still arrive.
pub fn detect() -> (Palette, bool) {
    let env = |name: &str| std::env::var(name).ok();
    let mut late = false;
    let palette = choose(
        env("ADAMANT_THEME").as_deref(),
        || {
            let reply = ask_terminal(ASK_TIMEOUT)?;
            late = !answered(&reply);
            parse_osc11(&reply).map(is_light)
        },
        env("COLORFGBG").as_deref(),
    );
    (palette, late)
}

/// How long after an unanswered query a reply is still expected.
const LATE_FOR: Duration = Duration::from_secs(10);

/// Drops an OSC 11 answer that comes after the wait, over a slow link. crossterm reads it
/// as Alt+], the characters of `11;rgb:…`, then Ctrl+G (BEL) or Alt+\ (ST).
pub struct LateReply {
    until: Option<Instant>,
    inside: bool,
}

impl LateReply {
    pub fn new(expected: bool) -> Self {
        Self {
            until: expected.then(|| Instant::now() + LATE_FOR),
            inside: false,
        }
    }

    /// Whether this key is part of the late answer.
    pub fn swallows(&mut self, key: &KeyEvent) -> bool {
        if self.until.is_none_or(|until| Instant::now() > until) {
            return false;
        }
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char(']') if alt => self.inside = true,
            _ if !self.inside => return false,
            KeyCode::Char('g') if ctrl => self.until = None,
            KeyCode::Char('\\') if alt => self.until = None,
            KeyCode::Char(ch)
                if !ctrl && !alt && (ch.is_ascii_hexdigit() || ";:/rgba".contains(ch)) => {}
            _ => {
                self.inside = false;
                return false;
            }
        }
        true
    }
}

/// `ADAMANT_THEME` first, then what the terminal says, then `COLORFGBG`, else dark.
/// `ask` runs only when the variable does not decide.
pub fn choose(
    theme: Option<&str>,
    ask: impl FnOnce() -> Option<bool>,
    colorfgbg: Option<&str>,
) -> Palette {
    match theme
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("light") => return LIGHT,
        Some("dark") => return DARK,
        Some("solid") => return SOLID,
        _ => {}
    }
    match ask().or_else(|| colorfgbg.and_then(light_from_colorfgbg)) {
        Some(true) => LIGHT,
        _ => DARK,
    }
}

/// rxvt's "fg;bg" (sometimes "fg;default;bg"). The last field is an ANSI colour index.
pub fn light_from_colorfgbg(value: &str) -> Option<bool> {
    match value.rsplit(';').next()?.trim().parse::<u8>().ok()? {
        0..=6 | 8 => Some(false),
        7 | 15 => Some(true),
        _ => None,
    }
}

/// The colour in an OSC 11 reply, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ST.
/// Each field has one to four hex digits.
pub fn parse_osc11(reply: &[u8]) -> Option<(u8, u8, u8)> {
    let text = std::str::from_utf8(reply).ok()?;
    let start = text.find("\x1b]11;")? + 5;
    let rest = &text[start..];
    let end = [rest.find('\x07'), rest.find("\x1b\\")]
        .into_iter()
        .flatten()
        .min()?;
    let body = &rest[..end];
    let fields = body
        .strip_prefix("rgb:")
        .or_else(|| body.strip_prefix("rgba:"))?;
    let mut channels = fields.split('/').map(channel);
    Some((channels.next()??, channels.next()??, channels.next()??))
}

/// Scales one to four hex digits to a byte: "f" and "ffff" are both 255.
fn channel(hex: &str) -> Option<u8> {
    if hex.is_empty() || hex.len() > 4 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    let max = (1u32 << (4 * hex.len())) - 1;
    Some(((value * 255 + max / 2) / max) as u8)
}

/// Rec. 709 luma, light past half.
pub fn is_light((r, g, b): (u8, u8, u8)) -> bool {
    let luma = 0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32;
    luma / 255.0 > 0.5
}

/// Every terminal answers DA1 (`ESC [ c`), and in order, so its reply ends the wait: a
/// terminal that ignores OSC 11 costs nothing, and none of the answer is left behind.
#[cfg(unix)]
fn ask_terminal(timeout: Duration) -> Option<Vec<u8>> {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    // Non-blocking, so a read the terminal does not answer can never hang startup.
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open("/dev/tty")
        .ok()?;
    tty.write_all(b"\x1b]11;?\x07\x1b[c").ok()?;
    tty.flush().ok()?;
    let reply = read_reply(tty.as_raw_fd(), timeout);
    if !answered(&reply) {
        // A slow answer would otherwise turn up in the composer as typed text.
        // SAFETY: tcflush only touches the queue of a descriptor this function owns.
        unsafe {
            libc::tcflush(tty.as_raw_fd(), libc::TCIFLUSH);
        }
    }
    Some(reply)
}

#[cfg(not(unix))]
fn ask_terminal(_timeout: Duration) -> Option<Vec<u8>> {
    None
}

/// Reads until the DA1 reply or the timeout, whichever comes first. select, not poll:
/// macOS's poll reports a terminal as invalid.
#[cfg(unix)]
fn read_reply(fd: std::os::fd::RawFd, timeout: Duration) -> Vec<u8> {
    let deadline = std::time::Instant::now() + timeout;
    let mut reply = Vec::new();
    let mut buf = [0u8; 256];
    if !(0..libc::FD_SETSIZE as std::os::fd::RawFd).contains(&fd) {
        return reply;
    }
    while !answered(&reply) {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        let mut wait = libc::timeval {
            tv_sec: left.as_secs() as libc::time_t,
            tv_usec: left.subsec_micros() as libc::suseconds_t,
        };
        // SAFETY: one descriptor below FD_SETSIZE, in a set that lives across the call.
        let ready = unsafe {
            let mut set: libc::fd_set = std::mem::zeroed();
            libc::FD_ZERO(&mut set);
            libc::FD_SET(fd, &mut set);
            libc::select(
                fd + 1,
                &mut set,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut wait,
            )
        };
        if ready < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 {
            break;
        }
        // SAFETY: reads at most buf.len() bytes into buf.
        let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
            continue;
        }
        if read <= 0 {
            break;
        }
        reply.extend_from_slice(&buf[..read as usize]);
    }
    reply
}

/// The reply holds DA1's answer, `ESC [ ? <digits and ;> c`.
fn answered(reply: &[u8]) -> bool {
    reply.windows(3).enumerate().any(|(at, window)| {
        window == b"\x1b[?"
            && reply[at + 3..]
                .iter()
                .find(|byte| !(byte.is_ascii_digit() || **byte == b';'))
                == Some(&b'c')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_four_and_two_digit_replies() {
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:fafa/fafa/fafa\x07"),
            Some((250, 250, 250))
        );
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?62;22c"),
            Some((0, 0, 0))
        );
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:ff/80/00\x1b\\"),
            Some((255, 128, 0))
        );
        assert_eq!(
            parse_osc11(b"\x1b]11;rgba:ffff/ffff/ffff/0000\x07"),
            Some((255, 255, 255))
        );
        assert_eq!(parse_osc11(b"\x1b]11;rgb:f/0/f\x07"), Some((255, 0, 255)));
    }

    #[test]
    fn rejects_garbage_and_a_missing_terminator() {
        assert_eq!(parse_osc11(b""), None);
        assert_eq!(parse_osc11(b"\x1b[?62;22c"), None);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:fafa/fafa/fafa"), None);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:zzzz/fafa/fafa\x07"), None);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:fafa/fafa\x07"), None);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:fffff/0/0\x07"), None);
        assert_eq!(parse_osc11(b"\x1b]11;?\x07"), None);
        assert_eq!(
            parse_osc11(&[0x1b, b']', b'1', b'1', b';', 0xff, 0x07]),
            None
        );
    }

    #[test]
    fn tells_light_from_dark() {
        assert!(is_light((250, 250, 250)));
        assert!(!is_light((0, 0, 0)));
        assert!(!is_light((40, 42, 54)));
        assert!(is_light((253, 246, 227)));
    }

    #[test]
    fn reads_colorfgbg() {
        assert_eq!(light_from_colorfgbg("15;0"), Some(false));
        assert_eq!(light_from_colorfgbg("0;15"), Some(true));
        assert_eq!(light_from_colorfgbg("0;7"), Some(true));
        assert_eq!(light_from_colorfgbg("7;8"), Some(false));
        assert_eq!(light_from_colorfgbg("15;default;0"), Some(false));
        assert_eq!(light_from_colorfgbg("0;12"), None);
        assert_eq!(light_from_colorfgbg("default;default"), None);
        assert_eq!(light_from_colorfgbg(""), None);
    }

    #[test]
    fn the_variable_wins_and_skips_the_query() {
        let never = || -> Option<bool> { panic!("asked the terminal") };
        assert_eq!(choose(Some("light"), never, Some("15;0")), LIGHT);
        assert_eq!(choose(Some(" Dark "), never, Some("0;15")), DARK);
        assert_eq!(choose(Some("solid"), never, None), SOLID);
        assert_eq!(SOLID.canvas, Color::Rgb(0, 0, 0));
        assert_eq!(choose(None, || Some(true), Some("15;0")), LIGHT);
        assert_eq!(choose(Some("auto"), || None, Some("0;15")), LIGHT);
        assert_eq!(choose(None, || None, Some("0;12")), DARK);
        assert_eq!(choose(None, || None, None), DARK);
    }

    #[test]
    fn glass_leaves_the_canvas_to_the_terminal() {
        assert_eq!(DARK.canvas, Color::Reset);
        assert_eq!(LIGHT.canvas, Color::Reset);
        for palette in [DARK, LIGHT, SOLID] {
            for card in [palette.bar, palette.select, palette.cursor] {
                assert_ne!(card, Color::Reset);
            }
        }
    }

    #[test]
    fn a_test_can_pick_its_palette() {
        assert_eq!(palette(), DARK);
        use_for_test(LIGHT);
        assert_eq!(palette(), LIGHT);
    }

    #[test]
    fn spots_the_da1_reply() {
        assert!(answered(b"\x1b[?62;22c"));
        assert!(answered(b"\x1b]11;rgb:0/0/0\x07\x1b[?1;2c"));
        assert!(!answered(b"\x1b[?62;22"));
        assert!(!answered(b"\x1b]11;rgb:0/0/0\x07"));
        assert!(!answered(b"\x1b[?6x2c"));
    }

    fn keys(text: &str) -> Vec<KeyEvent> {
        let mut keys = Vec::new();
        let mut chars = text.chars();
        while let Some(ch) = chars.next() {
            keys.push(match ch {
                '\x1b' => KeyEvent::new(KeyCode::Char(chars.next().unwrap()), KeyModifiers::ALT),
                '\x07' => KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
                ch => KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            });
        }
        keys
    }

    fn kept(filter: &mut LateReply, text: &str) -> String {
        keys(text)
            .into_iter()
            .filter(|key| !filter.swallows(key))
            .map(|key| match key.code {
                KeyCode::Char(ch) => ch,
                _ => '?',
            })
            .collect()
    }

    #[test]
    fn a_late_answer_never_reaches_the_composer() {
        let mut filter = LateReply::new(true);
        assert_eq!(
            kept(&mut filter, "\x1b]11;rgb:fafa/fafa/fafa\x07hello"),
            "hello"
        );
        // One answer is all that comes; after it, keys pass.
        assert_eq!(kept(&mut filter, "\x1b]11;rgb"), "]11;rgb");

        let mut filter = LateReply::new(true);
        assert_eq!(
            kept(&mut filter, "\x1b]11;rgb:0000/0000/0000\x1b\\ok"),
            "ok"
        );

        // A real key after Alt+] ends it.
        let mut filter = LateReply::new(true);
        assert_eq!(kept(&mut filter, "\x1b]hi"), "hi");
    }

    #[test]
    fn nothing_is_dropped_when_the_terminal_answered() {
        let mut filter = LateReply::new(false);
        assert_eq!(
            kept(&mut filter, "\x1b]11;rgb:fafa/fafa/fafa\x07"),
            "]11;rgb:fafa/fafa/fafag"
        );
    }

    #[cfg(unix)]
    fn pipe() -> (std::os::fd::RawFd, std::os::fd::RawFd) {
        let mut fds = [0; 2];
        // SAFETY: pipe writes two descriptors into the array.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    #[cfg(unix)]
    fn close(fd: std::os::fd::RawFd) {
        // SAFETY: closes a descriptor the test opened.
        unsafe { libc::close(fd) };
    }

    #[cfg(unix)]
    #[test]
    fn stops_at_the_da1_reply_without_waiting() {
        let (read, write) = pipe();
        let answer = b"\x1b]11;rgb:fafa/fafa/fafa\x07\x1b[?62;22c";
        // SAFETY: writes the bytes of a live slice.
        unsafe { libc::write(write, answer.as_ptr().cast(), answer.len()) };
        let started = std::time::Instant::now();
        let reply = read_reply(read, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(reply, answer);
        assert_eq!(parse_osc11(&reply), Some((250, 250, 250)));
        close(read);
        close(write);
    }

    #[cfg(unix)]
    #[test]
    fn a_silent_terminal_costs_only_the_timeout() {
        let (read, write) = pipe();
        let started = std::time::Instant::now();
        assert!(read_reply(read, Duration::from_millis(60)).is_empty());
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(50), "{took:?}");
        assert!(took < Duration::from_secs(1), "{took:?}");
        close(read);
        close(write);
    }
}
