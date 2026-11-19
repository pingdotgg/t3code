--!strict
-- Continuum Bridge for Roblox Studio.
-- Continuum installs this file into Studio's local Plugins folder. It long-polls the Continuum
-- bridge on this computer (127.0.0.1) so agents can inspect and edit the open place, run
-- playtests and Luau specs, and read the Output window. Studio asks once before allowing
-- HTTP requests to localhost; choose Allow.

local CONFIG = {
	url = "http://127.0.0.1:47321", --[[CONTINUUM_URL]]
	token = "", --[[CONTINUUM_TOKEN]]
	pluginVersion = "1.0.0",
	protocol = 1,
}

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Selection = game:GetService("Selection")

local function optionalService(name: string): any
	local ok, service = pcall(function()
		return game:GetService(name)
	end)
	return if ok then service else nil
end

local ScriptEditorService = optionalService("ScriptEditorService")
local ReflectionService = optionalService("ReflectionService")
local StudioTestService = optionalService("StudioTestService")
local AssetService = optionalService("AssetService")
local InsertService = optionalService("InsertService")

local Bridge = {}

-- Paths ------------------------------------------------------------------------------------

local function splitPath(path: any): { string }
	if type(path) == "table" then
		return path
	end
	local parts = {}
	if type(path) ~= "string" or path == "" or path == "game" then
		return parts
	end
	local text = path:gsub("^game%.", "")
	for part in string.gmatch(text, "[^%.]+") do
		table.insert(parts, part)
	end
	return parts
end

local function resolve(path: any): Instance?
	local parts = splitPath(path)
	local current: Instance = game
	for index, name in ipairs(parts) do
		local child: Instance? = nil
		if index == 1 then
			local ok, service = pcall(function()
				return game:GetService(name)
			end)
			child = if ok and service then service else game:FindFirstChild(name)
		else
			child = current:FindFirstChild(name)
		end
		if child == nil then
			return nil
		end
		current = child
	end
	return current
end

local function pathOf(instance: Instance): string
	local parts = {}
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return table.concat(parts, ".")
end

local function requireInstance(path: any): Instance
	local instance = resolve(path)
	if instance == nil then
		error(`No instance at {tostring(path)}`, 0)
	end
	return instance
end

-- Values -----------------------------------------------------------------------------------

local function encode(value: any): any
	local kind = typeof(value)
	if kind == "Vector3" then
		return { x = value.X, y = value.Y, z = value.Z }
	elseif kind == "Vector2" then
		return { x = value.X, y = value.Y }
	elseif kind == "Color3" then
		return { r = value.R, g = value.G, b = value.B, hex = "#" .. value:ToHex() }
	elseif kind == "CFrame" then
		local rx, ry, rz = value:ToOrientation()
		return {
			position = { x = value.X, y = value.Y, z = value.Z },
			rotation = { x = math.deg(rx), y = math.deg(ry), z = math.deg(rz) },
		}
	elseif kind == "UDim2" then
		return { xScale = value.X.Scale, xOffset = value.X.Offset, yScale = value.Y.Scale, yOffset = value.Y.Offset }
	elseif kind == "UDim" then
		return { scale = value.Scale, offset = value.Offset }
	elseif kind == "BrickColor" then
		return value.Name
	elseif kind == "EnumItem" then
		return tostring(value)
	elseif kind == "Instance" then
		return { ref = pathOf(value) }
	elseif kind == "NumberRange" then
		return { min = value.Min, max = value.Max }
	elseif kind == "string" or kind == "number" or kind == "boolean" or kind == "nil" then
		return value
	end
	return tostring(value)
end

