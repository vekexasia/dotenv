vim.keymap.set("n", "zc", function()
  local closed = pcall(vim.cmd.normal, { "zc", bang = true })
  if closed then
    return
  end

  if vim.wo.foldmethod == "expr" and vim.wo.foldexpr:find("treesitter.foldexpr", 1, true) then
    vim.wait(1000, function()
      return vim.fn.foldlevel(".") > 0
    end, 10)
  end

  vim.cmd.normal({ "zc", bang = true })
end, { desc = "Close fold" })
