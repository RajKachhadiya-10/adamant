use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;

/// A repository the signed-in user can see on GitHub, not only where the App is.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct GhRepo {
    pub id: u64,
    pub owner: String,
    pub owner_id: u64,
    pub name: String,
    #[serde(default)]
    pub private: bool,
    /// Only an admin can install the App; anyone else sends the owner a request.
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub installed: bool,
}

impl GhRepo {
    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The user's own `gh` login: private and organization repositories too.
    Gh,
    /// No `gh`: the public repositories GitHub lists for the username.
    Public,
}

pub struct Listing {
    pub repos: Vec<GhRepo>,
    pub source: Source,
}

const GH_FIELDS: &str = ".[] | {id, owner: .owner.login, owner_id: .owner.id, name, private, admin: (.permissions.admin // false)}";
/// A user in many organizations can see thousands; the picker filters, it does not page.
const MAX_REPOS: usize = 500;

/// An App's user token only sees repositories the App is already installed on, so
/// the session cannot answer "which repositories do I have". The user's own `gh`
/// login can, and its token stays inside `gh`.
pub async fn list_with_gh() -> Result<Vec<GhRepo>, String> {
    let output = tokio::process::Command::new("gh")
        .args([
            "api",
            "--paginate",
            "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
            "--jq",
            GH_FIELDS,
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(60), output)
        .await
        .map_err(|_| "gh took too long to list repositories.".to_string())?
        .map_err(|_| "gh is not installed.".to_string())?;
    if !output.status.success() {
        return Err("gh is not signed in (gh auth login).".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<GhRepo>(line).ok())
        .take(MAX_REPOS)
        .collect())
}

#[derive(Deserialize)]
struct PublicRepo {
    id: u64,
    name: String,
    private: bool,
    owner: PublicOwner,
}

#[derive(Deserialize)]
struct PublicOwner {
    login: String,
    id: u64,
}

pub async fn list_public(username: &str) -> Result<Vec<GhRepo>, String> {
    let url = format!(
        "https://api.github.com/users/{}/repos?per_page=100&sort=pushed",
        url::form_urlencoded::byte_serialize(username.as_bytes()).collect::<String>()
    );
    let response = reqwest::Client::new()
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            concat!("adamant/", env!("CARGO_PKG_VERSION")),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Could not reach api.github.com.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub answered {} for {username}'s repositories.",
            response.status()
        ));
    }
    let repos: Vec<PublicRepo> = response
        .json()
        .await
        .map_err(|_| "GitHub's repository list was not readable.".to_string())?;
    Ok(repos
        .into_iter()
        .map(|repo| GhRepo {
            admin: repo.owner.login.eq_ignore_ascii_case(username),
            id: repo.id,
            owner: repo.owner.login,
            owner_id: repo.owner.id,
            name: repo.name,
            private: repo.private,
            installed: false,
        })
        .collect())
}

/// Marks what the hosted API already has a `repositories` row for.
pub fn mark_installed(repos: &mut [GhRepo], installed: &HashSet<String>) {
    for repo in repos {
        repo.installed = installed.contains(&repo.full_name().to_ascii_lowercase());
    }
}

/// `https://github.com/apps/<slug>/installations/new` from the API, checked again here.
pub fn app_slug(install_url: &str) -> Option<&str> {
    let slug = install_url
        .strip_prefix("https://github.com/apps/")?
        .strip_suffix("/installations/new")?;
    let valid = !slug.is_empty()
        && slug.len() <= 100
        && slug.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        });
    valid.then_some(slug)
}

/// GitHub's install page with the account and repositories already chosen. The
/// user still confirms on GitHub; an App cannot install itself.
pub fn install_link(slug: &str, owner_id: u64, repo_ids: &[u64]) -> String {
    let mut url = format!(
        "https://github.com/apps/{slug}/installations/new/permissions?suggested_target_id={owner_id}"
    );
    for id in repo_ids {
        url.push_str(&format!("&repository_ids%5B%5D={id}"));
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_gh_lines() {
        let line = r#"{"id":1367024500,"owner":"vaishcodescape","owner_id":172988559,"name":"adamant","private":true,"admin":true}"#;
        let repo: GhRepo = serde_json::from_str(line).unwrap();
        assert_eq!(repo.full_name(), "vaishcodescape/adamant");
        assert!(repo.admin && !repo.installed);
    }

    #[test]
    fn builds_a_preselected_install_link() {
        assert_eq!(
            app_slug("https://github.com/apps/adamant-dev/installations/new"),
            Some("adamant-dev")
        );
        assert_eq!(
            app_slug("https://github.com/apps/../installations/new"),
            None
        );
        assert_eq!(
            app_slug("https://evil.example/apps/x/installations/new"),
            None
        );
        assert_eq!(
            install_link("adamant-dev", 7, &[1, 2]),
            "https://github.com/apps/adamant-dev/installations/new/permissions?suggested_target_id=7&repository_ids%5B%5D=1&repository_ids%5B%5D=2"
        );
    }

    #[test]
    fn marks_installed_case_insensitively() {
        let mut repos = vec![GhRepo {
            id: 1,
            owner: "Vaish".into(),
            owner_id: 2,
            name: "Adamant".into(),
            private: false,
            admin: true,
            installed: false,
        }];
        mark_installed(&mut repos, &HashSet::from(["vaish/adamant".to_string()]));
        assert!(repos[0].installed);
    }
}
