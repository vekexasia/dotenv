# dotenv

Personal Linux/WSL configuration. This checkout is the source of truth: run `./setup_env.sh` to install required tools and overwrite managed configuration from this repository. Omarchy/Arch uses `omarchy pkg add`; Debian/Ubuntu uses `apt-get`.

## Install

```bash
git clone https://github.com/vekexasia/dotenv.git ~/git/personale/dotenv
~/git/personale/dotenv/setup_env.sh
```

Managed: Neovim, tmux, WezTerm (WSL), Herdr configuration, clipboard helpers, Pi, and shell additions. Pi configuration is linked from this checkout; an existing `~/.pi/agent` directory is backed up before linking.

`gh` and `glab` are installed but still require `gh auth login` and `glab auth login`.

Herdr itself is not installed. Its configuration is managed, and Pi integration is refreshed when Herdr is present.
