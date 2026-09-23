use std::{fs, os::unix::fs::PermissionsExt, process::Command};
use tempfile::tempdir;

#[test]
fn default_config_and_legacy_migration_guard() {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let run = |args: &[&str], override_config: Option<&std::path::Path>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_prc"));
        command
            .args(args)
            .env("XDG_CONFIG_HOME", base)
            .env("XDG_STATE_HOME", base)
            .env("HOME", base)
            .env_remove("RC_CONFIG")
            .env_remove("RC_AGENT_TOKEN")
            .env_remove("RC_ADMIN_PASSWORD");
        if let Some(file) = override_config {
            command.env("RC_CONFIG", file);
        }
        command.output().unwrap()
    };
    let old = base.join("pi-remote-control");
    fs::create_dir(&old).unwrap();
    fs::write(old.join("client.json"), "legacy-client").unwrap();
    let blocked = run(&["setup"], None);
    assert!(!blocked.status.success());
    let error = String::from_utf8(blocked.stderr).unwrap();
    assert!(
        error.contains("Legacy private config")
            && error.contains("client.json")
            && error.contains("without overwriting")
    );
    assert!(!base.join("prc/config.json").exists());
    let serve = run(&["serve"], None);
    assert!(!serve.status.success());
    assert!(String::from_utf8_lossy(&serve.stderr).contains("Legacy private config"));
    assert_eq!(fs::read(old.join("client.json")).unwrap(), b"legacy-client");

    let explicit = base.join("override/config.json");
    assert!(run(&["setup"], Some(&explicit)).status.success());
    assert!(explicit.exists());
    assert!(!base.join("prc/config.json").exists());

    fs::write(old.join("config.json"), "legacy-server").unwrap();
    let blocked = run(&["setup"], None);
    assert!(!blocked.status.success());
    assert_eq!(fs::read(old.join("config.json")).unwrap(), b"legacy-server");
    fs::remove_dir_all(&old).unwrap();
    assert!(run(&["setup"], None).status.success());
    let new_config = base.join("prc/config.json");
    assert!(new_config.exists());
    assert_eq!(
        fs::metadata(&new_config).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!base.join("pi-remote-control/config.json").exists());
    let original = fs::read(&new_config).unwrap();
    assert!(!run(&["setup"], None).status.success());
    assert_eq!(fs::read(&new_config).unwrap(), original);
}

