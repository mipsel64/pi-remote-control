SHELL := /bin/sh
.DEFAULT_GOAL := build

OS := $(shell uname -s)
BIN_DIR := $(HOME)/.local/bin
CONFIG_HOME := $(or $(XDG_CONFIG_HOME),$(HOME)/.config)
STATE_HOME := $(or $(XDG_STATE_HOME),$(HOME)/.local/state)
CONFIG := $(or $(RC_CONFIG),$(CONFIG_HOME)/prc/config.json)
LABEL := io.github.mipsel64.pi-remote-control
LAUNCH_AGENT := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LAUNCHD_SERVICE = gui/$(shell id -u)/$(LABEL)
LOG_DIR := $(HOME)/Library/Logs/pi-remote-control
SYSTEMD_DIR := $(CONFIG_HOME)/systemd/user

.PHONY: build run serve install setup restart status clean ensure-os

build:
	npm ci --prefix server/web
	npm --prefix server/web run build
	cargo build --manifest-path server/Cargo.toml --release --locked

run: build
	server/target/release/prc serve

serve: $(if $(filter 1,$(REBUILD)),build)
	server/target/release/prc serve

install: build
	@set -eu; \
	mkdir -p "$(BIN_DIR)"; \
	tmp=$$(mktemp "$(BIN_DIR)/.prc.XXXXXX"); \
	trap 'rm -f "$$tmp"' 0; \
	install -m 755 server/target/release/prc "$$tmp"; \
	mv -f "$$tmp" "$(BIN_DIR)/prc"

ensure-os:
	@case "$(OS)" in Darwin|Linux) ;; *) printf 'Unsupported OS: %s\n' "$(OS)" >&2; exit 1 ;; esac

setup: ensure-os
	$(MAKE) install
	@test -e "$(CONFIG)" || "$(BIN_DIR)/prc" setup
ifeq ($(OS),Darwin)
	@set -eu; umask 077; \
	mkdir -p "$(LOG_DIR)" "$(dir $(LAUNCH_AGENT))"; \
	tmp="$(LAUNCH_AGENT).tmp"; \
	cp examples/macos/pi-remote-control.plist "$$tmp"; \
	plutil -remove ProgramArguments.0 "$$tmp"; \
	plutil -insert ProgramArguments.0 -string "$(BIN_DIR)/prc" "$$tmp"; \
	plutil -replace EnvironmentVariables.HOME -string "$(HOME)" "$$tmp"; \
	plutil -replace EnvironmentVariables.XDG_CONFIG_HOME -string "$(CONFIG_HOME)" "$$tmp"; \
	plutil -replace EnvironmentVariables.XDG_STATE_HOME -string "$(STATE_HOME)" "$$tmp"; \
	plutil -replace StandardOutPath -string "$(LOG_DIR)/stdout.log" "$$tmp"; \
	plutil -replace StandardErrorPath -string "$(LOG_DIR)/stderr.log" "$$tmp"; \
	plutil -lint "$$tmp" >/dev/null; \
	chmod 644 "$$tmp"; \
	mv -f "$$tmp" "$(LAUNCH_AGENT)"
	launchctl enable "$(LAUNCHD_SERVICE)"
else ifeq ($(OS),Linux)
	mkdir -p "$(SYSTEMD_DIR)"
	install -m 644 examples/linux/pi-remote-control.service "$(SYSTEMD_DIR)/pi-remote-control.service"
	systemctl --user daemon-reload
	systemctl --user enable pi-remote-control.service
endif
	$(MAKE) restart REBUILD=0

restart: ensure-os
ifeq ($(REBUILD),1)
	$(MAKE) install
endif
ifeq ($(OS),Darwin)
	@set -eu; \
	if launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; then \
		launchctl bootout "$(LAUNCHD_SERVICE)" || true; \
		waited=0; \
		while launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; do \
			if test "$$waited" -ge 30; then printf 'Still loaded after 30s; rerun make restart.\n' >&2; exit 1; fi; \
			sleep 1; waited=$$((waited + 1)); \
		done; \
	fi; \
	launchctl bootstrap "gui/$$(id -u)" "$(LAUNCH_AGENT)"
else ifeq ($(OS),Linux)
	systemctl --user restart pi-remote-control.service
endif

status: ensure-os
ifeq ($(OS),Darwin)
	launchctl print "$(LAUNCHD_SERVICE)"
else ifeq ($(OS),Linux)
	systemctl --user status --no-pager pi-remote-control.service
endif

clean: ensure-os
ifeq ($(OS),Darwin)
	@if launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; then launchctl bootout "$(LAUNCHD_SERVICE)"; fi
	rm -f "$(LAUNCH_AGENT)"
else ifeq ($(OS),Linux)
	@set -eu; \
	if test -e "$(SYSTEMD_DIR)/pi-remote-control.service" || systemctl --user is-active --quiet pi-remote-control.service; then \
		systemctl --user stop pi-remote-control.service || true; \
		systemctl --user disable pi-remote-control.service 2>/dev/null || true; \
		rm -f "$(SYSTEMD_DIR)/pi-remote-control.service"; \
		systemctl --user daemon-reload; \
	fi
endif
	rm -f "$(BIN_DIR)/prc"
