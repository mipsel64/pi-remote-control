use std::{env, path::Path, process::Command};

fn output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output.status.success().then_some(())?;
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-env-changed=GIT_SHA");
    println!("cargo:rerun-if-env-changed=BUILD_DATE");
    for name in ["HEAD", "refs", "packed-refs"] {
        if let Some(path) = output("git", &["rev-parse", "--git-path", name]) {
            if Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
    let commit = env::var("GIT_SHA")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| output("git", &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    assert!(
        commit == "unknown" || (commit.len() >= 7 && commit.bytes().all(|b| b.is_ascii_hexdigit())),
        "GIT_SHA must be a hexadecimal commit hash or unknown"
    );
    let date = env::var("BUILD_DATE")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| output("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]))
        .expect("cannot determine build date; set BUILD_DATE to YYYY-MM-DDTHH:MM:SSZ");
    assert!(
        date.len() == 20
            && date.bytes().enumerate().all(|(i, b)| match i {
                4 | 7 => b == b'-',
                10 => b == b'T',
                13 | 16 => b == b':',
                19 => b == b'Z',
                _ => b.is_ascii_digit(),
            }),
        "BUILD_DATE must use YYYY-MM-DDTHH:MM:SSZ"
    );
    println!(
        "cargo:rustc-env=PRC_VERSION={}+{} {date}",
        env::var("CARGO_PKG_VERSION").unwrap(),
        &commit[..7]
    );
}
