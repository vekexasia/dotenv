# Pi configuration

This directory is installed to `~/.pi/agent` by the parent repository's `setup_env.sh`.

The installer overwrites tracked configuration on every run but preserves credentials and runtime state: `auth.json`, `ha.json`, Home Assistant configuration, trust decisions, sessions, package clones, locks, logs, and `node_modules`.

The workflow and Herdr package entries in `settings.json` still require a checkout at `~/git/personale/pi-workflows`. They remain local paths until that project is packaged or added to this repository.
