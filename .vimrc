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
call plug#begin()

" Highlight copied text
Plug 'machakann/vim-highlightedyank'
" Commentary plugin
Plug 'tpope/vim-commentary'
call plug#end()

nnoremap <C-j> <C-d>
nnoremap <C-k> <C-u>