local function decodeFor(current: any, value: any): any
	local kind = typeof(current)
	if kind == "Vector3" and type(value) == "table" then
		return Vector3.new(value.x or value[1] or 0, value.y or value[2] or 0, value.z or value[3] or 0)
	elseif kind == "Vector2" and type(value) == "table" then
		return Vector2.new(value.x or value[1] or 0, value.y or value[2] or 0)
	elseif kind == "Color3" then
		if type(value) == "string" then
			return Color3.fromHex(value)
		elseif type(value) == "table" then
			local r, g, b = value.r or value[1] or 0, value.g or value[2] or 0, value.b or value[3] or 0
			if r > 1 or g > 1 or b > 1 then
				return Color3.fromRGB(r, g, b)
			end
			return Color3.new(r, g, b)
		end
	elseif kind == "CFrame" and type(value) == "table" then
		local p = value.position or value
		local base = CFrame.new(p.x or 0, p.y or 0, p.z or 0)
		if value.lookAt then
			return CFrame.lookAt(base.Position, Vector3.new(value.lookAt.x, value.lookAt.y, value.lookAt.z))
		end
		local r = value.rotation or { x = 0, y = 0, z = 0 }
		return base * CFrame.fromOrientation(math.rad(r.x or 0), math.rad(r.y or 0), math.rad(r.z or 0))
	elseif kind == "UDim2" and type(value) == "table" then
		if value[1] ~= nil then
			return UDim2.new(value[1], value[2], value[3], value[4])
		end
		return UDim2.new(value.xScale or 0, value.xOffset or 0, value.yScale or 0, value.yOffset or 0)
	elseif kind == "UDim" and type(value) == "table" then
		return UDim.new(value.scale or value[1] or 0, value.offset or value[2] or 0)
	elseif kind == "BrickColor" and type(value) == "string" then
		return BrickColor.new(value)
	elseif kind == "EnumItem" and type(value) == "string" then
		local name = value:match("([^%.]+)$")
		return (current :: EnumItem).EnumType[name]
	elseif kind == "NumberRange" and type(value) == "table" then
		return NumberRange.new(value.min or 0, value.max or value.min or 0)
	elseif (kind == "Instance" or kind == "nil") and type(value) == "table" and value.ref then
		return requireInstance(value.ref)
	end
	return value
end

local COMMON_PROPERTIES = {
	"Name", "ClassName", "Archivable", "Anchored", "CanCollide", "CanTouch", "CanQuery", "Transparency",
	"Size", "Position", "CFrame", "Orientation", "Color", "BrickColor", "Material", "Reflectance", "Shape",
	"Massless", "Locked", "MeshId", "TextureID", "Text", "TextColor3", "TextSize", "TextScaled", "Font",
	"BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "AnchorPoint", "ZIndex", "Visible",
	"Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter", "LayoutOrder", "Enabled",
	"ResetOnSpawn", "ZIndexBehavior", "DisplayOrder", "Value", "MaxHealth", "Health", "WalkSpeed",
	"JumpPower", "PrimaryPart", "Brightness", "Range", "Shadows", "Texture", "Face", "SoundId", "Volume",
	"Looped", "Playing", "RunContext", "Disabled", "Adornee", "MaxDistance", "Heat", "Rate", "Lifetime",
}

local function propertyNames(instance: Instance): { string }
	if ReflectionService then
		local ok, properties = pcall(function()
			return ReflectionService:GetPropertiesOfClass(instance.ClassName)
		end)
		if ok and type(properties) == "table" and #properties > 0 then
			local names = {}
			for _, property in ipairs(properties) do
				local name = if type(property) == "table" then property.Name else property
				if type(name) == "string" then
					table.insert(names, name)
				end
			end
			return names
		end
	end
	return COMMON_PROPERTIES
end

local function readProperties(instance: Instance): { [string]: any }
	local result = {}
	for _, name in ipairs(propertyNames(instance)) do
		if name ~= "Source" and name ~= "Parent" then
			local ok, value = pcall(function()
				return (instance :: any)[name]
			end)
			if ok then
				result[name] = encode(value)
			end
		end
	end
	return result
end