#[test]
fn clap_cli_help_version_and_invalid_command() {
    let dir = tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_prc"))
            .args(args)
            .env("XDG_CONFIG_HOME", dir.path())
            .env("XDG_STATE_HOME", dir.path())
            .env("HOME", dir.path())
            .env_remove("RC_CONFIG")
            .output()
            .unwrap()
    };
    for args in [
        &["--help"][..],
        &["setup", "--help"],
        &["serve", "--help"],
        &["--version"],
    ] {
        let output = run(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.stdout.is_empty());
    }
    assert!(String::from_utf8_lossy(&run(&["--help"]).stdout).contains("setup"));
    for flag in ["--version", "-V"] {
        let version = String::from_utf8(run(&[flag]).stdout).unwrap();
        let rest = version
            .trim_end()
            .strip_prefix(concat!("prc ", env!("CARGO_PKG_VERSION"), "+"))
            .expect("version must include build metadata");
        let (commit, date) = rest.split_once(' ').unwrap();
        assert!(
            commit == "unknown"
                || (commit.len() == 7 && commit.bytes().all(|b| b.is_ascii_hexdigit())),
            "{version}"
        );
        assert!(
            date.len() == 20 && date.ends_with('Z') && date.as_bytes()[10] == b'T',
            "{version}"
        );
    }
    for args in [&["bogus"][..], &[], &["serve", "--unknown"]] {
        let output = run(args);
        assert!(!output.status.success());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn setup_private_no_overwrite_and_serve_validation() {
    let dir = tempdir().unwrap();
    let config = dir.path().join("private/config.json");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_prc"))
            .args(args)
            .env("RC_CONFIG", &config)
            .env("XDG_STATE_HOME", dir.path())
            .env_remove("RC_AGENT_TOKEN")
            .env_remove("RC_ADMIN_PASSWORD")
            .env_remove("RC_PORT")
            .env_remove("RC_PUBLIC_ORIGIN")
            .output()
            .unwrap()
    };
    let first = run(&["setup"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(
        fs::metadata(&config).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(config.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(json["publicOrigin"], "http://127.0.0.1:8787");
    let output = String::from_utf8(first.stdout).unwrap();
    assert!(output.contains(json["adminPassword"].as_str().unwrap()));
    assert!(output.contains("Open http://127.0.0.1:8787/"));
    assert!(!output.contains(json["agentToken"].as_str().unwrap()));
    let second = run(&["setup"]);
    assert!(!second.status.success());
    assert!(second.stdout.is_empty());
    assert_eq!(
        json,
        serde_json::from_slice::<serde_json::Value>(&fs::read(&config).unwrap()).unwrap()
    );
    fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
    let invalid = run(&["serve"]);
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("mode 0600"));
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    let mismatch = Command::new(env!("CARGO_BIN_EXE_prc"))
        .arg("serve")
        .env("RC_CONFIG", &config)
        .env("XDG_STATE_HOME", dir.path())
        .env("RC_PORT", "0")
        .env_remove("RC_PUBLIC_ORIGIN")
        .output()
        .unwrap();
    assert!(!mismatch.status.success());
    assert!(String::from_utf8_lossy(&mismatch.stderr).contains("RC_PORT differs"));
}

#[test]
fn setup_does_not_chmod_an_existing_parent_directory() {
    let dir = tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let config = dir.path().join("config.json");
    let result = Command::new(env!("CARGO_BIN_EXE_prc"))
        .arg("setup")
        .env("RC_CONFIG", &config)
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        fs::metadata(config).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn embedded_binary_runs_outside_checkout() {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        time::Duration,
    };
    let dir = tempdir().unwrap();
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = dir.path().join("config.json");
    fs::write(&config, serde_json::json!({"agentToken":"disposable-agent", "adminPassword":"disposable-password", "port":port, "publicOrigin":format!("http://127.0.0.1:{port}")}).to_string()).unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_prc"))
        .arg("serve")
        .current_dir(dir.path())
        .env("RC_CONFIG", config)
        .env("XDG_STATE_HOME", dir.path().join("state"))
        .env("HOME", dir.path())
        .env_remove("RC_AGENT_TOKEN")
        .env_remove("RC_ADMIN_PASSWORD")
        .env_remove("RC_PORT")
        .env_remove("RC_PUBLIC_ORIGIN")
        .env_remove("VAPID_PUBLIC_KEY")
        .env_remove("VAPID_PRIVATE_KEY")
        .spawn()
        .unwrap();
    let mut body = String::new();
    let result = (|| -> std::io::Result<()> {
        for _ in 0..50 {
            if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream
                    .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
                stream.read_to_string(&mut body)?;
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "server did not start",
        ))
    })();
    child.kill().unwrap();
    child.wait().unwrap();
    result.unwrap();
    assert!(body.starts_with("HTTP/1.1 200 OK"));
    assert!(body.contains("/assets/index-"));
    assert_eq!(
        fs::metadata(dir.path().join("state/prc/sessions"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(dir.path().join("state/prc/vapid.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn serve_requires_both_vapid_keys_or_neither() {
    let dir = tempdir().unwrap();
    let config = dir.path().join("config.json");
    fs::write(
        &config,
        serde_json::json!({"agentToken":"a", "adminPassword":"b", "vapidPublicKey":"BAAA"})
            .to_string(),
    )
    .unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_prc"))
        .arg("serve")
        .env("RC_CONFIG", &config)
        .env("XDG_STATE_HOME", dir.path())
        .env_remove("RC_AGENT_TOKEN")
        .env_remove("RC_ADMIN_PASSWORD")
        .env_remove("RC_HOST")
        .env_remove("RC_PORT")
        .env_remove("RC_PUBLIC_ORIGIN")
        .env_remove("VAPID_PUBLIC_KEY")
        .env_remove("VAPID_PRIVATE_KEY")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY together"));
    assert!(!dir.path().join("prc/vapid.json").exists());
}
