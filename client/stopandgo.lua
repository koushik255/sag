-- StopAndGo: browse a remote media directory and play it with mpv.

local mp = require("mp")
local options = require("mp.options")
local utils = require("mp.utils")

local opts = {
    api_url = "http://127.0.0.1:8765/api/files",
    token = "",
    key = "Ctrl+b",
    timeout = 10,
    rows = 8,
    open_on_start = false,
}
options.read_options(opts, "stopandgo")

local state = {
    visible = false,
    loading = false,
    files = {},
    selected = 1,
    error = nil,
    hidden = 0,
}

local overlay = mp.create_osd_overlay("ass-events")
overlay.res_x = 1280
overlay.res_y = 720
overlay.z = 1000
local mono_font = package.config:sub(1, 1) == "\\" and "\\fnConsolas" or "\\fnMenlo"

local browser_bindings = {
    { "UP", "stopandgo-up" },
    { "DOWN", "stopandgo-down" },
    { "PGUP", "stopandgo-page-up" },
    { "PGDWN", "stopandgo-page-down" },
    { "HOME", "stopandgo-home" },
    { "END", "stopandgo-end" },
    { "ENTER", "stopandgo-play" },
    { "KP_ENTER", "stopandgo-play-keypad" },
    { "ESC", "stopandgo-close" },
    { "r", "stopandgo-refresh" },
}

local function clamp(value, minimum, maximum)
    return math.max(minimum, math.min(maximum, value))
end

local function ass_escape(value)
    return tostring(value):gsub("\\", "\\e"):gsub("{", "\\{"):gsub("}", "\\}")
end

local function human_size(bytes)
    local units = { "B", "KiB", "MiB", "GiB", "TiB" }
    local value = tonumber(bytes) or 0
    local unit = 1
    while value >= 1024 and unit < #units do
        value = value / 1024
        unit = unit + 1
    end
    if unit == 1 then
        return string.format("%d %s", value, units[unit])
    end
    return string.format("%.1f %s", value, units[unit])
end

local function human_duration(seconds)
    local value = math.floor(tonumber(seconds) or 0)
    if value <= 0 then
        return ""
    end
    local hours = math.floor(value / 3600)
    local minutes = math.floor((value % 3600) / 60)
    if hours > 0 then
        return string.format("%dh %02dm", hours, minutes)
    end
    return string.format("%dm", minutes)
end

local function resolution_label(item)
    local width = tonumber(item.width) or 0
    local height = tonumber(item.height) or 0
    if width >= 3800 or height >= 2000 then
        return "4K"
    elseif width >= 1900 or height >= 1000 then
        return "1080p"
    elseif width >= 1200 or height >= 700 then
        return "720p"
    elseif height > 0 then
        return tostring(height) .. "p"
    end
    return ""
end

local function truncate(value, limit)
    local text = tostring(value or "")
    if #text <= limit then
        return text
    end
    return text:sub(1, limit - 1) .. "…"
end

local function rectangle(x1, y1, x2, y2, color, alpha)
    return string.format(
        "{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H%s&\\p1}m %d %d l %d %d %d %d %d %d{\\p0}",
        color, alpha or "00", x1, y1, x2, y1, x2, y2, x1, y2
    )
end

local function label(x, y, alignment, style, value)
    return string.format(
        "{\\pos(%d,%d)\\an%d\\bord0\\shad0%s}%s",
        x, y, alignment, style or "", ass_escape(value)
    )
end

local function item_metadata(item)
    local parts = {}
    local duration = human_duration(item.duration)
    local resolution = resolution_label(item)
    if duration ~= "" then table.insert(parts, duration) end
    if resolution ~= "" then table.insert(parts, resolution) end
    if item.video_codec and item.video_codec ~= "" then table.insert(parts, item.video_codec) end
    table.insert(parts, human_size(item.size))
    return table.concat(parts, "   ")
end