local function setProperties(instance: Instance, properties: { [string]: any }?)
	if properties == nil then
		return
	end
	for name, value in pairs(properties) do
		if name == "Parent" then
			instance.Parent = requireInstance(value)
		elseif name ~= "ClassName" then
			local ok, current = pcall(function()
				return (instance :: any)[name]
			end)
			if not ok then
				error(`{instance.ClassName} has no property {name}`, 0)
			end
			local applied, problem = pcall(function()
				(instance :: any)[name] = decodeFor(current, value)
			end)
			if not applied then
				error(`Could not set {name}: {problem}`, 0)
			end
		end
	end
end

local function setAttributes(instance: Instance, attributes: { [string]: any }?)
	if attributes == nil then
		return
	end
	for name, value in pairs(attributes) do
		instance:SetAttribute(name, value)
	end
end

-- Change history -----------------------------------------------------------------------------

local function recorded<T>(name: string, run: () -> T): T
	local recording: any = nil
	local okBegin, id = pcall(function()
		return ChangeHistoryService:TryBeginRecording(name)
	end)
	if okBegin then
		recording = id
	end
	local ok, result = pcall(run)
	if recording then
		pcall(function()
			ChangeHistoryService:FinishRecording(
				recording,
				if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
			)
		end)
	else
		pcall(function()
			ChangeHistoryService:SetWaypoint(name)
		end)
	end
	if not ok then
		error(result, 0)
	end
	return result
end

-- Operations ---------------------------------------------------------------------------------

local function describe(instance: Instance, depth: number, limit: { remaining: number }): any
	limit.remaining -= 1
	local node: any = { name = instance.Name, className = instance.ClassName, path = pathOf(instance) }
	local children = instance:GetChildren()
	node.childCount = #children
	if depth > 0 and limit.remaining > 0 then
		node.children = {}
		for _, child in ipairs(children) do
			if limit.remaining <= 0 then
				node.truncated = true
				break
			end
			table.insert(node.children, describe(child, depth - 1, limit))
		end
	end
	return node
end

local function isScript(instance: Instance): boolean
	return instance:IsA("LuaSourceContainer")
end

local function readSource(script: Instance): string
	if ScriptEditorService then
		local ok, source = pcall(function()
			return ScriptEditorService:GetEditorSource(script)
		end)
		if ok and type(source) == "string" then
			return source
		end
	end
	return (script :: any).Source
end

local function writeSource(script: Instance, source: string)
	if ScriptEditorService then
		local ok = pcall(function()
			ScriptEditorService:UpdateSourceAsync(script, function()
				return source
			end)
		end)
		if ok then
			return
		end
	end
	(script :: any).Source = source
end

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

local state = {
	sessionId = nil :: string?,
	running = false,
	outbox = {} :: { any },
	testCapture = nil :: { lines: { string } }?,
	lastPlayState = "edit",
}

local function playState(): string
	local ok, isRunning = pcall(function()
		return RunService:IsRunning()
	end)
	return if ok and isRunning then "playing" else "edit"
end

local operations: { [string]: (args: any) -> any } = {}

