#!/usr/bin/env bash

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

IS_WSL=0
if grep -qi Microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi

checkExists () {
  # First arg is always the command to check
    local cmd="$1"
    
    # Check if the fucking command exists
    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Command '$cmd' is already installed${NC}"
        return 0
    fi
    return 1
}

checkAndInstall() {
    local cmd="$1"
    local pkg="${2:-$1}"
    if checkExists "$@"; then
      return 0
    fi

    # Command doesn't exist - let's fucking install it
    echo -e "${RED}✗ Command '$cmd' not found, installing package '$pkg'...${NC}"
    
    # Install the goddamn package
    if sudo apt-get install -y "$pkg"; then
        echo -e "${GREEN}✓ Successfully installed package '$pkg'${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to install package '$pkg'.${NC}"
        return 1
    fi
}
function patchFile() {
  # checks if line in $2 is in $1 and if not appends it
  if ! grep -q "$2" "$1"; then
    echo -e "${GREEN}✓ Patched $1 with $2.${NC}"
    echo "$2" >> "$1"
  fi
}
function patchBashrc() {
  # checks if line in $1 is in .bashrc and if not appends it
  patchFile "$HOME/.bashrc" "$1"
}

function downloadFromGH () {

  URL="https://api.github.com/repos/$1/releases/latest"

  ASSET=`curl -s $URL | jq -r ".assets[] | select(.name | test(\"$2\")) | .browser_download_url"`
  echo -e "${GREEN}✓ Downloading $ASSET${NC}"
  curl -L -s -o $2 $ASSET
}

function downloadAndInstall () {
  if [ -f "$HOME/.bin/$3" ]; then
    return 1
  fi
  downloadFromGH $1 $2
  FOLDER=$(echo "$1" | cut -d'/' -f2)
  echo $FOLDER
  mkdir -p $FOLDER
  tar -xvf $2 -C "$FOLDER"
  rm $2
  cd $FOLDER || (echo "${RED} x cannot enter $FOLDER${NC}" && return 1)
  find . -type f -executable -name $3 -exec mv {} "$HOME/.bin/$3" \;
  cd .. || (echo "${RED} x cannot exit $FOLDER${NC}" && return 1)
  rm -rf $FOLDER
  return 0
}
function installFromThisRepo() {
  curl -L -s "https://github.com/vekexasia/dotenv/raw/master/$1" -o "$HOME/$1"
  if [ $? != 0 ]; then
    echo "${RED} x Failed to download $1${NC}"
    return 1
  fi
  if [ "$2" == "x" ]; then
    chmod +x "$HOME/$1"
  fi
}

mkdir -p $HOME/.bin
if [ "$IS_WSL" -eq 1 ]; then
  mkdir -p $HOME/.local/bin
fi

checkAndInstall make
checkAndInstall gcc
checkAndInstall rg ripgrep 
checkAndInstall git
checkAndInstall xclip
checkAndInstall jq
checkAndInstall tree
checkAndInstall htop
checkAndInstall fdfind fd-find

if [ "$IS_WSL" -eq 1 ]; then
  checkAndInstall wl-copy wl-clipboard
  checkAndInstall convert imagemagick
fi

if ! checkExists go; then
  GOVERSION="1.24.4"
  sudo rm -rf /usr/local/go
  wget https://go.dev/dl/go$(echo GOVERSION).linux-amd64.tar.gz
  sudo tar -C /usr/local -xzf go$(echo GOVERSION).linux-amd64.tar.gz
  rm go$(echo GOVERSION).linux-amd64.tar.gz*
fi


downloadFromGH "neovim/neovim" "nvim-linux-x86_64.tar.gz"
sudo rm -rf /opt/nvim-linux-x86_64
sudo tar -C /opt -xzf nvim-linux-x86_64.tar.gz
rm ./nvim-linux-x86_64.tar.gz

downloadAndInstall "jesseduffield/lazygit" "Linux_x86_64.tar.gz" "lazygit"
downloadAndInstall "junegunn/fzf" "linux_amd64.tar.gz" "fzf"
downloadAndInstall "zellij-org/zellij" "x86_64-unknown-linux-musl.tar.gz" "zellij"
downloadAndInstall "sharkdp/bat" "x86_64-unknown-linux-gnu.tar.gz" "bat"

patchBashrc "export PATH=\$PATH:\$HOME/.bin"
if [ "$IS_WSL" -eq 1 ]; then
  patchBashrc 'export PATH="$HOME/.local/bin:$PATH"'
