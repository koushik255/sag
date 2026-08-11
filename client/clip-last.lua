-- Server-side exports for movies loaded through StopAndGo.

local mp = require("mp")
local options = require("mp.options")
local utils = require("mp.utils")

local opts = {
    clip_key = "5",
    screenshot_key = "s",
    seconds = 15,
    server_url = "http://127.0.0.1:8765",
    token = "",
    timeout = 30,
}
options.read_options(opts, "clip-last")

local screenshot_number = 0
local path_separator = package.config:sub(1, 1)

local function temporary_directory()
    local directory = os.getenv("TEMP") or os.getenv("TMP") or os.getenv("TMPDIR") or "/tmp"
    return directory:gsub("[/\\]+$", "")
end

local function api_url(path)
    return opts.server_url:gsub("/+$", "") .. path
end

local function url_decode(value)
    return value:gsub("%%(%x%x)", function(hex)
        return string.char(tonumber(hex, 16))
    end)
end

local function url_encode(value)
    return value:gsub("([^%w%-_%.~])", function(character)
        return string.format("%%%02X", string.byte(character))
    end)
end

local function source_path()
    local current = mp.get_property("path", "")
    local encoded = current:match("/media/([^?]+)")
    if not encoded then
        return nil
    end
    return url_decode(encoded)
end

local function curl(arguments, callback)
    local args = {
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time", tostring(opts.timeout),
        "--header", "Accept: application/json",
    }
    if opts.token ~= "" then
        table.insert(args, "--header")
        table.insert(args, "Authorization: Bearer " .. opts.token)
    end
    for _, argument in ipairs(arguments) do
        table.insert(args, argument)
    end
    mp.command_native_async({
        name = "subprocess",
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
        args = args,
    }, callback)
end

local function parse_response(success, result, error_message)
    if not success or not result or result.status ~= 0 then
        local detail = result and result.stderr or error_message or "request failed"
        return nil, tostring(detail):gsub("%s+$", "")
    end
    local body, parse_error = utils.parse_json(result.stdout)
    if not body then
        return nil, tostring(parse_error or "invalid server response")
    end
    return body, nil
end

local function poll_clip(job_id, attempts)
    if attempts <= 0 then
        mp.osd_message("clip still running on server", 3)
        return
    end
    curl({ api_url("/api/export/jobs/" .. job_id) }, function(success, result, error_message)
        local body, request_error = parse_response(success, result, error_message)
        if not body then
            mp.osd_message("clip status failed: " .. request_error, 4)
            return
        end
        if body.status == "complete" then
            mp.osd_message("clip saved on server\n" .. tostring(body.server_path), 4)
        elseif body.status == "failed" then
            mp.osd_message("clip failed: " .. tostring(body.error or "ffmpeg error"), 5)
        else
            mp.add_timeout(1, function()
                poll_clip(job_id, attempts - 1)
            end)
        end
    end)
end

local function save_clip()
    local relative = source_path()
    local position = mp.get_property_number("time-pos")
    if not relative or not position then
        mp.osd_message("server clips only work on StopAndGo movies", 3)
        return
    end
    local seconds = math.max(1, tonumber(opts.seconds) or 15)
    local payload = utils.format_json({
        path = relative,
        ["end"] = position,
        duration = seconds,
    })
    mp.osd_message(string.format("creating %.0fs clip on server...", seconds), 2)
    curl({
        "--request", "POST",
        "--header", "Content-Type: application/json",
        "--data-binary", payload,
        api_url("/api/export/clip"),
    }, function(success, result, error_message)
        local body, request_error = parse_response(success, result, error_message)
        if not body or not body.id then
            mp.osd_message("clip request failed: " .. tostring(request_error or "invalid job"), 4)
            return
        end
        mp.osd_message("clip queued on server", 2)
        poll_clip(body.id, 300)
    end)
end

local function save_screenshot()
    local relative = source_path()
    if not relative then
        mp.osd_message("server screenshots only work on StopAndGo movies", 3)
        return
    end
    screenshot_number = screenshot_number + 1
    local temporary = string.format(
        "%s%sstopandgo-screenshot-%s-%02d.png",
        temporary_directory(),
        path_separator,
        os.date("%Y%m%d-%H%M%S"),
        screenshot_number
    )
    mp.command_native_async(
        { "screenshot-to-file", temporary, "subtitles" },
        function(success, _, error_message)
            if not success then
                mp.osd_message("screenshot failed: " .. tostring(error_message), 4)
                return
            end
            mp.osd_message("uploading screenshot...", 2)
            local upload_url = api_url("/api/export/screenshot?path=" .. url_encode(relative))
            curl({
                "--request", "POST",
                "--header", "Content-Type: image/png",
                "--data-binary", "@" .. temporary,
                upload_url,
            }, function(upload_success, result, upload_error)
                os.remove(temporary)
                local body, request_error = parse_response(upload_success, result, upload_error)
                if not body then
                    mp.osd_message("screenshot upload failed: " .. request_error, 4)
                    return
                end
                mp.osd_message("screenshot saved on server\n" .. tostring(body.server_path), 4)
            end)
        end
    )
end

mp.add_key_binding(opts.clip_key, "clip-last-server", save_clip)
mp.add_key_binding(opts.screenshot_key, "screenshot-server", save_screenshot)
