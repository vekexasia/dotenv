#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi

case "${ID:-}:${ID_LIKE:-}" in
  omarchy:*|*:arch*|arch:*)
    PACKAGE_MANAGER=arch
    ;;
  debian:*|ubuntu:*|*:debian*)
    PACKAGE_MANAGER=debian
    ;;
  *)
    printf 'Unsupported Linux distribution: ID=%s ID_LIKE=%s\n' "${ID:-unknown}" "${ID_LIKE:-unknown}" >&2
    exit 1
    ;;
esac

install_package() {
  local command_name=$1 package_name=${2:-$1}
  command -v "$command_name" >/dev/null 2>&1 && return
  case "$PACKAGE_MANAGER" in
    arch)
      if command -v omarchy >/dev/null 2>&1; then
        omarchy pkg add "$package_name"
      else
        sudo pacman -S --needed --noconfirm "$package_name"
      fi
      ;;
    debian)
      sudo apt-get install -y "$package_name"
      ;;
  esac
}

install_release() {
  local repository=$1 asset_pattern=$2 binary=$3
  { [ -x "$HOME/.bin/$binary" ] || command -v "$binary" >/dev/null 2>&1; } && return
  local workdir url
  workdir=$(mktemp -d)
  url=$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" | jq -r --arg pattern "$asset_pattern" '.assets[] | select(.name | test($pattern)) | .browser_download_url' | head -1)
  [ -n "$url" ]
  [ "$url" != null ]
  curl -fsSL "$url" -o "$workdir/release.tar.gz"
  tar -xzf "$workdir/release.tar.gz" -C "$workdir"
  install -Dm755 "$(find "$workdir" -type f -name "$binary" -perm -u+x | head -1)" "$HOME/.bin/$binary"
  rm -rf "$workdir"
}

append_once() {
  local line=$1 file=${2:-"$HOME/.bashrc"}
  touch "$file"
  grep -Fqx -- "$line" "$file" || printf '\n%s\n' "$line" >> "$file"
}

sync_pi() {
  local target="$HOME/.pi/agent"
  mkdir -p "$HOME/.pi"

  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$REPO_DIR/pi/agent" ]; then
    return
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    local backup="$target.backup.$(date +%s)"
    mv -- "$target" "$backup"
    printf 'Backed up existing Pi agent directory to %s\n' "$backup"
  fi

  ln -s "$REPO_DIR/pi/agent" "$target"
}

if [ "$PACKAGE_MANAGER" = debian ]; then
  sudo apt-get update
  package_specs=(
    'make:make' 'gcc:gcc' 'g++:g++' 'rg:ripgrep' 'git:git' 'curl:curl' 'xclip:xclip' 'jq:jq'
    'tree:tree' 'htop:htop' 'fdfind:fd-find' 'rsync:rsync' 'fzf:fzf' 'batcat:bat'
    'gh:gh' 'glab:glab' 'python3:python3' 'python3-venv:python3-venv'
  )
else
  package_specs=(
    'make:make' 'gcc:gcc' 'g++:gcc' 'rg:ripgrep' 'git:git' 'curl:curl' 'xclip:xclip' 'jq:jq'
    'tree:tree' 'htop:htop' 'fd:fd' 'rsync:rsync' 'fzf:fzf' 'bat:bat'
    'gh:github-cli' 'glab:glab' 'python3:python'
  )
fi

for spec in "${package_specs[@]}"; do
  install_package "${spec%%:*}" "${spec#*:}"
done

if [ "$IS_WSL" -eq 1 ]; then
  install_package wl-copy wl-clipboard
  install_package convert imagemagick
fi

mkdir -p "$HOME/.bin" "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$HOME/.bin:/usr/local/go/bin:/opt/nvim-linux-x86_64/bin:$PATH"
command -v bat >/dev/null 2>&1 || ln -sf "$(command -v batcat)" "$HOME/.bin/bat"
if [ "$PACKAGE_MANAGER" = arch ]; then
  install_package lazygit lazygit
  install_package zellij zellij
else
  install_release jesseduffield/lazygit '_linux_x86_64\.tar\.gz$' lazygit
  install_release zellij-org/zellij '^zellij-x86_64-unknown-linux-musl\.tar\.gz$' zellij
fi
append_once 'export PATH="$HOME/.bin:$PATH"'
append_once 'export PATH="$HOME/.local/bin:$PATH"'
append_once 'export PATH="$PATH:/usr/local/go/bin"'
append_once 'export PATH="$PATH:/opt/nvim-linux-x86_64/bin"'
append_once 'eval "$(fzf --bash)"'
append_once 'export BAT_THEME="TwoDark"'
append_once 'export PI_ANTHROPIC_OAUTH_REWRITE_MODE="technical-safe"'
append_once "alias ll='ls -alF'"
append_once "alias herdr-devbox='herdr --remote devbox-hz --remote-keybindings server'"
append_once 'export SUDO_EDITOR="nvim"'
append_once "export FZF_ALT_C_OPTS=\"--walker-skip .git,node_modules,target --preview 'tree -C {}'\""
append_once "export FZF_CTRL_T_OPTS=\"--walker-skip .git,node_modules,target --preview 'bat -n --color=always --style=numbers {}' --bind 'ctrl-/:change-preview-window(down|hidden|)'\""

