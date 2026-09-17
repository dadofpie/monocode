use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::dirs_home;

/// Summary of one `cc-switch` Command Code account.
/// Only non-secret identity fields are exposed; the API key never leaves this module.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdAccountInfo {
    pub id: String,
    pub user_name: String,
    pub key_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdAccountState {
    pub available: bool,
    pub accounts_dir: Option<String>,
    pub accounts: Vec<CmdAccountInfo>,
    pub active_id: Option<String>,
    pub current_user: Option<String>,
    pub current_key: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdAccountSwitch {
    pub active_id: String,
    pub user_name: String,
}

pub(crate) struct CcSwitchLayout {
    pub accounts_dir: PathBuf,
    pub state_file: PathBuf,
}

fn is_valid_account_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn compare_account_ids(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => a.cmp(b),
    }
}

/// Locate the `cc-switch` helper the same way a shell would, then derive the
/// accounts directory and active-account state file from the script location
/// (mirrors the script's own `$DIR/accounts` + `$DIR/.active_account`).
pub(crate) fn resolve_cc_switch(home: &Path, path_var: Option<&str>) -> Option<CcSwitchLayout> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(path_var) {
            candidates.push(dir.join("cc-switch"));
        }
    }
    candidates.push(home.join(".local/bin/cc-switch"));

    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        // Resolve symlinks so the accounts dir matches the script's own $DIR.
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        let Some(dir) = resolved.parent().map(Path::to_path_buf) else {
            continue;
        };
        return Some(CcSwitchLayout {
            accounts_dir: dir.join("accounts"),
            state_file: dir.join(".active_account"),
        });
    }
    None
}

fn account_file_name(id: &str) -> String {
    format!("account{id}.json")
}

fn parse_account_id(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".json")?;
    let id = stem.strip_prefix("account")?;
    if is_valid_account_id(id) {
        Some(id.to_string())
    } else {
        None
    }
}

