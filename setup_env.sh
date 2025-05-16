#!/usr/bin/env bash

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

checkAndInstall() {
    # First arg is always the command to check
    local cmd="$1"
    # Second arg is optional - use first arg if not provided
    local pkg="${2:-$1}"
    
    # Check if the fucking command exists
    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Command '$cmd' is already installed${NC}"
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

checkAndInstall make
checkAndInstall gcc
checkAndInstall rg ripgrep 
checkAndInstall git
checkAndInstall xclip
checkAndInstall jq
checkAndInstall tree
checkAndInstall htop
checkAndInstall fd-find



downloadFromGH "neovim/neovim" "nvim-linux-x86_64.tar.gz"
sudo rm -rf /opt/nvim-linux-x86_64
sudo tar -C /opt -xzf nvim-linux-x86_64.tar.gz
rm ./nvim-linux-x86_64.tar.gz

downloadAndInstall "jesseduffield/lazygit" "Linux_x86_64.tar.gz" "lazygit"
downloadAndInstall "junegunn/fzf" "linux_amd64.tar.gz" "fzf"
downloadAndInstall "zellij-org/zellij" "x86_64-unknown-linux-musl.tar.gz" "zellij"
downloadAndInstall "sharkdp/bat" "x86_64-unknown-linux-gnu.tar.gz" "bat"

patchBashrc "export PATH=\$PATH:\$HOME/.bin"
patchBashrc 'eval "$(fzf --bash)"'
patchBashrc "export BAT_THEME=\"TwoDark\""
patchBashrc "alias ll='ls -alF'"
patchBashrc "export SUDO_EDITOR=\"nvim\""

# fix wsl keyring for ssh key
if [[ $(grep -i Microsoft /proc/version) ]]; then
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

mkdir -p $HOME/.config/nvim
# download init.lua and lazy-lock.json using curl
curl -sfLo $HOME/.config/nvim/init.lua https://github.com/vekexasia/dotenv/raw/master/nvim/init.lua
curl -sfLo $HOME/.config/nvim/lazy-lock.json https://github.com/vekexasia/dotenv/raw/master/nvim/lazy-lock.json
curl -sfLo $HOME/.config/nvim/package.json https://github.com/vekexasia/dotenv/raw/master/nvim/package.json
curl -sfLo $HOME/.config/nvim/package-lock.json https://github.com/vekexasia/dotenv/raw/master/nvim/package.json
cd $HOME/.config/nvim
npm ci
