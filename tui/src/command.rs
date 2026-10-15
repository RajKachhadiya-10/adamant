pub struct Spec {
    pub name: &'static str,
    pub summary: &'static str,
}

pub const SPECS: &[Spec] = &[
    Spec {
        name: "status",
        summary: "API and session",
    },
    Spec {
        name: "runs",
        summary: "List heals",
    },
    Spec {
        name: "run",
        summary: "Open one heal",
    },
    Spec {
        name: "watch",
        summary: "Follow the live feed",
    },
    Spec {
        name: "stop",
        summary: "Stop the live feed",
    },
    Spec {
        name: "login",
        summary: "Sign in with GitHub",
    },
    Spec {
        name: "logout",
        summary: "Revoke this session",
    },
    Spec {
        name: "me",
        summary: "Who is signed in",
    },
    Spec {
        name: "repos",
        summary: "Pick GitHub repositories for Adamant",
    },
    Spec {
        name: "install",
        summary: "Install the GitHub App",
    },
    Spec {
        name: "trigger",
        summary: "Start a heal",
    },
    Spec {
        name: "new",
        summary: "Start a new conversation",
    },
    Spec {
        name: "auto",
        summary: "Run commands and edits without asking",
    },
    Spec {
        name: "manual",
        summary: "Ask before each command or edit",
    },
    Spec {
        name: "clear",
        summary: "Clear the screen",
    },
    Spec {
        name: "help",
        summary: "What you can ask",
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Prompt(String),
    Status,
    Runs,
    Run(String),
    /// `/run` without an id: pick one from the list.
    PickRun,
    Watch,
    Stop,
    Login,
    Logout,
    Me,
    Repos,
    Install {
        owner: Option<String>,
        name: Option<String>,
    },
    Trigger {
        repository_id: String,
        source_sha: String,
    },
    New,
    Auto,
    Manual,
    Clear,
    Help,
    Usage(String),
    Unknown(String),
}

impl Command {
    pub fn echo(&self) -> String {
        match self {
            Command::Prompt(text) => text.clone(),
            Command::Status => "/status".into(),
            Command::Runs => "/runs".into(),
            Command::Run(id) => format!("/run {id}"),
            Command::PickRun => "/run".into(),
            Command::Watch => "/watch".into(),
            Command::Stop => "/stop".into(),
            Command::Login => "/login".into(),
            Command::Logout => "/logout".into(),
            Command::Me => "/me".into(),
            Command::Repos => "/repos".into(),
            Command::Install { owner: None, .. } => "/install".into(),
            Command::Install {
                owner: Some(owner),
                name: Some(name),
            } => format!("/install {owner}/{name}"),
            Command::Install {
                owner: Some(owner),
                name: None,
            } => format!("/install {owner}"),
            Command::Trigger {
                repository_id,
                source_sha,
            } => format!("/trigger {repository_id} {source_sha}"),
            Command::New => "/new".into(),
            Command::Auto => "/auto".into(),
            Command::Manual => "/manual".into(),
            Command::Clear => "/clear".into(),
            Command::Help => "/help".into(),
            Command::Usage(text) | Command::Unknown(text) => text.clone(),
        }
    }
}

/// `/run` and `/trigger` need the rest of the line before they can be sent.
pub fn needs_more(name: &str) -> bool {
    matches!(name, "run" | "trigger")
}

pub fn suggestions(input: &str) -> Vec<&'static Spec> {
    let Some(rest) = input.trim().strip_prefix('/') else {
        return Vec::new();
    };
    if rest.split_whitespace().nth(1).is_some() {
        return Vec::new();
    }
    SPECS
        .iter()
        .filter(|spec| spec.name.starts_with(rest.trim()))
        .collect()
}

/// What the composer sends: a slash command, or a prompt for the agent.
pub fn parse(raw: &str) -> Command {
    let trimmed = raw.trim();
    match trimmed.strip_prefix('/') {
        Some(body) => parse_command(trimmed, body),
        None if trimmed.is_empty() => Command::Help,
        None => Command::Prompt(trimmed.to_string()),
    }
}

/// `adamant runs` and `adamant fix the build` both work from the shell.
pub fn parse_args(raw: &str) -> Command {
    let trimmed = raw.trim();
    let first = trimmed.trim_start_matches('/').split_whitespace().next();
    let known = first.is_some_and(|name| {
        SPECS.iter().any(|spec| spec.name == name) || matches!(name, "cls" | "?")
    });
    if trimmed.starts_with('/') || known {
        parse_command(trimmed, trimmed.trim_start_matches('/'))
    } else {
        parse(trimmed)
    }
}