operations["scene.tree"] = function(args)
	local root = if args.path then requireInstance(args.path) else game
	local depth = math.clamp(tonumber(args.depth) or 2, 0, 8)
	if root == game then
		local services = {}
		for _, name in ipairs({ "Workspace", "Players", "Lighting", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Teams", "TestService" }) do
			local service = resolve(name)
			if service then
				table.insert(services, describe(service, depth - 1, { remaining = 400 }))
			end
		end
		return { name = game.Name, className = "DataModel", path = "game", children = services }
	end
	return describe(root, depth, { remaining = 600 })
end

operations["selection.get"] = function()
	local selected = {}
	for _, instance in ipairs(Selection:Get()) do
		table.insert(selected, { path = pathOf(instance), className = instance.ClassName })
	end
	return { selection = selected }
end

operations["object.get"] = function(args)
	local instance = requireInstance(args.path)
	local result: any = {
		path = pathOf(instance),
		className = instance.ClassName,
		properties = readProperties(instance),
		attributes = instance:GetAttributes(),
		tags = CollectionService:GetTags(instance),
		children = {},
	}
	for _, child in ipairs(instance:GetChildren()) do
		table.insert(result.children, { name = child.Name, className = child.ClassName })
	end
	if isScript(instance) then
		result.sourceLength = #readSource(instance)
	end
	return result
end

operations["object.create"] = function(args)
	return recorded("Continuum: create " .. tostring(args.className), function()
		local parent = requireInstance(args.parent or args.parentPath or "Workspace")
		local instance = Instance.new(args.className)
		if args.name then
			instance.Name = args.name
		end
		setProperties(instance, args.properties)
		setAttributes(instance, args.attributes)
		for _, tag in ipairs(args.tags or {}) do
			CollectionService:AddTag(instance, tag)
		end
		if args.source and isScript(instance) then
			(instance :: any).Source = args.source
		end
		instance.Parent = parent
		return { path = pathOf(instance), className = instance.ClassName }
	end)
end

operations["object.update"] = function(args)
	return recorded("Continuum: update", function()
		local instance = requireInstance(args.path)
		setProperties(instance, args.properties)
		setAttributes(instance, args.attributes)
		return { path = pathOf(instance), properties = readProperties(instance) }
	end)
end

operations["object.delete"] = function(args)
	return recorded("Continuum: delete", function()
		local instance = requireInstance(args.path)
		local path = pathOf(instance)
		instance:Destroy()
		return { deleted = path }
	end)
end

operations["script.read"] = function(args)
	local instance = requireInstance(args.path)
	if not isScript(instance) then
		error(`{pathOf(instance)} is a {instance.ClassName}, not a script`, 0)
	end
	return { path = pathOf(instance), className = instance.ClassName, source = readSource(instance) }
end

operations["script.write"] = function(args)
	return recorded("Continuum: edit script", function()
		local instance = resolve(args.path)
		if instance == nil then
			local parts = splitPath(args.path)
			local name = table.remove(parts)
			local parent = requireInstance(parts)
			local className = args.className or "ModuleScript"
			if not SCRIPT_CLASSES[className] then
				error(`{className} is not a script class`, 0)
			end
			instance = Instance.new(className)
			instance.Name = name :: string
			instance.Parent = parent
		end
		assert(instance)
		if not isScript(instance) then
			error(`{pathOf(instance)} is not a script`, 0)
		end
		writeSource(instance, args.source)
		return { path = pathOf(instance), className = instance.ClassName, length = #args.source }
	end)
end

operations["asset.import"] = function(args)
	return recorded("Continuum: import asset", function()
		local assetId = tostring(args.assetId or "")
		if not assetId:match("^%d+$") then
			error("asset.import needs the numeric Roblox asset id from an approved upload", 0)
		end
		local content = "rbxassetid://" .. assetId
		local parent = requireInstance(args.parent or "Workspace")
		local kind = args.kind or "image"
		local instance: Instance
		if kind == "image" then
			instance = Instance.new(args.className or "ImageLabel")
			;(instance :: any).Image = content
			if instance:IsA("GuiObject") then
				(instance :: any).BackgroundTransparency = 1
			end
		elseif kind == "decal" then
			instance = Instance.new("Decal")
			;(instance :: any).Texture = content
		elseif kind == "mesh" then
			if AssetService == nil then
				error("AssetService is not available", 0)
			end
			instance = AssetService:CreateMeshPartAsync(content)
		elseif kind == "model" then
			if InsertService == nil then
				error("InsertService is not available", 0)
			end
			local loaded = InsertService:LoadAsset(tonumber(assetId))
			local children = loaded:GetChildren()
			instance = if #children == 1 then children[1] else loaded
		else
			error(`Unknown asset kind {kind}`, 0)
		end
		if args.name then
			instance.Name = args.name
		end
		setProperties(instance, args.properties)
		instance.Parent = parent
		local result: any = { path = pathOf(instance), className = instance.ClassName, content = content }
		if instance:IsA("BasePart") then
			result.size = encode((instance :: BasePart).Size)
		elseif instance:IsA("Model") then
			local _, size = (instance :: Model):GetBoundingBox()
			result.size = encode(size)
		end
		return result
	end)
end

operations["playtest.status"] = function()
	return { playState = playState() }
end

operations["playtest.start"] = function(args)
	local mode = args.mode or "run"
	if playState() == "playing" then
		return { playState = "playing", alreadyRunning = true }
	end
	if mode == "play" then
		if StudioTestService == nil then
			error("This Studio version does not let plugins start Play mode. Use mode \"run\" or press Play.", 0)
		end
		task.spawn(function()
			pcall(function()
				StudioTestService:ExecutePlayModeAsync(args.testArgs or {})
			end)
		end)
	else
		RunService:Run()
	end
	return { playState = "playing", mode = mode }
end

operations["playtest.stop"] = function()
	if playState() ~= "playing" then
		return { playState = "edit", alreadyStopped = true }
	end
	RunService:Stop()
	return { playState = "edit" }
end

local TEST_PREFIX = "[ContinuumTest]"

local RUNNER_SOURCE = [==[
-- Created by Continuum to run Luau specs in Run mode; removed after the run.
local HttpService = game:GetService("HttpService")
local prefix = "[ContinuumTest]"
local filter = script:GetAttribute("Filter") or ""
local roots = {}
for _, path in ipairs(string.split(script:GetAttribute("Roots") or "ServerScriptService.Tests", ",")) do
	local current = game
	for index, name in ipairs(string.split(path, ".")) do
		current = if index == 1 then (game:FindFirstChild(name) or game:GetService(name)) else (current and current:FindFirstChild(name))
	end
	if current then table.insert(roots, current) end
end
local function report(value) print(prefix .. HttpService:JSONEncode(value)) end
local passed, failed = 0, 0
for _, root in ipairs(roots) do
	for _, module in ipairs(root:GetDescendants()) do
		if module:IsA("ModuleScript") and module.Name:match("%.spec$") and (filter == "" or module:GetFullName():find(filter, 1, true)) then
			local ok, spec = pcall(require, module)
			if not ok then
				failed += 1
				report({ type = "case", spec = module:GetFullName(), name = "(load)", ok = false, error = tostring(spec) })
			elseif type(spec) == "table" then
				for name, case in pairs(spec) do
					if type(case) == "function" then
						local expect = function(condition, message)
							if not condition then error(message or "expectation failed", 2) end
						end
						local caseOk, problem = pcall(case, expect)
						if caseOk then passed += 1 else failed += 1 end
						report({ type = "case", spec = module.Name, name = name, ok = caseOk, error = if caseOk then nil else tostring(problem) })
					end
				end
			end
		end
	end
end
report({ type = "done", passed = passed, failed = failed })
]==]

operations["tests.run"] = function(args)
	if playState() == "playing" then
		error("Stop the playtest before running specs.", 0)
	end
	local runner = Instance.new("Script")
	runner.Name = "ContinuumTestRunner"
	runner:SetAttribute("Filter", args.filter or "")
	runner:SetAttribute("Roots", table.concat(args.roots or { "ServerScriptService.Tests", "ReplicatedStorage.Tests", "TestService" }, ","))
	;(runner :: any).Source = RUNNER_SOURCE
	runner.Parent = game:GetService("ServerScriptService")
	local capture = { lines = {} }
	state.testCapture = capture
	local cases, summary = {}, nil
	local deadline = os.clock() + math.clamp(tonumber(args.timeoutSeconds) or 60, 5, 300)
	local ok, problem = pcall(function()
		RunService:Run()
		while os.clock() < deadline do
			task.wait(0.1)
			for _, line in ipairs(capture.lines) do
				local decoded = HttpService:JSONDecode(line)
				if decoded.type == "done" then
					summary = decoded
				else
					table.insert(cases, decoded)
				end
			end
			table.clear(capture.lines)
			if summary then
				break
			end
		end
	end)
	state.testCapture = nil
	pcall(function()
		RunService:Stop()
	end)
	runner:Destroy()
	if not ok then
		error(problem, 0)
	end
	if summary == nil then
		error("The specs did not finish in time; check the Output window.", 0)
	end
	return { passed = summary.passed, failed = summary.failed, cases = cases }
end

operations["viewport.focus"] = function(args)
	local target = requireInstance(args.path)
	local camera = workspace.CurrentCamera
	local center: Vector3, size: Vector3
	if target:IsA("Model") then
		local frame, extents = target:GetBoundingBox()
		center, size = frame.Position, extents
	elseif target:IsA("BasePart") then
		center, size = target.Position, target.Size
	else
		error(`{pathOf(target)} has no position to frame`, 0)
	end
	local distance = math.max(size.Magnitude * 1.4, 8)
	camera.CFrame = CFrame.lookAt(center + Vector3.new(distance * 0.6, distance * 0.5, distance * 0.6), center)
	return { framed = pathOf(target) }
end

operations["snapshot.capture"] = function(args)
	local scripts, instances = {}, {}
	for _, rootPath in ipairs(args.roots or { "ServerScriptService", "ReplicatedStorage", "StarterGui", "StarterPlayer", "Workspace" }) do
		local root = resolve(rootPath)
		if root then
			for _, instance in ipairs(root:GetDescendants()) do
				if isScript(instance) then
					table.insert(scripts, { path = pathOf(instance), className = instance.ClassName, source = readSource(instance) })
				elseif #instances < 2000 and (instance:IsA("BasePart") or instance:IsA("GuiObject") or instance:IsA("ValueBase")) then
					table.insert(instances, { path = pathOf(instance), className = instance.ClassName, properties = readProperties(instance), attributes = instance:GetAttributes() })
				end
			end
		end
	end
	return { scripts = scripts, instances = instances }
end

operations["snapshot.restore"] = function(args)
	return recorded("Continuum: restore checkpoint", function()
		local restored, created = 0, 0
		for _, entry in ipairs(args.scripts or {}) do
			local instance = resolve(entry.path)
			if instance == nil then
				local parts = splitPath(entry.path)
				local name = table.remove(parts)
				local parent = resolve(parts)
				if parent and SCRIPT_CLASSES[entry.className] then
					instance = Instance.new(entry.className)
					instance.Name = name :: string
					instance.Parent = parent
					created += 1
				end
			end
			if instance and isScript(instance) then
				writeSource(instance, entry.source)
				restored += 1
			end
		end
		for _, entry in ipairs(args.instances or {}) do
			local instance = resolve(entry.path)
			if instance then
				local props = table.clone(entry.properties or {})
				props.ClassName = nil
				pcall(setProperties, instance, props)
				pcall(setAttributes, instance, entry.attributes)
				restored += 1
			end
		end
		return { restored = restored, created = created }
	end)
end

operations["editor.undo"] = function()
	ChangeHistoryService:Undo()
	return { undone = true }
end

local advertised = {}
for name in pairs(operations) do
	table.insert(advertised, name)
end
table.sort(advertised)

-- Transport ----------------------------------------------------------------------------------

local function request(method: string, path: string, body: any?): (boolean, any, number)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = CONFIG.url .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. CONFIG.token },
			Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not ok then
		return false, response, 0
	end
	local decoded = nil
	if response.Body and response.Body ~= "" then
		local parsed, value = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		decoded = if parsed then value else nil
	end
	return response.Success, decoded, response.StatusCode
end

local function placeKey(): string
	return `{game.PlaceId}:{game.Name}`
end

local function hello(): (boolean, string?)
	local ok, body, status = request("POST", "/v1/hello", {
		protocol = CONFIG.protocol,
		engine = "roblox",
		editorVersion = version(),
		pluginVersion = CONFIG.pluginVersion,
		instanceId = "studio-" .. placeKey() .. "-" .. tostring(plugin and plugin:GetSetting("ContinuumInstance") or ""),
		projectRoot = nil,
		projectName = game.Name,
		placeKey = placeKey(),
		operations = advertised,
		playState = playState(),
	})
	if ok and body and body.sessionId then
		state.sessionId = body.sessionId
		return true, nil
	end
	return false, if body and body.error then body.error else `status {status}`
end

function Bridge.queueEvent(event: any)
	table.insert(state.outbox, event)
end

local function flushEvents()
	if state.sessionId == nil or #state.outbox == 0 then
		return
	end
	local events = state.outbox
	state.outbox = {}
	request("POST", "/v1/events", { session = state.sessionId, events = events })
end

local function runCommand(command: any): any
	local handler = operations[command.operation]
	if handler == nil then
		return { id = command.id, ok = false, error = "Unsupported operation " .. tostring(command.operation) }
	end
	local ok, value = pcall(handler, command.args or {})
	if ok then
		return { id = command.id, ok = true, value = value }
	end
	return { id = command.id, ok = false, error = tostring(value) }
end

Bridge.runCommand = runCommand
Bridge.operations = operations

function Bridge.step(): boolean
	if state.sessionId == nil then
		local ok = hello()
		if not ok then
			return false
		end
	end
	local current = playState()
	if current ~= state.lastPlayState then
		state.lastPlayState = current
		Bridge.queueEvent({ type = "play_state", state = current })
	end
	flushEvents()
	local ok, body, status = request("GET", "/v1/poll?session=" .. HttpService:UrlEncode(state.sessionId :: string))
	if status == 404 or status == 401 then
		state.sessionId = nil
		return false
	end
	if not ok or body == nil then
		return false
	end
	local results = {}
	for _, command in ipairs(body.commands or {}) do
		table.insert(results, runCommand(command))
	end
	if #results > 0 then
		request("POST", "/v1/results", { session = state.sessionId, results = results })
	end
	flushEvents()
	return true
end

function Bridge.start()
	if state.running then
		return
	end
	state.running = true
	-- The poll blocks while it waits; Output lines go out from here meanwhile.
	task.spawn(function()
		while state.running do
			task.wait(1)
			pcall(flushEvents)
		end
	end)
	task.spawn(function()
		local backoff = 1
		while state.running do
			local ok = Bridge.step()
			if ok then
				backoff = 1
			else
				task.wait(backoff)
				backoff = math.min(backoff * 2, 15)
			end
		end
	end)
end

function Bridge.stop()
	state.running = false
	if state.sessionId then
		request("POST", "/v1/goodbye", { session = state.sessionId })
		state.sessionId = nil
	end
end

LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
	if state.testCapture and string.sub(message, 1, #TEST_PREFIX) == TEST_PREFIX then
		table.insert(state.testCapture.lines, string.sub(message, #TEST_PREFIX + 1))
		return
	end
	local level = if messageType == Enum.MessageType.MessageError
		then "error"
		elseif messageType == Enum.MessageType.MessageWarning then "warning"
		else "info"
	Bridge.queueEvent({ type = "log", level = level, message = message })
	if #state.outbox > 200 then
		table.remove(state.outbox, 1)
	end
end)

-- Studio UI ----------------------------------------------------------------------------------

if plugin then
	if plugin:GetSetting("ContinuumInstance") == nil then
		plugin:SetSetting("ContinuumInstance", HttpService:GenerateGUID(false))
	end
	local toolbar = plugin:CreateToolbar("Continuum")
	local button = toolbar:CreateButton("ContinuumBridge", "Connect this place to Continuum", "rbxasset://textures/StudioToolbox/AssetPreview/play_button.png", "Continuum")
	button.ClickableWhenViewportHidden = true
	local enabled = plugin:GetSetting("ContinuumEnabled") ~= false
	button:SetActive(enabled)
	button.Click:Connect(function()
		enabled = not enabled
		plugin:SetSetting("ContinuumEnabled", enabled)
		button:SetActive(enabled)
		if enabled then
			Bridge.start()
		else
			Bridge.stop()
		end
	end)
	plugin.Unloading:Connect(Bridge.stop)
	if enabled and RunService:IsEdit() then
		Bridge.start()
	end
end

return Bridge
