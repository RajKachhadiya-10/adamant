use std::fs;
use std::io::Write;
use std::path::PathBuf;

use url::Url;

const DEFAULT_ORIGIN: &str = "http://localhost:8787";

#[derive(Clone)]
pub struct Config {
    pub origin: Option<String>,
    pub origin_error: Option<String>,
    pub session: Option<String>,
    pub session_error: Option<String>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("origin", &self.origin)
            .field("origin_error", &self.origin_error)
            .field("session", &self.session.as_ref().map(|_| "set"))
            .field("session_error", &self.session_error)
            .finish()
    }
}

pub fn load() -> Config {
    load_from(
        std::env::var("ADAMANT_API_URL").ok().as_deref(),
        std::env::var("ADAMANT_SESSION").ok().as_deref(),
    )
}

pub fn load_from(api_url: Option<&str>, session_env: Option<&str>) -> Config {
    let raw_origin = api_url.map(str::trim).filter(|value| !value.is_empty());
    let (origin, origin_error) = match normalize_origin(raw_origin.unwrap_or(DEFAULT_ORIGIN)) {
        Ok(origin) => (Some(origin), None),
        Err(error) => (None, Some(error)),
    };

    let (session, session_error) =
        match session_env.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => match check_session(value) {
                Ok(token) => (Some(token), None),
                Err(error) => (None, Some(error)),
            },
            None => match read_session_file() {
                Ok(Some(token)) => (Some(token), None),
                Ok(None) => (None, None),
                Err(error) => (None, Some(error)),
            },
        };

    Config {
        origin,
        origin_error,
        session,
        session_error,
    }
}

pub fn normalize_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value)
        .map_err(|_| "ADAMANT_API_URL must be a valid absolute URL.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("ADAMANT_API_URL must start with https:// (or http:// for localhost).".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ADAMANT_API_URL must not contain credentials. Use ADAMANT_SESSION.".into());
    }
    if url.path() != "/" && url.path() != "" {
        return Err("ADAMANT_API_URL must be an origin without a path, query, or fragment.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("ADAMANT_API_URL must be an origin without a path, query, or fragment.".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "ADAMANT_API_URL must include a host.".to_string())?;
    if url.scheme() != "https" && !is_loopback(host) {
        return Err(
            "ADAMANT_API_URL must use HTTPS outside explicit localhost development.".into(),
        );
    }
    let port = match url.port() {
        Some(port) => format!(":{port}"),
        None => String::new(),
    };
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Ok(format!("{}://{host}{port}", url.scheme()))
}

pub fn check_session(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("ADAMANT_SESSION must not contain spaces or control characters.".into());
    }
    Ok(value.to_string())
}

pub fn store_session(token: &str) -> Result<(), String> {
    let token = check_session(token)?;
    let path = session_path()
        .ok_or_else(|| "Could not find a home directory for the session.".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Could not create ~/.adamant.".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let mut file = {
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)
            .map_err(|_| "Could not store the session.".to_string())?
    };
    file.write_all(token.as_bytes())
        .map_err(|_| "Could not store the session.".to_string())?;
    Ok(())
}

pub fn clear_session_file() {
    if let Some(path) = session_path() {
        let _ = fs::remove_file(path);
    }
}

pub fn display_cwd() -> String {
    let path = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "~".into());
    let home = std::env::var("HOME").unwrap_or_default();
    shorten_path(&path, &home)
}

pub fn shorten_path(path: &str, home: &str) -> String {
    if home.is_empty() {
        return path.to_string();
    }
    if path == home {
        return "~".into();
    }
    let prefix = format!("{home}/");
    if let Some(rest) = path.strip_prefix(&prefix) {
        format!("~/{rest}")
    } else {
        path.to_string()
    }
}

fn read_session_file() -> Result<Option<String>, String> {
    let Some(path) = session_path() else {
        return Ok(None);
    };
    match fs::read_to_string(path) {
        Ok(value) => {
            let token = value.trim();
            if token.is_empty() {
                Ok(None)
            } else {
                check_session(token).map(Some)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read ~/.adamant/session.".into()),
    }
}

fn session_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".adamant").join("session"))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_localhost_and_https() {
        assert_eq!(
            normalize_origin("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_origin("https://api.example.com").unwrap(),
            "https://api.example.com"
        );
    }

    #[test]
    fn rejects_non_local_http_and_credentials() {
        assert!(normalize_origin("http://example.com").is_err());
        assert!(normalize_origin("http://user:pw@localhost:8787").is_err());
        assert!(normalize_origin("http://localhost:8787/v1").is_err());
        assert!(normalize_origin("localhost:8787").is_err());
    }

    #[test]
    fn shortens_home() {
        assert_eq!(shorten_path("/Users/avaish", "/Users/avaish"), "~");
        assert_eq!(
            shorten_path("/Users/avaish/adamant", "/Users/avaish"),
            "~/adamant"
        );
    }
}
