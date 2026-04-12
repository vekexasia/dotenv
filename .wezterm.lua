-- Pull in the wezterm API
local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices

config.default_domain = "WSL:Ubuntu"
config.enable_kitty_keyboard = false
config.notification_handling = "AlwaysShow"

-- For example, changing the color scheme:

config.color_scheme = "Dracula"
config.window_decorations = "INTEGRATED_BUTTONS|RESIZE"
config.colors = {
	background = "#16161e",
}
config.window_frame = {
	active_titlebar_bg = "#101010", -- Active window bar: default purple
	inactive_titlebar_bg = "#090909", -- Inactive window bar: default dark grey
	active_titlebar_fg = "#ffffff", -- Text: white
	inactive_titlebar_fg = "#cccccc", -- Text: grey
	-- tweak the rest if you give a damn
}

wezterm.on("gui-startup", function()
	local tab, pane, window = mux.spawn_window({})
	window:gui_window():maximize()
end)

config.key_tables = {
	paste_mode = {
		{ key = "v", mods = "CTRL", action = act.PasteFrom("Clipboard") },
		{ key = "F6", action = "PopKeyTable" },
	},
}

config.keys = {
	{
		key = "F6",
		action = act.ActivateKeyTable({
			name = "paste_mode",
			one_shot = false,
		}),
	},
	{ key = "Backspace", mods = "CTRL", action = act.SendString("\x17") },
	{ key = "Delete", mods = "CTRL", action = act.SendString("\x1bd") },
	--	{ key = "v", mods = "CTRL", action = act.PasteFrom("Clipboard") },
	{
		key = "v",
		mods = "CTRL|ALT",
		action = act.SplitVertical({ domain = "CurrentPaneDomain" }),
	},
	{
		key = "h",
		mods = "CTRL|ALT",
		action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }),
	},
	{
		key = "LeftArrow",
		mods = "CTRL|SHIFT",
		action = act.MoveTabRelative(-1),
	},
	{
		key = "RightArrow",
		mods = "CTRL|SHIFT",
		action = act.MoveTabRelative(1),
	},
}
-- and finally, return the configuration to wezterm
return config
