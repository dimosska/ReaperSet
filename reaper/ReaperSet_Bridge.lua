local bridge_dir = nil
local snapshot_path = nil
local command_path = nil
local last_snapshot = ""

local function path_separator()
  return package.config:sub(1, 1)
end

local function home_dir()
  return os.getenv("HOME") or os.getenv("USERPROFILE") or reaper.GetResourcePath()
end

local function join_path(left, right)
  return left .. path_separator() .. right
end

local function ensure_bridge_paths()
  bridge_dir = join_path(home_dir(), ".reaperset")
  snapshot_path = join_path(bridge_dir, "snapshot.json")
  command_path = join_path(bridge_dir, "command.txt")
  reaper.RecursiveCreateDirectory(bridge_dir, 0)
end

local function json_escape(value)
  value = tostring(value or "")
  value = value:gsub("\\", "\\\\")
  value = value:gsub('"', '\\"')
  value = value:gsub("\n", "\\n")
  value = value:gsub("\r", "\\r")
  value = value:gsub("\t", "\\t")
  return value
end

local function json_string(value)
  if value == nil or value == "" then
    return "null"
  end

  return '"' .. json_escape(value) .. '"'
end

local function json_number(value)
  return string.format("%.3f", tonumber(value) or 0)
end

local function trim(value)
  return tostring(value or ""):match("^%s*(.-)%s*$")
end

local function starts_with(value, prefix)
  return value:sub(1, #prefix) == prefix
end

local function parse_song_name(region_name)
  local name = trim(region_name)

  if starts_with(name, "@song:") then
    return trim(name:sub(7))
  end

  if starts_with(name:lower(), "[song]") then
    return trim(name:sub(7))
  end

  return nil
end

local function parse_section_name(marker_name)
  local name = trim(marker_name)

  if name == "" or starts_with(name, "@") then
    return nil
  end

  local display_name = trim(name:match("^(.-)|") or name)
  if display_name == "" then
    return nil
  end

  return display_name
end

local function parse_lyric_text(marker_name)
  local name = trim(marker_name)

  if starts_with(name:lower(), "@lyric:") then
    return trim(name:sub(8))
  end

  return nil
end

local function parse_note_text(marker_name)
  local name = trim(marker_name)

  if starts_with(name:lower(), "@note:") then
    return trim(name:sub(7))
  end

  return nil
end

local function marker_is_loopable(marker_name)
  local lower_name = marker_name:lower()
  return lower_name:find("loop=true", 1, true) ~= nil or lower_name:find("[loop]", 1, true) ~= nil
end

local function marker_color(marker_color_value)
  if marker_color_value == nil or marker_color_value <= 0 then
    return nil
  end

  local native_color = marker_color_value & 0xFFFFFF
  local red = native_color & 0xFF
  local green = (native_color >> 8) & 0xFF
  local blue = (native_color >> 16) & 0xFF
  return string.format("#%02X%02X%02X", red, green, blue)
end

local function collect_markers()
  local markers = {}
  local lyrics = {}
  local notes = {}
  local regions = {}
  local _, marker_count, region_count = reaper.CountProjectMarkers(0)
  local total = marker_count + region_count

  for index = 0, total - 1 do
    local ok, is_region, position, region_end, name, marker_index, color = reaper.EnumProjectMarkers3(0, index)

    if ok then
      if is_region then
        local song_name = parse_song_name(name)
        if song_name ~= nil then
          regions[#regions + 1] = {
            id = "song-" .. tostring(marker_index),
            name = song_name,
            starts_at = position,
            ends_at = region_end,
            color = marker_color(color),
            sections = {}
          }
        end
      else
        local section_name = parse_section_name(name)
        local lyric_text = parse_lyric_text(name)
        local note_text = parse_note_text(name)

        if section_name ~= nil then
          markers[#markers + 1] = {
            id = "section-" .. tostring(marker_index),
            name = section_name,
            starts_at = position,
            loopable = marker_is_loopable(name)
          }
        end

        if lyric_text ~= nil and lyric_text ~= "" then
          lyrics[#lyrics + 1] = {
            id = "lyric-" .. tostring(marker_index),
            text = lyric_text,
            starts_at = position
          }
        end

        if note_text ~= nil and note_text ~= "" then
          notes[#notes + 1] = {
            id = "note-" .. tostring(marker_index),
            text = note_text,
            starts_at = position
          }
        end
      end
    end
  end

  table.sort(regions, function(left, right)
    return left.starts_at < right.starts_at
  end)

  table.sort(markers, function(left, right)
    return left.starts_at < right.starts_at
  end)

  table.sort(lyrics, function(left, right)
    return left.starts_at < right.starts_at
  end)

  table.sort(notes, function(left, right)
    return left.starts_at < right.starts_at
  end)

  return regions, markers, lyrics, notes
end

local function build_songs()
  local regions, markers, lyrics, notes = collect_markers()

  for _, region in ipairs(regions) do
    region.lyrics = {}
    region.notes = {}

    for _, marker in ipairs(markers) do
      if marker.starts_at >= region.starts_at and marker.starts_at < region.ends_at then
        region.sections[#region.sections + 1] = {
          id = marker.id,
          name = marker.name,
          starts_at = marker.starts_at,
          ends_at = nil,
          loopable = marker.loopable
        }
      end
    end

    for _, lyric in ipairs(lyrics) do
      if lyric.starts_at >= region.starts_at and lyric.starts_at < region.ends_at then
        region.lyrics[#region.lyrics + 1] = {
          id = lyric.id,
          text = lyric.text,
          starts_at = lyric.starts_at
        }
      end
    end

    for _, note in ipairs(notes) do
      if note.starts_at >= region.starts_at and note.starts_at < region.ends_at then
        region.notes[#region.notes + 1] = note.text
      end
    end

    for index, section in ipairs(region.sections) do
      local next_section = region.sections[index + 1]
      section.ends_at = next_section and next_section.starts_at or region.ends_at
    end
  end

  return regions
end

local function encode_sections(sections)
  local encoded = {}

  for _, section in ipairs(sections) do
    encoded[#encoded + 1] = table.concat({
      "{",
      '"id":', json_string(section.id), ",",
      '"name":', json_string(section.name), ",",
      '"startsAtSeconds":', json_number(section.starts_at), ",",
      '"endsAtSeconds":', json_number(section.ends_at), ",",
      '"loopable":', section.loopable and "true" or "false",
      "}"
    })
  end

  return "[" .. table.concat(encoded, ",") .. "]"
end

local function encode_timed_lyrics(lyrics)
  local encoded = {}

  for _, lyric in ipairs(lyrics) do
    encoded[#encoded + 1] = table.concat({
      "{",
      '"id":', json_string(lyric.id), ",",
      '"text":', json_string(lyric.text), ",",
      '"startsAtSeconds":', json_number(lyric.starts_at),
      "}"
    })
  end

  return "[" .. table.concat(encoded, ",") .. "]"
