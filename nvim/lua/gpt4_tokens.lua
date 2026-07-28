-- Toggleable GPT-4 (cl100k) token count for mini.statusline.
local M = {}

local enabled = false
local counts = {} -- buf -> { tick, text }
local timers = {}
local jobs = {}

local PYTHON = vim.fn.stdpath("data") .. "/gigatoken-venv/bin/python"
local SCRIPT = vim.fn.stdpath("config") .. "/scripts/gpt4_tokens.py"

local function request(buf)
	if not enabled or not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "" then
		return
	end
	local tick = vim.api.nvim_buf_get_changedtick(buf)
	local cached = counts[buf]
	if cached and cached.tick == tick and cached.text ~= "..." then
		return
	end
	if jobs[buf] then
		vim.fn.jobstop(jobs[buf])
	end
	local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
	counts[buf] = { tick = tick, text = (cached and cached.text) or "..." }
	local out = {}
	jobs[buf] = vim.fn.jobstart({ PYTHON, SCRIPT }, {
		stdin = "pipe",
		stdout_buffered = true,
		on_stdout = function(_, data)
			for _, line in ipairs(data or {}) do
				if line ~= "" then
					out[#out + 1] = line
				end
			end
		end,
		on_exit = function()
			jobs[buf] = nil
			local n = tonumber(table.concat(out))
			if n and vim.api.nvim_buf_is_valid(buf) then
				counts[buf] = { tick = tick, text = tostring(n) }
				vim.schedule(function()
					pcall(vim.cmd.redrawstatus)
				end)
			end
		end,
	})
	if jobs[buf] > 0 then
		vim.fn.chansend(jobs[buf], text)
		vim.fn.chanclose(jobs[buf], "stdin")
	else
		jobs[buf] = nil
	end
end

local function schedule(buf)
	buf = buf or vim.api.nvim_get_current_buf()
	if timers[buf] then
		vim.fn.timer_stop(timers[buf])
	end
	timers[buf] = vim.fn.timer_start(300, function()
		timers[buf] = nil
		vim.schedule(function()
			request(buf)
		end)
	end)
end

function M.section()
	if not enabled then
		return ""
	end
	local buf = vim.api.nvim_get_current_buf()
	local c = counts[buf]
	if not c then
		counts[buf] = { tick = -1, text = "..." }
		schedule(buf)
		return "tok ..."
	end
	return "tok " .. c.text
end

function M.toggle()
	enabled = not enabled
	if enabled then
		vim.notify("tok on", vim.log.levels.INFO, { title = "gpt4_tokens" })
		schedule()
	else
		vim.notify("tok off", vim.log.levels.INFO, { title = "gpt4_tokens" })
		for _, id in pairs(jobs) do
			vim.fn.jobstop(id)
		end
		jobs, counts = {}, {}
		vim.schedule(function()
			pcall(vim.cmd.redrawstatus)
		end)
	end
end

function M.setup()
	vim.api.nvim_create_autocmd({ "BufEnter", "TextChanged", "TextChangedI", "BufWritePost" }, {
		group = vim.api.nvim_create_augroup("Gpt4Tokens", { clear = true }),
		callback = function(ev)
			if enabled then
				schedule(ev.buf)
			end
		end,
	})
	vim.keymap.set("n", "<leader>ut", M.toggle, { desc = "Toggle GPT-4 token count" })
end

return M