fi
patchBashrc "export PATH=\$PATH:/usr/local/go/bin"
patchBashrc 'eval "$(fzf --bash)"'
patchBashrc "export BAT_THEME=\"TwoDark\""
patchBashrc "alias ll='ls -alF'"
patchBashrc "export SUDO_EDITOR=\"nvim\""

# fix wsl keyring for ssh key
if [ "$IS_WSL" -eq 1 ]; then
  if ! command -v keyring &> /dev/null; then
    echo "keyring is not installed. Installing keyring"
    sudo apt install keyring -y
  fi

  # test if id_rsa is present
  if [ ! -f "$HOME/.ssh/id_rsa" ]; then
    echo "id_rsa not found, add to install keyring for automatic load"
    patchBashrc "/usr/bin/keychain -q --nogui $HOME/.ssh/id_rsa"
    patchBashrc "source $HOME/.keychain/$HOSTNAME-sh"
  fi
fi

mkdir -p $HOME/.ssh
if [ ! -f "$HOME/.ssh/authorized_keys" ]; then
  echo "authorized_keys not found, creating one"
  touch $HOME/.ssh/authorized_keys
fi

patchFile "$HOME/.ssh/authorized_keys" "ssh-rsa AAAAB3NzaC1yc2EAAAABJQAAAQB7aUxv+eWA7AROzbOInaLLKxecKsj8i/TadsLhK/1FgPOGqrnYGWzi2SOnJSamH7VaegRMRN2qKT++3niWDv1vWttPMGFA+KnhCtR5ZuLs3vYnHkGukD4nn+h0TfKz6W3zX+E0rVH+7PwxEV9jq8oeCGYeNce0105uNo6g5Hn0xlrHJDomcfx3/3BeRXC1kDoTQ5WrltLsBrlA5KoVG4pkQgv/WN8jncZRRG9jZEmYLiLQ5TafjeQjjhMsrokXlqyU65UJsjHNQMDcTUR6lhGOvATkNUbXX+g5JOBfKM4U8xKsk7e/cV5tMO0VrUNmCpX4Mq/pcx3MzFMhbpv9Zkb5 vekexasia"
patchBashrc "export FZF_ALT_C_OPTS=\"--walker-skip .git,node_modules,target --preview 'tree -C {}'\""
patchBashrc "export FZF_CTRL_T_OPTS=\"--walker-skip .git,node_modules,target --preview 'bat -n --color=always --style=numbers {}' --bind 'ctrl-/:change-preview-window(down|hidden|)'\""
patchBashrc 'export PATH="$PATH:/opt/nvim-linux-x86_64/bin"'

TMP_DOTENV_DIR=$(mktemp -d)
if ! git clone --depth 1 https://github.com/vekexasia/dotenv.git "$TMP_DOTENV_DIR/dotenv"; then
  echo -e "${RED}✗ Failed to clone dotenv repo${NC}"
  rm -rf "$TMP_DOTENV_DIR"
  exit 1
fi

rm -rf "$HOME/.config/nvim"
mkdir -p "$HOME/.config/nvim"
cp -R "$TMP_DOTENV_DIR/dotenv/nvim/." "$HOME/.config/nvim/"

if [ "$IS_WSL" -eq 1 ]; then
  if [ -d "$TMP_DOTENV_DIR/dotenv/.local/bin" ]; then
    mkdir -p "$HOME/.local/bin"
    cp -R "$TMP_DOTENV_DIR/dotenv/.local/bin/." "$HOME/.local/bin/"
    echo -e "${GREEN}✓ Installed WSL clipboard helpers to $HOME/.local/bin${NC}"
  fi

  WIN_HOME=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')
  if [ -n "$WIN_HOME" ] && command -v wslpath >/dev/null 2>&1; then
    WIN_HOME_WSL=$(wslpath "$WIN_HOME")
    if [ -d "$WIN_HOME_WSL" ]; then
      cp "$TMP_DOTENV_DIR/dotenv/.wezterm.lua" "$WIN_HOME_WSL/.wezterm.lua"
      echo -e "${GREEN}✓ Installed WezTerm config to $WIN_HOME_WSL/.wezterm.lua${NC}"
    fi
  fi
fi

rm -rf "$TMP_DOTENV_DIR"

cd "$HOME/.config/nvim" || exit 1
npm ci
