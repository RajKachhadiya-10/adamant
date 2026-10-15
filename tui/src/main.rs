mod agent;
mod api;
mod app;
mod command;
mod config;
mod driver;
mod format;
mod github;
mod prompt;
mod theme;
mod tools;
mod ui;

use std::io::{self, Write};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use crossterm::event::{self, Event};
use crossterm::terminal::{disable_raw_mode, LeaveAlternateScreen};
use crossterm::{cursor::Show, execute};
use tokio::sync::mpsc;

use crate::app::{App, Effect, Msg};
use crate::driver::Driver;

fn main() -> ExitCode {
    if help_requested() {
        print_help();
        return ExitCode::SUCCESS;
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        leave_terminal();
        previous(info);
    }));

    let config = config::load();
    let mut terminal = ratatui::init();
    // Raw mode is on and the key reader has not started, so the terminal's answer about its
    // background comes back here instead of landing in the composer.
    let (palette, late) = theme::detect();
    theme::init(palette);
    let _ = execute!(io::stdout(), event::EnableBracketedPaste);
    let code = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => match runtime.block_on(session(&mut terminal, config, late)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        },
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    };
    leave_terminal();
    code
}

fn leave_terminal() {
    let _ = execute!(io::stdout(), event::DisableBracketedPaste);
    ratatui::restore();
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
}

async fn session(
    terminal: &mut ratatui::DefaultTerminal,
    config: config::Config,
    late: bool,
) -> io::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let events = tx.clone();
    let mut late = theme::LateReply::new(late);
    thread::spawn(move || loop {
        let event = match event::read() {
            Ok(event) => event,
            Err(_) => break,
        };
        let msg = match event {
            Event::Key(key) if late.swallows(&key) => continue,
            Event::Key(key) => Msg::Key(key),
            Event::Paste(text) => Msg::Paste(text),
            Event::Resize(cols, rows) => Msg::Resize(cols, rows),
            _ => continue,
        };
        if events.send(msg).is_err() {
            break;
        }
    });

    let cwd = config::display_cwd();
    let reduce_motion = std::env::var("ADAMANT_REDUCED_MOTION").is_ok();
    let mut app = App::new(env!("CARGO_PKG_VERSION"), &cwd, &config, reduce_motion);
    let mut driver = Driver::new(&config, tx);
    let initial = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    for effect in app.startup_effects() {
        driver.dispatch(effect);
    }
    if !initial.is_empty() {
        let effect = app.submit_text(&initial);
        if matches!(effect, Effect::Quit) {
            return Ok(());
        }
        driver.dispatch(effect);
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(600));
    // Redraws for the Working row's sweep; the branch below only polls it while it shows.
    let mut frames = tokio::time::interval(Duration::from_millis(32));
    frames.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let size = terminal.size()?;
        app.resize(size.width, size.height);
        terminal.draw(|frame| ui::draw(frame, &app))?;
        tokio::select! {
            _ = ticker.tick() => app.on_tick(),
            _ = frames.tick(), if app.animating() => {}
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                let effect = app.on_msg(msg);
                if matches!(effect, Effect::Quit) {
                    break;
                }
                driver.dispatch(effect);
            }
        }
    }
    Ok(())
}

fn help_requested() -> bool {
    std::env::args()
        .skip(1)
        .any(|arg| arg == "--help" || arg == "-h")
}

fn print_help() {
    let mut out = io::stdout().lock();
    let _ = writeln!(
        out,
        "\
adamant

Type a request and the agent works on it in this directory: it runs commands,
reads and edits files, and drives the hosted API (runs, heals, installs).

  /status                     API and session
  /runs                       list heals
  /run <id>                   one heal and its audit
  /watch                      live feed
  /login                      GitHub in the browser
  /logout
  /me
  /repos                      pick GitHub repositories, install Adamant on them
  /install [owner/name]       GitHub App install
  /new                        new conversation
  /auto, /manual              approvals (shift-tab switches)
  /trigger <repository> <sha> start a heal

ADAMANT_API_URL     default http://localhost:8787
ADAMANT_SESSION     session token; otherwise ~/.adamant/session
OPENAI_API_KEY      the agent's model key; otherwise ~/.adamant/openai_key
ADAMANT_MODEL       model (default OPENAI_MODEL, then gpt-6-sol)
ADAMANT_REASONING   reasoning effort (default medium; none for other models)
ADAMANT_APPROVALS   manual to start in manual mode (default auto)
ADAMANT_THEME       light or dark (default: ask the terminal); solid paints an opaque
                    black background for terminals without transparency
"
    );
}
