return {
  -- Omarchy's LazyVim base already provides the integrations; these extras
  -- keep the functionality from the previous Kickstart configuration.
  { import = "lazyvim.plugins.extras.dap.core" },
  { import = "lazyvim.plugins.extras.lang.typescript" },

  {
    "davidmh/mdx.nvim",
    dependencies = { "nvim-treesitter/nvim-treesitter" },
  },
  {
    "ray-x/go.nvim",
    dependencies = {
      "ray-x/guihua.lua",
      "neovim/nvim-lspconfig",
      "nvim-treesitter/nvim-treesitter",
    },
    event = { "CmdlineEnter" },
    ft = { "go", "gomod" },
    build = ':lua require("go.install").update_all_sync()',
    opts = {},
    config = function(_, opts)
      require("go").setup(opts)
      local format_sync_grp = vim.api.nvim_create_augroup("GoFormat", {})
      vim.api.nvim_create_autocmd("BufWritePre", {
        pattern = "*.go",
        callback = function()
          require("go.format").gofmt()
        end,
        group = format_sync_grp,
      })
    end,
  },
  { "dmmulroy/tsc.nvim", opts = {} },

  {
    "nvim-neotest/neotest",
    dependencies = {
      "nvim-neotest/nvim-nio",
      "nvim-lua/plenary.nvim",
      "antoinemadec/FixCursorHold.nvim",
      "nvim-treesitter/nvim-treesitter",
      "benelan/neotest-vitest",
    },
    config = function()
      require("neotest").setup({
        adapters = {
          require("neotest-vitest")({
            is_test_file = function()
              return true
            end,
          }),
        },
      })
    end,
  },

  {
    "stevearc/conform.nvim",
    keys = {
      {
        "<leader>f",
        function()
          require("conform").format({ async = true, lsp_format = "fallback" })
        end,
        mode = "",
        desc = "Format buffer",
      },
    },
    opts = function(_, opts)
      opts.formatters = opts.formatters or {}
      opts.formatters.eslint_d_default = {
        command = "eslint_d",
        args = function()
          local package_root = vim.fs.root(0, "eslint.config.mjs")
          local config = package_root and package_root .. "/eslint.config.mjs"
            or vim.fn.stdpath("config") .. "/eslint.config.mjs"
          return { "-c", config, "--fix-to-stdout", "--stdin", "--stdin-filename", "$FILENAME" }
        end,
        env = function(_, ctx)
          if not vim.fs.root(ctx.dirname, "eslint.config.mjs") then
            return { ESLINT_D_ROOT = vim.fn.stdpath("config") }
          end
        end,
        cwd = function(_, ctx)
          return vim.fs.root(ctx.dirname, { "package.json" }) or ctx.dirname
        end,
      }
      opts.formatters_by_ft = opts.formatters_by_ft or {}
      opts.formatters_by_ft.javascript = { "eslint_d_default" }
      opts.formatters_by_ft.typescript = { "eslint_d_default" }
      opts.formatters_by_ft.typescriptreact = { "eslint_d_default" }
    end,
  },
  {
    "mfussenegger/nvim-lint",
    opts = function(_, opts)
      opts.linters_by_ft = opts.linters_by_ft or {}
      opts.linters_by_ft.markdown = { "markdownlint" }
    end,
  },
  { "lukas-reineke/indent-blankline.nvim", main = "ibl", opts = {} },
  { "windwp/nvim-autopairs", event = "InsertEnter", opts = {} },

  {
    "nvim-neo-tree/neo-tree.nvim",
    keys = {
      { "\\", "<cmd>Neotree reveal<CR>", desc = "Reveal in Neo-tree", silent = true },
    },
    opts = {
      filesystem = {
        window = {
          mappings = {
            ["\\"] = "close_window",
          },
        },
      },
    },
  },
  {
    "lewis6991/gitsigns.nvim",
    opts = function(_, opts)
      local previous_on_attach = opts.on_attach
      opts.on_attach = function(bufnr)
        if previous_on_attach then
          previous_on_attach(bufnr)
        end
        local gitsigns = require("gitsigns")
        local function map(mode, lhs, rhs, map_opts)
          map_opts = map_opts or {}
          map_opts.buffer = bufnr
          vim.keymap.set(mode, lhs, rhs, map_opts)
        end

        map("n", "]c", function()
          if vim.wo.diff then
            vim.cmd.normal({ "]c", bang = true })
          else
            gitsigns.nav_hunk("next")
          end
        end, { desc = "Jump to next git change" })
        map("n", "[c", function()
          if vim.wo.diff then
            vim.cmd.normal({ "[c", bang = true })
          else
            gitsigns.nav_hunk("prev")
          end
        end, { desc = "Jump to previous git change" })
        map("n", "<leader>hs", gitsigns.stage_hunk, { desc = "Stage hunk" })
        map("n", "<leader>hr", gitsigns.reset_hunk, { desc = "Reset hunk" })
        map("n", "<leader>hS", gitsigns.stage_buffer, { desc = "Stage buffer" })
        map("n", "<leader>hR", gitsigns.reset_buffer, { desc = "Reset buffer" })
        map("n", "<leader>hp", gitsigns.preview_hunk, { desc = "Preview hunk" })
        map("n", "<leader>hb", function() gitsigns.blame_line({ full = true }) end, { desc = "Blame line" })
        map("n", "<leader>hd", gitsigns.diffthis, { desc = "Diff against index" })
        map("n", "<leader>hD", function() gitsigns.diffthis("@") end, { desc = "Diff against last commit" })
        map({ "o", "x" }, "ih", gitsigns.select_hunk, { desc = "Select hunk" })
      end
    end,
  },

  {
    "mfussenegger/nvim-dap",
    optional = true,
    keys = {
      { "<F5>", function() require("dap").continue() end, desc = "Debug: start/continue" },
      { "<F1>", function() require("dap").step_into() end, desc = "Debug: step into" },
      { "<F2>", function() require("dap").step_over() end, desc = "Debug: step over" },
      { "<F3>", function() require("dap").step_out() end, desc = "Debug: step out" },
      { "<leader>b", function() require("dap").toggle_breakpoint() end, desc = "Debug: toggle breakpoint" },
    },
  },
  {
    "leoluz/nvim-dap-go",
    dependencies = { "mfussenegger/nvim-dap" },
    opts = {
      delve = {
        detached = vim.fn.has("win32") == 0,
      },
    },
  },

  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      require("gpt4_tokens").setup()
      opts.sections.lualine_x = opts.sections.lualine_x or {}
      table.insert(opts.sections.lualine_x, {
        function()
          return require("gpt4_tokens").section()
        end,
      })
    end,
  },
}
