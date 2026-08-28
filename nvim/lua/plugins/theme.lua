-- Omarchy writes the active theme here. Keep the repo portable on systems
-- without Omarchy by falling back to LazyVim's default colorscheme.
local theme_file = vim.fn.expand("~/.local/state/omarchy/current/theme/neovim.lua")

if vim.fn.filereadable(theme_file) == 1 then
  return dofile(theme_file)
end

return {}
