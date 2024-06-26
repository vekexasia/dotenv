-- Pull in the wezterm API
local wezterm = require 'wezterm'
local mux = wezterm.mux
local act = wezterm.action

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices

config.default_domain = 'WSL:Ubuntu'

-- For example, changing the color scheme:

config.color_scheme = 'Dracula'
config.window_decorations = "RESIZE"

wezterm.on("gui-startup", function()
  local tab, pane, window = mux.spawn_window{}
  window:gui_window():maximize()
end)

config.keys = {
	{ key = 'Backspace', mods = 'CTRL', action = act.SendKey {key = 'w', mods = 'CTRL'} }
}
-- and finally, return the configuration to wezterm
return config