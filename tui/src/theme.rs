use ratatui::style::Color;

/// Yellow stands where the Codex product name is bold white.
pub const YELLOW: Color = Color::Rgb(250, 204, 21);
pub const BLACK: Color = Color::Rgb(0, 0, 0);
pub const BAR: Color = Color::Rgb(36, 36, 36);
pub const INK: Color = Color::Rgb(230, 230, 230);
pub const MUTED: Color = Color::Rgb(140, 140, 140);
pub const DIM: Color = Color::Rgb(110, 110, 110);
pub const HINT: Color = Color::Rgb(120, 120, 120);
pub const KEY: Color = Color::Rgb(176, 176, 176);
pub const BLUE: Color = Color::Rgb(88, 166, 255);
pub const RED: Color = Color::Rgb(249, 117, 131);
pub const GREEN: Color = Color::Rgb(63, 185, 80);
pub const BORDER: Color = Color::Rgb(72, 72, 72);
pub const SELECT: Color = Color::Rgb(46, 46, 46);
pub const CURSOR: Color = Color::Rgb(220, 220, 220);

/// Blank row, prompt, blank row. The status and hint lines sit under that bar.
pub const COMPOSER_ROWS: u16 = 3;
pub const FOOTER_ROWS: u16 = COMPOSER_ROWS + 2;