local function draw()
    if not state.visible then
        return
    end

    local events = {
        rectangle(120, 82, 1160, 638, "111111", "18"),
        label(158, 116, 7, mono_font .. "\\fs25\\b1\\1c&HEAEAEA&", "movies"),
    }
    if state.loading then
        table.insert(events, label(158, 166, 7, mono_font .. "\\fs19\\1c&H999999&", "scanning..."))
    elseif state.error then
        table.insert(events, label(158, 166, 7, mono_font .. "\\fs19\\1c&H8888DD&", truncate(state.error, 84)))
        table.insert(events, label(158, 205, 7, mono_font .. "\\fs16\\1c&H888888&", "r retry    esc close"))
    elseif #state.files == 0 then
        table.insert(events, label(158, 166, 7, mono_font .. "\\fs19\\1c&HAAAAAA&", "no playable files"))
        table.insert(events, label(158, 205, 7, mono_font .. "\\fs16\\1c&H777777&", "r rescan    esc close"))
    else
        local rows = clamp(tonumber(opts.rows) or 8, 3, 8)
        local first = clamp(state.selected - math.floor(rows / 2), 1, math.max(1, #state.files - rows + 1))
        local last = math.min(#state.files, first + rows - 1)
        local count_text = string.format("%d files", #state.files)
        if state.hidden > 0 then
            count_text = count_text .. string.format("   %d skipped", state.hidden)
        end
        table.insert(events, label(1120, 118, 9, mono_font .. "\\fs15\\1c&H777777&", count_text))
        table.insert(events, rectangle(155, 148, 1125, 150, "303030", "00"))
        for index = first, last do
            local item = state.files[index]
            local row = index - first
            local y1 = 166 + row * 50
            local selected = index == state.selected
            if selected then
                table.insert(events, rectangle(150, y1, 1130, y1 + 42, "323232", "00"))
            end
            local title = item.title or item.name or "Untitled"
            if item.year and item.year ~= "" then
                title = title .. "  (" .. item.year .. ")"
            end
            local title_color = selected and "&HFFFFFF&" or "&HCCCCCC&"
            local meta_color = selected and "&HBBBBBB&" or "&H777777&"
            local marker = selected and ">" or " "
            table.insert(events, label(168, y1 + 21, 4,
                mono_font .. "\\fs19\\b" .. (selected and "1" or "0") .. "\\1c" .. title_color,
                marker .. "  " .. truncate(title, 49)))
            table.insert(events, label(1110, y1 + 21, 6,
                mono_font .. "\\fs15\\1c" .. meta_color, item_metadata(item):lower()))
        end
        table.insert(events, rectangle(155, 586, 1125, 588, "303030", "00"))
        table.insert(events, label(158, 610, 4, mono_font .. "\\fs14\\1c&H777777&",
            "up/down move    enter play    r reload    esc close"))
        table.insert(events, label(1120, 610, 6, mono_font .. "\\fs14\\1c&H666666&",
            string.format("%d/%d", state.selected, #state.files)))
    end
    overlay.data = table.concat(events, "\n")
    overlay:update()
end

local function close_browser()
    state.visible = false
    for _, binding in ipairs(browser_bindings) do
        mp.remove_key_binding(binding[2])
    end
    overlay:remove()
end

local function move_selection(amount)
    if #state.files == 0 then
        return
    end
    state.selected = clamp(state.selected + amount, 1, #state.files)
    draw()
end

local function play_selected()
    local item = state.files[state.selected]
    if not item or not item.url then
        return
    end
    close_browser()
    mp.commandv("loadfile", item.url, "replace")
end

local function refresh()
    state.loading = true
    state.error = nil
    draw()

    local args = {
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--max-time", tostring(opts.timeout),
        "--header", "Accept: application/json",
    }
    if opts.token ~= "" then
        table.insert(args, "--header")
        table.insert(args, "Authorization: Bearer " .. opts.token)
    end
    table.insert(args, opts.api_url)

    mp.command_native_async({
        name = "subprocess",
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
        args = args,
    }, function(success, result, error_message)
        if not state.visible then
            return
        end
        state.loading = false
        if not success or not result or result.status ~= 0 then
            local detail = result and result.stderr or error_message or "request failed"
            state.error = "Could not load library: " .. tostring(detail):gsub("%s+$", "")
            draw()
            return
        end

        local body, parse_error = utils.parse_json(result.stdout)
        if not body or type(body.files) ~= "table" then
            state.error = "Server returned invalid JSON: " .. tostring(parse_error or "missing files")
            draw()
            return
        end
        state.files = body.files
        state.hidden = tonumber(body.hidden) or 0
        state.selected = clamp(state.selected, 1, math.max(1, #state.files))
        draw()
    end)
end

local function add_browser_bindings()
    mp.add_forced_key_binding("UP", "stopandgo-up", function() move_selection(-1) end, { repeatable = true })
    mp.add_forced_key_binding("DOWN", "stopandgo-down", function() move_selection(1) end, { repeatable = true })
    mp.add_forced_key_binding("PGUP", "stopandgo-page-up", function() move_selection(-(tonumber(opts.rows) or 12)) end, { repeatable = true })
    mp.add_forced_key_binding("PGDWN", "stopandgo-page-down", function() move_selection(tonumber(opts.rows) or 12) end, { repeatable = true })
    mp.add_forced_key_binding("HOME", "stopandgo-home", function() state.selected = 1; draw() end)
    mp.add_forced_key_binding("END", "stopandgo-end", function() state.selected = math.max(1, #state.files); draw() end)
    mp.add_forced_key_binding("ENTER", "stopandgo-play", play_selected)
    mp.add_forced_key_binding("KP_ENTER", "stopandgo-play-keypad", play_selected)
    mp.add_forced_key_binding("ESC", "stopandgo-close", close_browser)
    mp.add_forced_key_binding("r", "stopandgo-refresh", refresh)
end

local function toggle_browser()
    if state.visible then
        close_browser()
        return
    end
    state.visible = true
    add_browser_bindings()
    refresh()
end

mp.add_key_binding(opts.key, "stopandgo-browser", toggle_browser)

if opts.open_on_start then
    mp.add_timeout(0, toggle_browser)
end
