#!/usr/bin/env bash
function patchBashrc() {
  # checks if line in $1 is in .bashrc and if not appends it
  if ! grep -q "$1" ~/.bashrc; then
    echo "$1" >> ~/.bashrc
  fi
}

function downloadFromGH () {

  URL="https://api.github.com/repos/$1/releases/latest"

  ASSET=`curl -s $URL | jq -r ".assets[] | select(.name | test(\"$2\")) | .browser_download_url"`
  echo "Downloading $ASSET"
  curl -L -o $2 $ASSET
}

function downloadAndInstall () {
  if [ -f "$HOME/.bin/$3" ]; then
    echo "$3 already exists in $HOME/.bin"
    return 1
  fi
  downloadFromGH $1 $2
  FOLDER=$(echo "$1" | cut -d'/' -f2)
  echo $FOLDER
  mkdir -p $FOLDER
  tar -xvf $2 -C "$FOLDER"
  rm $2
  cd $FOLDER || (echo "cannot enter $FOLDER" && return 1)
  find . -type f -executable -name $3 -exec mv {} "$HOME/.bin/$3" \;
  cd .. || (echo "cannot exit $FOLDER" && return 1)
  rm -rf $FOLDER
  return 0
}
function installFromThisRepo() {
  curl -L -s "https://github.com/vekexasia/dotenv/raw/master/$1" -o "$HOME/$1"
  if [ $? != 0 ]; then
    echo "Failed to download $1"
    return 1
  fi
  if [ "$2" == "x" ]; then
    chmod +x "$HOME/$1"
  fi
}

mkdir -p $HOME/.bin

if ! command -v jq &> /dev/null; then
  echo "jq is not installed. Installing jq"
  sudo apt install jq -y
fi

downloadAndInstall "jesseduffield/lazygit" "Linux_x86_64.tar.gz" "lazygit"
downloadAndInstall "junegunn/fzf" "linux_amd64.tar.gz" "fzf"
downloadAndInstall "zellij-org/zellij" "unknown-linux-musl.tar.gz" "zellij"
downloadAndInstall "sharkdp/bat" "x86_64-unknown-linux-gnu.tar.gz" "bat"

patchBashrc 'eval "$(fzf --bash)"'
patchBashrc "export BAT_THEME=\"TwoDark\""
patchBashrc "export PATH=\$PATH:\$HOME/.bin"

installFromThisRepo ".vimrc"
# check if vim is installed
if ! command -v vim &> /dev/null; then
  echo "Vim is not installed. Skipping vim setup"
  sudo apt install vim -y
fi
