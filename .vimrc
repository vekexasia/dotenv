set scrolloff=5
set tabstop=2
set shiftwidth=2
let mapleader = " "
" Do incremental searching.
set incsearch

" Don't use Ex mode, use Q for formatting.
map Q gq
set shell=bash.exe
set shellcmdflag=-cli
set shellxquote=
set clipboard+=unnamedplus
" --- Enable IdeaVim plugins https://jb.gg/ideavim-plugins
let data_dir = has('nvim') ? stdpath('data') . '/site' : '~/.vim'
if empty(glob(data_dir . '/autoload/plug.vim'))
  silent execute '!curl -fLo '.data_dir.'/autoload/plug.vim --create-dirs  https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif
call plug#begin()

" Highlight copied text
Plug 'machakann/vim-highlightedyank'
" Commentary plugin
Plug 'tpope/vim-commentary'
call plug#end()
nnoremap <C-j> <C-d>
nnoremap <C-k> <C-u>