end

local function encode_multiline_text(lines)
  return json_string(table.concat(lines or {}, "\n"))
end

local function encode_songs(songs)
  local encoded = {}

  for _, song in ipairs(songs) do
    local color_json = song.color and json_string(song.color) or "null"

    encoded[#encoded + 1] = table.concat({
      "{",
      '"id":', json_string(song.id), ",",
      '"name":', json_string(song.name), ",",
      '"startsAtSeconds":', json_number(song.starts_at), ",",
      '"endsAtSeconds":', json_number(song.ends_at), ",",
      '"color":', color_json, ",",
      '"notes":', encode_multiline_text(song.notes), ",",
      '"lyrics":', encode_multiline_text((function()
        local lines = {}
        for _, lyric in ipairs(song.lyrics) do
          lines[#lines + 1] = lyric.text
        end
        return lines
      end)()), ",",
      '"timedLyrics":', encode_timed_lyrics(song.lyrics), ",",
      '"sections":', encode_sections(song.sections),
      "}"
    })
  end

  return "[" .. table.concat(encoded, ",") .. "]"
end

local function current_transport()
  local play_state = reaper.GetPlayState()

  if play_state & 1 == 1 then
    return "playing"
  end

  if play_state & 2 == 2 then
    return "paused"
  end

  return "stopped"
end

local function build_snapshot()
  local _, project_name = reaper.EnumProjects(-1)
  local display_name = nil

  if project_name ~= nil and project_name ~= "" then
    display_name = project_name:match("([^/\\]+)$") or project_name
  end

  return table.concat({
    "{",
    '"projectName":', json_string(display_name), ",",
    '"transport":', json_string(current_transport()), ",",
    '"positionSeconds":', json_number(reaper.GetPlayPosition()), ",",
    '"songs":', encode_songs(build_songs()), ",",
    '"updatedAt":', json_string(os.date("!%Y-%m-%dT%H:%M:%SZ")),
    "}"
  })
end

local function write_snapshot()
  local snapshot = build_snapshot()

  if snapshot == last_snapshot then
    return
  end

  local file = io.open(snapshot_path, "w")
  if file == nil then
    return
  end

  file:write(snapshot)
  file:close()
  last_snapshot = snapshot
end

local function read_command()
  local file = io.open(command_path, "r")
  if file == nil then
    return nil
  end

  local command = trim(file:read("*a"))
  file:close()
  os.remove(command_path)

  if command == "" then
    return nil
  end

  return command
end

local function run_command(command)
  if command == "transport.play" then
    reaper.OnPlayButton()
    return
  end

  if command == "transport.stop" then
    reaper.OnStopButton()
    return
  end

  if command == "transport.pause" then
    reaper.OnPauseButton()
    return
  end

  local jump_position = command:match("^jump%s+([%d%.]+)$")
  if jump_position ~= nil then
    reaper.SetEditCurPos(tonumber(jump_position), true, false)
  end
end

local function main()
  local command = read_command()
  if command ~= nil then
    run_command(command)
  end

  write_snapshot()
  reaper.defer(main)
end

ensure_bridge_paths()
reaper.ShowConsoleMsg("ReaperSet bridge writing snapshot to " .. snapshot_path .. "\n")
reaper.ShowConsoleMsg("ReaperSet bridge reading commands from " .. command_path .. "\n")
main()
