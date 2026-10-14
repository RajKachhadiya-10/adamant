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
        summary: "Installed repositories",
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
    Status,
    Runs,
    Run(String),
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
    Clear,
    Help,
    Usage(String),
    Unknown(String),
}

impl Command {
    pub fn echo(&self) -> String {
        match self {
            Command::Status => "/status".into(),
            Command::Runs => "/runs".into(),
            Command::Run(id) => format!("/run {id}"),
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

pub fn parse(raw: &str) -> Command {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix('/').unwrap_or(trimmed);
    let mut parts = body.split_whitespace();
    let Some(name) = parts.next() else {
        return Command::Help;
    };
    let rest: Vec<&str> = parts.collect();
    match name {
        "status" => Command::Status,
        "runs" => Command::Runs,
        "run" => match rest.as_slice() {
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
        assert_eq!(parse("watch"), Command::Watch);
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
    fn suggests_from_a_slash() {
        assert_eq!(suggestions("/").len(), SPECS.len());
        assert_eq!(suggestions("/st").len(), 2);
        assert!(suggestions("/runs extra").is_empty());
        assert!(suggestions("runs").is_empty());
    }
}
