# Pi Remote Control

View **already-running interactive** Pi sessions in a browser: active-branch history, live output, prompts, follow-ups while busy, and stop. The server never starts Pi or edits its session files. Remote prompts can run tools with your local OS permissions; treat access like SSH.

## Install and run the server

Download the archive for your platform from [Releases](../../releases): `prc-vX.Y.Z-darwin-arm64.tar.gz`, `darwin-amd64`, `linux-amd64`, or `linux-arm64`. Verify it against `checksums.txt` from the same release (`shasum -a 256 -c checksums.txt --ignore-missing` on macOS, `sha256sum -c checksums.txt --ignore-missing` on Linux), extract it (`tar -xzf prc-*.tar.gz`), and move `prc` to a stable directory. The archive also contains `LICENSE`, this README, and the service `examples/`. The release binaries are not yet notarized; macOS Gatekeeper may ask you to approve the verified binary in System Settings → Privacy & Security. No repository checkout, Node, npm, or Cargo is needed to **run the server**. Linux builds use Ubuntu 22.04 (glibc 2.35 or newer).

```sh
/absolute/path/to/prc setup
/absolute/path/to/prc serve
```

`prc setup` creates `~/.config/prc/config.json` (or `$XDG_CONFIG_HOME/prc/config.json`) with mode 0600, prints the admin password **once**, and prints the default local browser URL. Save the password privately; setup never overwrites an existing config. `prc serve` binds loopback (`127.0.0.1:8787`) by default and prints the configured canonical browser URL. Use that URL, or on the server computer open `http://127.0.0.1:8787` or `http://localhost:8787` (substitute a custom port). If the port is occupied, stop **your own** prior `prc` instance or choose a different `RC_PORT` and matching `publicOrigin`—do not start a second server expecting it to update the first.

