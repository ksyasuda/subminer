local input = require("mp.input")
local mp = require("mp")
local msg = require("mp.msg")
local options = require("mp.options")
local utils = require("mp.utils")

local opts = {
	binary_path = "",
	socket_path = "/tmp/mpv-yomitan-socket",
	texthooker_enabled = true,
	texthooker_port = 5174,
	backend = "auto",
	auto_start = false,
	auto_start_overlay = true,
	key_menu = "y",
	osd_messages = true,
}

options.read_options(opts, "mpv-yomitan")

local state = {
	overlay_running = false,
	overlay_process = nil,
	binary_available = false,
	binary_path = nil,
	detected_backend = nil,
}

local function show_osd(message)
	if opts.osd_messages then
		mp.osd_message("mpv-yomitan: " .. message, 3)
	end
end

local function detect_backend()
	if state.detected_backend then
		return state.detected_backend
	end

	local backend = nil

	if os.getenv("HYPRLAND_INSTANCE_SIGNATURE") then
		backend = "hyprland"
	elseif os.getenv("SWAYSOCK") then
		backend = "sway"
	elseif os.getenv("XDG_SESSION_TYPE") == "x11" or os.getenv("DISPLAY") then
		backend = "x11"
	else
		msg.warn("Could not detect window manager, falling back to x11")
		backend = "x11"
	end

	state.detected_backend = backend
	msg.info("Detected backend: " .. backend)
	return backend
end

local function file_exists(path)
	local info = utils.file_info(path)
	return info ~= nil
end

local function find_binary()
	if opts.binary_path ~= "" and file_exists(opts.binary_path) then
		return opts.binary_path
	end

	local search_paths = {
		utils.join_path(os.getenv("HOME") or "", ".local/bin/mpv-yomitan.AppImage"),
		"/opt/mpv-yomitan/mpv-yomitan",
		"/opt/mpv-yomitan/mpv-yomitan.AppImage",
		"/usr/local/bin/mpv-yomitan",
		"/usr/bin/mpv-yomitan",
	}

	for _, path in ipairs(search_paths) do
		if file_exists(path) then
			msg.info("Found binary at: " .. path)
			return path
		end
	end

	return nil
end

local function build_command_args(action)
	local args = { state.binary_path }

	table.insert(args, "--" .. action)

	if action == "start" then
		local backend = opts.backend == "auto" and detect_backend() or opts.backend
		table.insert(args, "--backend")
		table.insert(args, backend)

		if opts.texthooker_enabled then
			table.insert(args, "--texthooker")
			table.insert(args, "--port")
			table.insert(args, tostring(opts.texthooker_port))
		end

		table.insert(args, "--socket")
		table.insert(args, opts.socket_path)

		if opts.auto_start_overlay then
			table.insert(args, "--auto-start-overlay")
		end
	end

	return args
end

local function start_overlay()
	if not state.binary_available then
		msg.error("mpv-yomitan binary not found")
		show_osd("Error: binary not found")
		return
	end

	if state.overlay_running then
		msg.info("Overlay already running")
		show_osd("Already running")
		return
	end

	local args = build_command_args("start")
	msg.info("Starting overlay: " .. table.concat(args, " "))

	show_osd("Starting...")
	state.overlay_running = true

	mp.command_native_async({
		name = "subprocess",
		args = args,
		playback_only = false,
		capture_stdout = true,
		capture_stderr = true,
	}, function(success, result, error)
		state.overlay_running = false
		if not success or (result and result.status ~= 0) then
			msg.error("Overlay stopped unexpectedly: " .. (error or (result and result.stderr) or "unknown error"))
			show_osd("Overlay stopped unexpectedly")
		end
	end)
end

local function stop_overlay()
	if not state.binary_available then
		msg.error("mpv-yomitan binary not found")
		show_osd("Error: binary not found")
		return
	end

	local args = build_command_args("stop")
	msg.info("Stopping overlay: " .. table.concat(args, " "))

	local result = mp.command_native({
		name = "subprocess",
		args = args,
		playback_only = false,
		capture_stdout = true,
		capture_stderr = true,
	})

	if result.status == 0 then
		state.overlay_running = false
		msg.info("Overlay stopped")
		show_osd("Stopped")
	else
		msg.warn("Stop command returned non-zero status (overlay may not have been running)")
	end
end

local function toggle_overlay()
	if not state.binary_available then
		msg.error("mpv-yomitan binary not found")
		show_osd("Error: binary not found")
		return
	end

	local args = build_command_args("toggle")
	msg.info("Toggling overlay: " .. table.concat(args, " "))

	local result = mp.command_native({
		name = "subprocess",
		args = args,
		playback_only = false,
		capture_stdout = true,
		capture_stderr = true,
	})

	if result.status == 0 then
		msg.info("Overlay toggled")
		show_osd("Toggled")
	else
		msg.warn("Toggle command failed")
		show_osd("Toggle failed")
	end
end

local function open_options()
	if not state.binary_available then
		msg.error("mpv-yomitan binary not found")
		show_osd("Error: binary not found")
		return
	end
	local args = build_command_args("settings")
	msg.info("Opening options: " .. table.concat(args, " "))
	local result = mp.command_native({
		name = "subprocess",
		args = args,
		playback_only = false,
		capture_stdout = true,
		capture_stderr = true,
	})
	if result.status == 0 then
		msg.info("Options window opened")
		show_osd("Options opened")
	else
		msg.warn("Failed to open options")
		show_osd("Failed to open options")
	end
end

local function on_file_loaded()
	state.binary_path = find_binary()
	if state.binary_path then
		state.binary_available = true
		msg.info("mpv-yomitan ready (binary: " .. state.binary_path .. ")")

		if opts.auto_start then
			start_overlay()
		end
	else
		state.binary_available = false
		msg.warn("mpv-yomitan binary not found - overlay features disabled")
		if opts.binary_path ~= "" then
			msg.warn("Configured path '" .. opts.binary_path .. "' does not exist")
		end
	end
end

local function on_shutdown()
	if state.overlay_running and state.binary_available then
		msg.info("mpv shutting down, stopping overlay")
		stop_overlay()
	end
end

local function show_menu()
	if not state.binary_available then
		msg.error("mpv-yomitan binary not found")
		show_osd("Error: binary not found")
		return
	end

	local items = {
		"Start overlay",
		"Stop overlay",
		"Toggle overlay",
		"Open options",
	}

	local actions = {
		start_overlay,
		stop_overlay,
		toggle_overlay,
		open_options,
	}

	input.select({
		prompt = "mpv-yomitan: ",
		items = items,
		submit = function(index)
			if index and actions[index] then
				actions[index]()
			end
		end,
	})
end

local function register_keybindings()
	mp.add_key_binding(opts.key_menu, "mpv-yomitan-menu", show_menu)
end

local function register_script_messages()
	mp.register_script_message("mpv-yomitan-start", start_overlay)
	mp.register_script_message("mpv-yomitan-stop", stop_overlay)
	mp.register_script_message("mpv-yomitan-toggle", toggle_overlay)
	mp.register_script_message("mpv-yomitan-menu", show_menu)
end

local function init()
	register_keybindings()
	register_script_messages()

	mp.register_event("file-loaded", on_file_loaded)
	mp.register_event("shutdown", on_shutdown)

	msg.info("mpv-yomitan plugin loaded")
end

init()