if ! command -v go >/dev/null 2>&1 && [ "$PACKAGE_MANAGER" = arch ]; then
  install_package go go
fi

if ! command -v go >/dev/null 2>&1; then
  go_version=1.24.4
  archive=$(mktemp)
  curl -fsSL "https://go.dev/dl/go${go_version}.linux-amd64.tar.gz" -o "$archive"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$archive"
  rm -f "$archive"
fi

nvim_bin=$(command -v nvim || true)
nvim_version=$([ -n "$nvim_bin" ] && "$nvim_bin" --version | head -1 | sed 's/^NVIM v//' || true)
if [ -z "$nvim_version" ] || [ "$(printf '%s\n' 0.12.0 "$nvim_version" | sort -V | head -1)" != 0.12.0 ]; then
  if [ "$PACKAGE_MANAGER" = arch ]; then
    install_package nvim neovim
    nvim_bin=$(command -v nvim)
  else
  archive=$(mktemp)
  curl -fsSL https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.tar.gz -o "$archive"
  sudo rm -rf /opt/nvim-linux-x86_64
  sudo tar -C /opt -xzf "$archive"
  rm -f "$archive"
    nvim_bin=/opt/nvim-linux-x86_64/bin/nvim
  fi
fi

mkdir -p "$HOME/.config"
rsync -a --delete --exclude=node_modules/ "$REPO_DIR/nvim/" "$HOME/.config/nvim/"
install -Dm644 "$REPO_DIR/herdr/config.toml" "$HOME/.config/herdr/config.toml"
if [ "$(hostname -s)" = "devbox" ]; then
  sed -i '/^\[ui\]$/a copy_on_select = false' "$HOME/.config/herdr/config.toml"
fi
install -Dm644 "$REPO_DIR/.tmux.conf" "$HOME/.tmux.conf"

if [ "$IS_WSL" -eq 1 ]; then
  mkdir -p "$HOME/.local/bin"
  rsync -a "$REPO_DIR/.local/bin/" "$HOME/.local/bin/"
  if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    windows_home=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')
    [ -n "$windows_home" ] && install -Dm644 "$REPO_DIR/.wezterm.lua" "$(wslpath "$windows_home")/.wezterm.lua"
  fi
fi

venv="$HOME/.local/share/nvim/gigatoken-venv"
if [ ! -x "$venv/bin/python" ]; then
  python3 -m venv "$venv"
  "$venv/bin/pip" install gigatoken
fi

if [ "$PACKAGE_MANAGER" = arch ]; then
  # Omarchy activates mise globally, and its pi shim precedes ~/.local/bin in
  # PATH while leaking mise output into pi's stdout. Own pi via npm instead.
  grep -q mise "$HOME/.local/bin/pi" 2>/dev/null && rm -f "$HOME/.local/bin/pi"
  if command -v mise >/dev/null 2>&1; then
    mise unuse -g pi
    mise uninstall --all pi
  fi
  npm install -g --ignore-scripts --prefix "$HOME/.local" @earendil-works/pi-coding-agent
fi

sync_pi
npx skills add herdrdev/herdr --skill herdr --global --agent pi --copy --yes
npx skills@latest add mattpocock/skills --skill triage grill-me grilling wayfinder domain-modeling prototype research --global --agent pi --copy --yes
npx skills add https://github.com/pedronauck/skills --skill typescript-advanced --global --agent pi --copy --yes
npx skills add humanlayer/skills --skill show-me --global --agent pi --copy --yes
if command -v herdr >/dev/null 2>&1; then
  [ -x /usr/local/bin/bun ] || sudo "$(command -v npm)" install -g --prefix /usr/local bun
  herdr plugin install plannotator/herdr-annotate/lite --yes
  herdr integration install pi
fi
command -v pi >/dev/null 2>&1 && pi update --extensions
(cd "$HOME/.config/nvim" && npm ci)
command -v tsgo >/dev/null 2>&1 || npm install -g --prefix "$HOME/.local" @typescript/native-preview
# tree-sitter-cli ships only an install.js that downloads the real binary in a
# postinstall step. pi's npm policy blocks install scripts, so a plain install
# leaves the package dir present but the binary missing, and Neovim -- which
# spawns it by absolute path, not via PATH -- fails with ENOENT. Force scripts
# for this one package, then verify/repair the exact binary Neovim will spawn.
TS_CLI_BIN="$HOME/.local/lib/node_modules/tree-sitter-cli/tree-sitter"
if [ ! -x "$TS_CLI_BIN" ]; then
  npm install -g --prefix "$HOME/.local" --foreground-scripts --include=optional tree-sitter-cli
fi
if [ ! -x "$TS_CLI_BIN" ] && [ -f "$HOME/.local/lib/node_modules/tree-sitter-cli/install.js" ]; then
  (cd "$HOME/.local/lib/node_modules/tree-sitter-cli" && node install.js)
fi
[ -x "$TS_CLI_BIN" ] || { printf 'tree-sitter binary missing after install: %s\n' "$TS_CLI_BIN" >&2; exit 1; }
"$nvim_bin" --headless "+Lazy! restore" +qa
"$nvim_bin" --headless "+MasonInstall markdownlint" +qa
"$nvim_bin" --headless "+lua require('nvim-treesitter').install({'bash','c','diff','html','lua','luadoc','markdown','markdown_inline','query','vim','vimdoc','typescript','javascript'}):wait(300000)" +qa