fn read_identity(raw: &str) -> (String, String) {
    let value: serde_json::Value = match serde_json::from_str(raw.trim()) {
        Ok(value) => value,
        Err(_) => return ("unknown".into(), "unknown".into()),
    };
    let user = value
        .get("userName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let key = value
        .get("keyName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    (user, key)
}

fn read_active_id(state_file: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(state_file).ok()?;
    let id = raw.trim().to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn router_secret_path(home: &Path) -> PathBuf {
    home.join(".codex/codex-router/commandcode-api-key.secret")
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

pub(crate) fn list_accounts_sync(
    accounts_dir: &Path,
    state_file: &Path,
    auth_path: &Path,
) -> CmdAccountState {
    let unavailable = |hint: &str| CmdAccountState {
        available: false,
        accounts_dir: None,
        accounts: Vec::new(),
        active_id: None,
        current_user: None,
        current_key: None,
        hint: Some(hint.into()),
    };

    let entries = match std::fs::read_dir(accounts_dir) {
        Ok(entries) => entries,
        Err(_) => {
            return unavailable(
                "No cc-switch accounts found. Run 'cmd login' then 'cc-switch save' to set one up.",
            );
        }
    };

    let mut accounts = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = parse_account_id(&name) else {
            continue;
        };
        let raw = std::fs::read_to_string(entry.path()).unwrap_or_default();
        let (user_name, key_name) = read_identity(&raw);
        accounts.push(CmdAccountInfo {
            id,
            user_name,
            key_name,
        });
    }
    accounts.sort_by(|a, b| compare_account_ids(&a.id, &b.id));

    if accounts.is_empty() {
        return unavailable(
            "No cc-switch accounts found. Run 'cmd login' then 'cc-switch save' to set one up.",
        );
    }

    let (current_user, current_key) = std::fs::read_to_string(auth_path)
        .ok()
        .map(|raw| read_identity(&raw))
        .map(|(user, key)| (Some(user), Some(key)))
        .unwrap_or((None, None));

    CmdAccountState {
        available: true,
        accounts_dir: Some(accounts_dir.to_string_lossy().into_owned()),
        accounts,
        active_id: read_active_id(state_file),
        current_user,
        current_key,
        hint: None,
    }
}

pub(crate) fn switch_account_sync(
    accounts_dir: &Path,
    state_file: &Path,
    auth_path: &Path,
    home: &Path,
    id: &str,
) -> Result<CmdAccountSwitch, String> {
    if !is_valid_account_id(id) {
        return Err("Unknown Command Code account.".into());
    }
    let account_file = accounts_dir.join(account_file_name(id));
    let bytes = std::fs::read(&account_file)
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| {
            "Account not found. Run 'cmd login' then 'cc-switch save' to set it up.".to_string()
        })?;

    let raw =
        String::from_utf8(bytes).map_err(|_| "That account file is not valid JSON.".to_string())?;
    let (user_name, _) = read_identity(&raw);
    // The account file must carry a usable API key, mirroring cc-switch.
    let api_key = crate::rate_limits::extract_cmd_api_key(&raw)
        .ok_or_else(|| "That account file has no API key.".to_string())?;

    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not switch account: {e}"))?;
    }
    std::fs::write(auth_path, raw.as_bytes())
        .map_err(|e| format!("Could not switch account: {e}"))?;
    restrict_permissions(auth_path);

    std::fs::write(state_file, format!("{id}\n"))
        .map_err(|e| format!("Could not switch account: {e}"))?;

    // Mirror cc-switch: push the key to the codex router credential file so the
    // router picks up the new account without a restart.
    let router_secret = router_secret_path(home);
    if router_secret.parent().is_some_and(|dir| dir.is_dir())
        && std::fs::write(&router_secret, format!("{api_key}\n")).is_ok()
    {
        restrict_permissions(&router_secret);
    }

    Ok(CmdAccountSwitch {
        active_id: id.to_string(),
        user_name,
    })
}

fn list_cmd_accounts_sync() -> Result<CmdAccountState, String> {
    let Some(home) = dirs_home() else {
        return Ok(CmdAccountState {
            available: false,
            accounts_dir: None,
            accounts: Vec::new(),
            active_id: None,
            current_user: None,
            current_key: None,
            hint: Some("Could not locate your home directory.".into()),
        });
    };
    let path_var = std::env::var("PATH").ok();
    let Some(layout) = resolve_cc_switch(&PathBuf::from(&home), path_var.as_deref()) else {
        return Ok(CmdAccountState {
            available: false,
            accounts_dir: None,
            accounts: Vec::new(),
            active_id: None,
            current_user: None,
            current_key: None,
            hint: Some(
                "cc-switch was not found. Install it to switch Command Code accounts here.".into(),
            ),
        });
    };
    let auth_path = crate::rate_limits::cmd_auth_path()
        .unwrap_or_else(|| PathBuf::from(&home).join(".commandcode/auth.json"));
    Ok(list_accounts_sync(
        &layout.accounts_dir,
        &layout.state_file,
        &auth_path,
    ))
}

fn switch_cmd_account_sync(id: String) -> Result<CmdAccountSwitch, String> {
    let Some(home) = dirs_home() else {
        return Err("Could not locate your home directory.".into());
    };
    let path_var = std::env::var("PATH").ok();
    let Some(layout) = resolve_cc_switch(&PathBuf::from(&home), path_var.as_deref()) else {
        return Err("cc-switch was not found.".into());
    };
    let auth_path = crate::rate_limits::cmd_auth_path()
        .unwrap_or_else(|| PathBuf::from(&home).join(".commandcode/auth.json"));
    switch_account_sync(
        &layout.accounts_dir,
        &layout.state_file,
        &auth_path,
        &PathBuf::from(&home),
        &id,
    )
}

/// List the `cc-switch` Command Code accounts on this machine.
/// Never returns API keys, only account identity labels.
#[tauri::command]
pub async fn list_cmd_accounts() -> Result<CmdAccountState, String> {
    tauri::async_runtime::spawn_blocking(list_cmd_accounts_sync)
        .await
        .map_err(|e| e.to_string())?
}

/// Switch the active Command Code account the way `cc-switch N` does:
/// copy the stored account file over `~/.commandcode/auth.json`, record the
/// active account, and refresh the codex router credential when present.
#[tauri::command]
pub async fn switch_cmd_account(id: String) -> Result<CmdAccountSwitch, String> {
    tauri::async_runtime::spawn_blocking(|| switch_cmd_account_sync(id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-cmd-accounts-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin/accounts")).unwrap();
        dir
    }

    fn write_account(dir: &Path, id: &str, user: &str, key: &str) {
        let body = format!(r#"{{"apiKey":"secret-{id}","userName":"{user}","keyName":"{key}"}}"#);
        std::fs::write(dir.join("bin/accounts").join(account_file_name(id)), body).unwrap();
    }

    #[test]
    fn rejects_unsafe_account_ids() {
        for bad in ["", "../x", "a/b", ".", "x.json", "a b", &"a".repeat(65)] {
            assert!(!is_valid_account_id(bad), "should reject {bad:?}");
        }
        for good in ["1", "2", "10", "work-acct_2"] {
            assert!(is_valid_account_id(good), "should accept {good:?}");
        }
    }

    #[test]
    fn lists_accounts_sorted_with_active_and_current() {
        let root = sandbox("list");
        write_account(&root, "10", "ten", "k-ten");
        write_account(&root, "2", "two", "k-two");
        std::fs::write(root.join("bin/.active_account"), "2\n").unwrap();
        let auth = root.join("auth.json");
        std::fs::write(
            &auth,
            r#"{"apiKey":"live-secret","userName":"two","keyName":"k-two"}"#,
        )
        .unwrap();

        let state = list_accounts_sync(
            &root.join("bin/accounts"),
            &root.join("bin/.active_account"),
            &auth,
        );
        assert!(state.available);
        assert_eq!(state.accounts.len(), 2);
        // Numeric-aware sort: 2 before 10.
        assert_eq!(state.accounts[0].id, "2");
        assert_eq!(state.accounts[1].id, "10");
        assert_eq!(state.active_id.as_deref(), Some("2"));
        assert_eq!(state.current_user.as_deref(), Some("two"));

        // Account secrets must never be exposed to the frontend.
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("secret-2"));
        assert!(!json.contains("live-secret"));
        assert!(!json.contains("apiKey"));
    }

    #[test]
    fn unavailable_when_no_accounts() {
        let root = sandbox("empty");
        let state = list_accounts_sync(
            &root.join("bin/accounts"),
            &root.join("bin/.active_account"),
            &root.join("auth.json"),
        );
        assert!(!state.available);
        assert!(state.hint.is_some());
    }

    #[test]
    fn switch_copies_auth_state_and_router_secret() {
        let root = sandbox("switch");
        write_account(&root, "1", "one", "k-one");
        write_account(&root, "2", "two", "k-two");
        std::fs::create_dir_all(root.join(".codex/codex-router")).unwrap();
        let auth = root.join(".commandcode/auth.json");

        let switched = switch_account_sync(
            &root.join("bin/accounts"),
            &root.join("bin/.active_account"),
            &auth,
            &root,
            "2",
        )
        .unwrap();
        assert_eq!(switched.active_id, "2");
        assert_eq!(switched.user_name, "two");

        let auth_raw = std::fs::read_to_string(&auth).unwrap();
        assert!(auth_raw.contains("\"userName\":\"two\""));
        assert_eq!(
            std::fs::read_to_string(root.join("bin/.active_account")).unwrap(),
            "2\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".codex/codex-router/commandcode-api-key.secret"))
                .unwrap(),
            "secret-2\n"
        );

        // Unknown ids and traversal attempts fail without touching auth.
        for bad in ["9", "../1", ""] {
            assert!(switch_account_sync(
                &root.join("bin/accounts"),
                &root.join("bin/.active_account"),
                &auth,
                &root,
                bad,
            )
            .is_err());
        }
        assert!(std::fs::read_to_string(&auth)
            .unwrap()
            .contains("\"userName\":\"two\""));
    }

    #[test]
    fn switch_without_router_dir_still_succeeds() {
        let root = sandbox("switch-norouter");
        write_account(&root, "1", "one", "k-one");
        let auth = root.join("auth.json");
        let switched = switch_account_sync(
            &root.join("bin/accounts"),
            &root.join("bin/.active_account"),
            &auth,
            &root,
            "1",
        )
        .unwrap();
        assert_eq!(switched.user_name, "one");
    }

    #[test]
    fn resolves_layout_from_path() {
        let root = sandbox("layout");
        // canonicalize: temp dirs may live under a symlinked path (/var -> /private/var).
        let root = std::fs::canonicalize(&root).unwrap();
        let script = root.join("bin/cc-switch");
        std::fs::write(&script, "#!/bin/bash\n").unwrap();
        let layout = resolve_cc_switch(&root, Some(root.join("bin").to_str().unwrap())).unwrap();
        assert_eq!(layout.accounts_dir, root.join("bin/accounts"));
        assert_eq!(layout.state_file, root.join("bin/.active_account"));

        assert!(resolve_cc_switch(&root, Some("/nonexistent-dir-xyz")).is_none());
    }

    #[test]
    fn falls_back_to_home_local_bin_without_path() {
        let root = sandbox("fallback");
        // canonicalize: temp dirs may live under a symlinked path (/var -> /private/var).
        let root = std::fs::canonicalize(&root).unwrap();
        std::fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        std::fs::write(root.join("home/.local/bin/cc-switch"), "#!/bin/bash\n").unwrap();
        // An empty PATH (e.g. Finder-launched apps) still resolves via $HOME.
        let layout = resolve_cc_switch(&root.join("home"), Some("")).unwrap();
        assert_eq!(layout.accounts_dir, root.join("home/.local/bin/accounts"));
    }
}