For private remote access, install/configure [Tailscale](https://tailscale.com/) on the server and your phone and put **Tailscale Serve**, not Funnel, in front of the loopback listener:

```sh
tailscale serve --bg 8787
tailscale serve status
```

Take the exact `https://<tailnet-host>` origin shown by Tailscale Serve (including a port if nonstandard). Edit only `"publicOrigin"` in the private config to that origin, **without a trailing slash or path**; restart `prc serve`. Alternatively set `RC_PUBLIC_ORIGIN` to the same exact origin in the server environment; a same-host Pi process reading the config will then need paired `PI_RC_URL` / `PI_RC_AGENT_TOKEN` overrides if the config still has the old origin. With the default loopback bind, browser login accepts that exact HTTPS origin **and** local loopback origins at the server port. Other origins remain blocked with **403**; wrong password returns **401**. For remote use, the extension derives `wss://<tailnet-host>/agent` from `publicOrigin` in the config. Never expose plain HTTP/WebSocket to an untrusted network or use Tailscale Funnel.

The server reads config at startup. After changing the private config (including origin or credentials), restart **that running `prc serve` process**; in attached Pi sessions run `/rc close` then `/rc` to reload their connection settings. `RC_HOST` (default `127.0.0.1`), `RC_PORT` (default `8787`), `RC_PUBLIC_ORIGIN`, `RC_AGENT_TOKEN`, and `RC_ADMIN_PASSWORD` override server config for explicit deployments/tests. A changed loopback `RC_PORT` requires a matching loopback `publicOrigin` (or `RC_PUBLIC_ORIGIN`); otherwise serve refuses to start. `RC_CONFIG` selects a different private config path for the server and local Pi; keep it mode 0600. Do not put credentials in URLs, logs, service definitions, or browser storage.

If upgrading from the old default, **before running setup**, check `~/.config/pi-remote-control/` (or `$XDG_CONFIG_HOME/pi-remote-control/` when XDG is set). If it contains `config.json` or `client.json`, manually move **both files that exist** into `~/.config/prc/` (or `$XDG_CONFIG_HOME/prc/`), creating the destination privately; **never overwrite** an existing destination file. Keep each file mode 0600. The server and Pi refuse the new missing default while legacy files remain, rather than generating new credentials or silently using old ones. Explicit `RC_CONFIG` paths are unaffected. After migrating, restart `prc serve` and run `/reload` in Pi or `/rc close` then `/rc` in attached sessions.

## Attach Pi sessions (separate installation)

On a host with Pi and Node 22.18+, install the **npm extension package** separately (`pi install npm:pi-prc`; for development from a checkout, `pi install .`). If Pi was already running when you installed it, run `/reload` in the existing Pi process to load the extension. Installing does **not** automatically connect or expose any session. Run `/rc` in each interactive Pi process you want to attach; it immediately sends current complete active-branch history, including messages from before attachment. `/rc status` checks the connection; `/rc close` disconnects and stops retries. `/rc setup` shows effective agent endpoint, config source, redacted token status, and connection state, and in interactive Pi can edit the **client URL only**. Open the server's canonical URL, sign in, and select a session. Prompts, stop, and the composer's model and thinking-level pickers need a running, attached Pi process; the model list is Pi's scoped models (or all models with configured auth). Offline sessions are read-only and show their last known model. The pencil next to an online session's title renames it via Pi's session name; saving an empty name clears it.

`prc serve` keeps a private copy of each attached session's latest transcript and metadata in `$XDG_STATE_HOME/prc` (default `~/.local/state/prc`; directory mode 0700, files mode 0600) so offline sessions keep their conversation across server restarts. It keeps the 50 most recent sessions. To clear it, stop `prc` and delete that directory.

On a different Pi host, set **both** overrides in that Pi process's environment (not in the URL):

```sh
PI_RC_URL='wss://your-tailnet-host/agent' PI_RC_AGENT_TOKEN='your-agent-token' pi
```

The token is stored in the server's private config, not printed by setup; transfer it securely to a private client config or secret environment provider. `PI_RC_URL` and `PI_RC_AGENT_TOKEN` take precedence as a pair over local config. `/rc setup` shows these overrides but refuses to edit them; unset both before editing client settings. If only one is set, `/rc` refuses to connect and `/rc setup` explains why. Without either override, the extension reads the server's private config and an optional **separate client-only** `client.json` alongside it (`~/.config/prc/client.json`, or the directory of `$RC_CONFIG`). This file can override the agent `url` and/or `token` without changing server config. `/rc setup` writes only `url` to that client file, keeps any existing token, and creates the file with mode 0600. For a token on a different Pi host, edit this private client file **outside Pi** with a `"token"` string and mode 0600, or use paired environment overrides. Pi's input dialog does not mask secrets, so `/rc setup` deliberately never prompts for or displays token contents; its notices show `[redacted]`. After changing client settings, use `/rc close` then `/rc` to reconnect. Agent URLs must end in `/agent`, contain no credentials or query string, and use `wss://` for non-loopback hosts (`ws://` is accepted only for localhost/127.0.0.1/::1). If neither server nor client config has a usable URL and token, `/rc` stays disconnected and explains setup.

## Docker

Each release also publishes a multi-arch (amd64/arm64) image to GHCR: `ghcr.io/mipsel64/pi-remote-control:vX.Y.Z` (and `:latest` for stable releases; `:nightly` tracks `main`). The container binds `0.0.0.0:8787`, runs as a non-root user, and stores transcripts in `/var/lib/prc`. Configure it with environment variables instead of `prc setup`; keep secrets in a mode-0600 env file rather than on the command line:

```sh
cat > prc.env <<'ENV'
RC_PUBLIC_ORIGIN=http://localhost:8787
RC_AGENT_TOKEN=<long random token>
RC_ADMIN_PASSWORD=<long random password>
ENV
chmod 600 prc.env
docker run -d --name prc --restart unless-stopped -p 127.0.0.1:8787:8787 \
  --env-file prc.env -v prc-state:/var/lib/prc ghcr.io/mipsel64/pi-remote-control:latest
```

`RC_PUBLIC_ORIGIN` must be the exact origin your browser uses (e.g. your Tailscale Serve `https://<tailnet-host>` origin in front of the published port). Pi processes attach with `PI_RC_URL='ws://localhost:8787/agent'` (or `wss://<tailnet-host>/agent`) and `PI_RC_AGENT_TOKEN` set to the same token. Push notification keys are generated in `/var/lib/prc/vapid.json`, so keep that volume; `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and optional `VAPID_SUBJECT` override them.

## Run as a login service

From a source checkout (Node 22.18+ and Rust), the Makefile builds, installs, and manages a per-user service: a macOS LaunchAgent or a Linux systemd user unit. No `sudo` is needed. Stop any `prc serve` you started by hand first, since both use port 8787.

| Command | Description |
|---|---|
| `make install` | Build and install to `~/.local/bin/prc`. |
| `make setup` | Install, run `prc setup` if there is no config yet (prints the admin password once), then enable and start the service. |
| `make restart` | Restart the service without rebuilding. |
| `make restart REBUILD=1` | Build, install, then restart. |
| `make status` | Print the launchd/systemd service status. |
| `make clean` | Stop and remove the service and `~/.local/bin/prc` (config and state are kept). |
| `make serve` | Run the built binary in the foreground (`REBUILD=1` builds first). |

Logs: `~/Library/Logs/pi-remote-control/` on macOS, `journalctl --user -u pi-remote-control.service -f` on Linux. The service starts at login; on Linux, `loginctl enable-linger "$USER"` optionally keeps it running after logout. It never manages Pi processes; start interactive Pi separately and use `/rc`.

**Release binary instead of a checkout:** put `prc` at `~/.local/bin/prc` and run `prc setup` as the same user. On Linux, copy [examples/linux/pi-remote-control.service](examples/linux/pi-remote-control.service) to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now pi-remote-control.service`. On macOS, copy [examples/macos/pi-remote-control.plist](examples/macos/pi-remote-control.plist) to `~/Library/LaunchAgents/io.github.mipsel64.pi-remote-control.plist`, replace the `/ABSOLUTE/PATH/TO/...` placeholders with absolute paths, then `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/io.github.mipsel64.pi-remote-control.plist`. The private config stays outside unit files; with a custom `RC_CONFIG`, set it in the service environment without embedding secrets.

## Optional notifications

Choose **Enable notifications** in the sidebar to get a notification whenever a Pi prompt finishes. It works out of the box over HTTPS (for example Tailscale Serve), including on iPhone after **Add to Home Screen**; the notification survives a locked screen or closed tab. On `http://localhost`, desktop browsers get in-page notifications while the tab is open, even in the background. If the browser has blocked notifications, allow them for the site in its settings first. The server logs failed deliveries (push service host only).

**iPhone/iPad:** Safari only offers notifications to web apps opened from the Home Screen, so the button does not appear in a normal Safari tab (the sidebar shows a hint instead). Open the HTTPS address in Safari, tap Share → **Add to Home Screen**, open Pi Remote Control from the new icon, sign in, and choose **Enable notifications**. Notification settings are per Home Screen app, not per Safari tab.

`prc serve` generates Web Push keys on first start in `vapid.json` in the state directory (mode 0600) and reuses them; explicit `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (config `vapidPublicKey`, `vapidPrivateKey`) must be set together and still take precedence. `VAPID_SUBJECT` (`vapidSubject`) defaults to the HTTPS `publicOrigin`. Push subscriptions are saved in `subscriptions.json` there too, so they survive server restarts. Notifications show the session name, which may be the first prompt, on the lock screen; payloads are end-to-end encrypted to your browser and never contain transcripts. Core control works without notifications.

The app shell can load offline; conversations and commands require a connected server and Pi process. Browser logins reset on server restart.

For source development only: `npm test` tests the extension; `npm --prefix server/web test` tests and builds the frontend; `cargo test --manifest-path server/Cargo.toml --locked` tests the Rust server. Run `make build` to build a release binary at `server/target/release/prc` (see the Makefile table above for install and service targets). `prc --version` prints the version, commit, and UTC build date (`GIT_SHA`/`BUILD_DATE` override them). A release embeds the built `server/web/dist` assets into the single `prc` binary, which serves the UI outside the repository. `docker build -t prc .` builds the container image.

## Releasing

CI runs extension, frontend, and Rust checks (fmt, clippy, tests), dependency audits, and a Docker build on every pull request; pushes to `main` also publish `ghcr.io/…:nightly`. To release, set the same version in `package.json` and `server/Cargo.toml`, refresh the lockfiles (`npm install --package-lock-only` and `cargo update -p prc --manifest-path server/Cargo.toml`), commit, then push a `vX.Y.Z` tag. The release workflow builds and tests the four binaries, publishes the Docker image and the `pi-prc` npm package (npm trusted publishing), and creates the GitHub release with archives and `checksums.txt`. Tags with a suffix (`v0.2.0-rc.1`) become prereleases: they do not move the image's `:latest` and publish to npm under the `next` dist-tag. One-time setup before the first tag: publish `pi-prc` once by hand (`npm publish`), then add a trusted publisher on npmjs.com for this repository and workflow `release.yml`; otherwise the npm job fails after the image is pushed and the GitHub release is skipped (publish by hand and re-run to recover).