fn parse_command(trimmed: &str, body: &str) -> Command {
    let mut parts = body.split_whitespace();
    let Some(name) = parts.next() else {
        return Command::Help;
    };
    let rest: Vec<&str> = parts.collect();
    match name {
        "status" => Command::Status,
        "runs" => Command::Runs,
        "run" => match rest.as_slice() {
            [] => Command::PickRun,
            [id] if valid_id(id) => Command::Run((*id).to_string()),
            _ => Command::Usage("Usage: /run <id>".into()),
        },
        "watch" => Command::Watch,
        "stop" => Command::Stop,
        "login" => Command::Login,
        "logout" => Command::Logout,
        "me" => Command::Me,
        "repos" => Command::Repos,
        "install" => parse_install(&rest),
        "trigger" => parse_trigger(&rest),
        "new" => Command::New,
        "auto" => Command::Auto,
        "manual" => Command::Manual,
        "clear" | "cls" => Command::Clear,
        "help" | "?" => Command::Help,
        _ => Command::Unknown(trimmed.to_string()),
    }
}

fn parse_install(rest: &[&str]) -> Command {
    match rest {
        [] => Command::Install {
            owner: None,
            name: None,
        },
        [slug] => match slug.split_once('/') {
            Some((owner, name)) if valid_owner(owner) && valid_repo(name) => Command::Install {
                owner: Some(owner.to_string()),
                name: Some(name.to_string()),
            },
            _ => Command::Usage("Usage: /install or /install <owner>/<name>".into()),
        },
        [owner, name] if valid_owner(owner) && valid_repo(name) => Command::Install {
            owner: Some((*owner).to_string()),
            name: Some((*name).to_string()),
        },
        _ => Command::Usage("Usage: /install or /install <owner>/<name>".into()),
    }
}

fn parse_trigger(rest: &[&str]) -> Command {
    match rest {
        [repository_id, source_sha] if valid_id(repository_id) && valid_sha(source_sha) => {
            Command::Trigger {
                repository_id: (*repository_id).to_string(),
                source_sha: (*source_sha).to_string(),
            }
        }
        _ => Command::Usage("Usage: /trigger <repository-id> <commit-sha>".into()),
    }
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

pub fn valid_sha(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub fn valid_owner(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || value.len() > 39 {
        return false;
    }
    let mut prev_hyphen = false;
    for ch in chars {
        if ch.is_ascii_alphanumeric() {
            prev_hyphen = false;
            continue;
        }
        if ch == '-' && !prev_hyphen {
            prev_hyphen = true;
            continue;
        }
        return false;
    }
    !value.ends_with('-')
}

pub fn valid_repo(value: &str) -> bool {
    if value.is_empty() || value.len() > 100 || value.to_ascii_lowercase().ends_with(".git") {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphanumeric() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_heal_commands() {
        assert_eq!(parse("/runs"), Command::Runs);
        assert_eq!(parse("/run"), Command::PickRun);
        assert_eq!(parse_args("watch"), Command::Watch);
        assert_eq!(parse("/frobnicate"), Command::Unknown("/frobnicate".into()));
        assert_eq!(
            parse("/run abcdef12-abcd"),
            Command::Run("abcdef12-abcd".into())
        );
        assert!(matches!(parse("/trigger nope nope"), Command::Usage(_)));
        assert_eq!(
            parse("/install vaish/adamant"),
            Command::Install {
                owner: Some("vaish".into()),
                name: Some("adamant".into())
            }
        );
    }

    #[test]
    fn plain_text_is_a_prompt() {
        assert_eq!(
            parse("status of my runs"),
            Command::Prompt("status of my runs".into())
        );
        assert_eq!(
            parse_args("fix the failing test"),
            Command::Prompt("fix the failing test".into())
        );
        assert_eq!(parse_args("run abc-123"), Command::Run("abc-123".into()));
    }

    #[test]
    fn suggests_from_a_slash() {
        assert_eq!(suggestions("/").len(), SPECS.len());
        assert_eq!(suggestions("/st").len(), 2);
        assert!(suggestions("/runs extra").is_empty());
        assert!(suggestions("runs").is_empty());
    }
}
