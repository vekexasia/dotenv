return {
  {
    "williamboman/mason.nvim",
    opts = {}
  },
  {
    "williamboman/mason-lspconfig.nvim",
    opts = {
      ensure_installed = {
        "lua_ls", "bashls",
        "clangd", "cmake",
        "cssls", "jsonls", "html", "tsserver", "eslint", "vuels",
        "dockerls", "docker_compose_language_service",
        "markdown_oxide",
        "rust_analyzer"
      }
    }
  },
  {
    "neovim/nvim-lspconfig",
    keys = {
      {"K", vim.lsp.buf.hover, "n", desc= "Hover" },
      {"gd", vim.lsp.buf.definition, "n", desc= "Go to definitionr" },
      {"<leader>ca", vim.lsp.buf.code_action, "n", desc= "Code Actions" }
    },
    config = function ()
        local lspconfig = require('lspconfig')
        lspconfig.lua_ls.setup({})
    end
  }
}
