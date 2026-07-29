# dotenv

Personal Linux/WSL configuration. This checkout is the source of truth: run `./setup_env.sh` to install required tools and overwrite managed configuration from this repository.

## Install

```bash
git clone https://github.com/vekexasia/dotenv.git ~/git/personale/dotenv
~/git/personale/dotenv/setup_env.sh
```

Managed: Neovim, tmux, WezTerm (WSL), clipboard helpers, Pi, and shell additions. Pi configuration is linked from this checkout; existing credentials and runtime state are migrated into it.

`gh` and `glab` are installed but still require `gh auth login` and `glab auth login`.

Herdr is intentionally not managed yet.
