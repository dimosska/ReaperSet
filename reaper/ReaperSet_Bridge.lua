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

local function beat_position(time)
  local _, _, _, full_beats = reaper.TimeMap2_timeToBeats(0, time)
  return full_beats or 0
end

local function beats_per_bar_at(time)
  local _, _, beats_per_bar = reaper.TimeMap2_timeToBeats(0, time)
  return beats_per_bar or 4
end

local function one_bar_before(time)
  local target_time = math.max(0, tonumber(time) or 0)
  local target_beats = beat_position(target_time)
  local preroll_beats = math.max(0, target_beats - beats_per_bar_at(target_time))
  return math.max(0, reaper.TimeMap2_beatsToTime(0, preroll_beats))
end

local function trim(value)
  return tostring(value or ""):match("^%s*(.-)%s*$")
end

local function starts_with(value, prefix)
  return value:sub(1, #prefix) == prefix
end

local function parse_song_name(region_name)
  local name = trim(region_name)
  local lower_name = name:lower()

  if name == "" then
    return nil
  end

  if starts_with(lower_name, "@song:") then
    return trim(name:sub(7))
  end

  if starts_with(lower_name, "[song]") then
    return trim(name:sub(7))
  end

  return name
end

local function parse_section_name(marker_name)
  local name = trim(marker_name)

  if name == "" then
    return nil
  end

  local display_name = trim(name:match("^(.-)|") or name)
  if display_name == "" then
    return nil
  end

  return display_name
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

local function track_name(track)
  local ok, name = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
  if ok then
    return trim(name)
  end

  return ""
end

local function find_track_by_name(expected_name)
  local expected = trim(expected_name):lower()
  local track_count = reaper.CountTracks(0)

  for index = 0, track_count - 1 do
    local track = reaper.GetTrack(0, index)
    if track ~= nil and track_name(track):lower() == expected then
      return track
    end
  end

  return nil
end

local function item_text(item)
  local ok, notes = reaper.GetSetMediaItemInfo_String(item, "P_NOTES", "", false)
  if ok and trim(notes) ~= "" then
    return trim(notes)
  end

  local take = reaper.GetActiveTake(item)

  if take ~= nil then
    local take_name = trim(reaper.GetTakeName(take))
    if take_name ~= "" then
      return take_name
    end
  end

  return nil
end

local function collect_lyrics()
  local lyrics = {}
  local lyrics_track = find_track_by_name("Lyrics")

  if lyrics_track == nil then
    return lyrics
  end

  local item_count = reaper.CountTrackMediaItems(lyrics_track)

  for index = 0, item_count - 1 do
    local item = reaper.GetTrackMediaItem(lyrics_track, index)
    local text = item_text(item)

    if text ~= nil and text ~= "" then
      local position = reaper.GetMediaItemInfo_Value(item, "D_POSITION")

      lyrics[#lyrics + 1] = {
        id = "lyric-item-" .. tostring(index + 1),
        text = text,
        starts_at = position
      }
    end
  end

  table.sort(lyrics, function(left, right)
    return left.starts_at < right.starts_at
  end)

  return lyrics
end

local function collect_markers()
  local markers = {}
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
            starts_at_beats = beat_position(position),
            ends_at_beats = beat_position(region_end),
            color = marker_color(color),
            sections = {}
          }
        end
      else
        local section_name = parse_section_name(name)

        if section_name ~= nil then
          markers[#markers + 1] = {
            id = "section-" .. tostring(marker_index),
            name = section_name,
            starts_at = position,
            starts_at_beats = beat_position(position),
            loopable = marker_is_loopable(name)
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

  return regions, markers, collect_lyrics()
end

local function build_songs()
  local regions, markers, lyrics = collect_markers()

  for _, region in ipairs(regions) do
    region.lyrics = {}

    for _, marker in ipairs(markers) do
      if marker.starts_at >= region.starts_at and marker.starts_at < region.ends_at then
        region.sections[#region.sections + 1] = {
          id = marker.id,
          name = marker.name,
          starts_at = marker.starts_at,
          starts_at_beats = marker.starts_at_beats,
          ends_at = nil,
          ends_at_beats = nil,
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

    for index, section in ipairs(region.sections) do
      local next_section = region.sections[index + 1]
      section.ends_at = next_section and next_section.starts_at or region.ends_at
      section.ends_at_beats = next_section and next_section.starts_at_beats or region.ends_at_beats
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
      '"startsAtBeats":', json_number(section.starts_at_beats), ",",
      '"endsAtBeats":', json_number(section.ends_at_beats), ",",
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
      '"startsAtBeats":', json_number(song.starts_at_beats), ",",
      '"endsAtBeats":', json_number(song.ends_at_beats), ",",
      '"color":', color_json, ",",
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
  local position = reaper.GetPlayPosition()

  if project_name ~= nil and project_name ~= "" then
    display_name = project_name:match("([^/\\]+)$") or project_name
  end

  return table.concat({
    "{",
    '"projectName":', json_string(display_name), ",",
    '"transport":', json_string(current_transport()), ",",
    '"positionSeconds":', json_number(position), ",",
    '"positionBeats":', json_number(beat_position(position)), ",",
    '"beatsPerBar":', json_number(beats_per_bar_at(position)), ",",
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

  local jump_play_position = command:match("^jump%.play%s+([%d%.]+)$")
  if jump_play_position ~= nil then
    reaper.SetEditCurPos(one_bar_before(jump_play_position), true, false)
    reaper.OnPlayButton()
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
