return {
  "tris203/precognition.nvim",
  config = function()
    vim.keymap.set('n', '<F10>', ':lua require("precognition").peek()<CR>')
  end
}
