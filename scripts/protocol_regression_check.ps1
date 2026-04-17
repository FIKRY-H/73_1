[CmdletBinding()]
param(
    [string]$RepoRoot,
    [switch]$RunBuild
)

$ErrorActionPreference = "Stop"
$script:Passed = 0
$script:Failed = 0

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    }
    else {
        $RepoRoot = (Get-Location).Path
    }
}

function Write-CheckResult {
    param(
        [bool]$Ok,
        [string]$Name,
        [string]$Details = ""
    )

    if ($Ok) {
        $script:Passed++
        Write-Host ("[PASS] {0}" -f $Name) -ForegroundColor Green
        return
    }

    $script:Failed++
    Write-Host ("[FAIL] {0}" -f $Name) -ForegroundColor Red
    if ($Details) {
        Write-Host ("       {0}" -f $Details) -ForegroundColor DarkGray
    }
}

function Resolve-TargetPath {
    param([string]$RelativePath)
    return Join-Path $RepoRoot $RelativePath
}

function Get-FileContent {
    param([string]$RelativePath)

    $path = Resolve-TargetPath $RelativePath
    if (-not (Test-Path $path)) {
        throw "Missing file: $RelativePath"
    }

    return Get-Content -Path $path -Raw -Encoding UTF8
}

function Assert-Regex {
    param(
        [string]$RelativePath,
        [string]$Pattern,
        [string]$Name
    )

    try {
        $content = Get-FileContent $RelativePath
        $ok = $content -match $Pattern
        Write-CheckResult -Ok $ok -Name $Name -Details ("Pattern not found in {0}" -f $RelativePath)
    }
    catch {
        Write-CheckResult -Ok $false -Name $Name -Details $_.Exception.Message
    }
}

function Assert-NotRegex {
    param(
        [string]$RelativePath,
        [string]$Pattern,
        [string]$Name
    )

    try {
        $content = Get-FileContent $RelativePath
        $ok = -not ($content -match $Pattern)
        Write-CheckResult -Ok $ok -Name $Name -Details ("Unexpected pattern found in {0}" -f $RelativePath)
    }
    catch {
        Write-CheckResult -Ok $false -Name $Name -Details $_.Exception.Message
    }
}

function Run-BuildCheck {
    param(
        [string]$RelativePath,
        [string]$Name
    )

    $path = Resolve-TargetPath $RelativePath
    if (-not (Test-Path $path)) {
        Write-CheckResult -Ok $false -Name $Name -Details ("Missing project path: {0}" -f $RelativePath)
        return
    }

    Push-Location $path
    try {
        Write-Host ("[RUN ] {0}" -f $Name) -ForegroundColor Cyan
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build exited with code $LASTEXITCODE"
        }
        Write-CheckResult -Ok $true -Name $Name
    }
    catch {
        Write-CheckResult -Ok $false -Name $Name -Details $_.Exception.Message
    }
    finally {
        Pop-Location
    }
}

Write-Host "========================================"
Write-Host "Protocol Upgrade Regression Check"
Write-Host "========================================"
Write-Host ("RepoRoot: {0}" -f $RepoRoot)
Write-Host ""

# 1) Core protocol map (server)
Assert-Regex "webbattery_server/src/utils/modbusFrameUtils.ts" "CONTROL_CYCLE:\s*0x0002" "Server map: F1 control register is 0x0002"
Assert-Regex "webbattery_server/src/utils/modbusFrameUtils.ts" "TEST_DONE:\s*0x0020" "Server map: TEST_DONE uses bit5 (0x0020)"
Assert-Regex "webbattery_server/src/utils/modbusFrameUtils.ts" "DATA_READY:\s*0x0080" "Server map: DATA_READY uses bit7 (0x0080)"
Assert-Regex "webbattery_server/src/utils/modbusFrameUtils.ts" "ADDRESS_MASK:\s*0xFE00" "Server map: address mask uses bit9-15 (0xFE00)"
Assert-Regex "webbattery_server/src/utils/modbusFrameUtils.ts" "ADDRESS_MASK\)\s*>>\s*9" "Server parse: address shift is >> 9"
Assert-NotRegex "webbattery_server/src/utils/modbusFrameUtils.ts" ">>\s*11" "Server parse: no old address shift >> 11"

# 2) F2 workflow checks (polling)
Assert-Regex "webbattery_server/src/services/pollingService.ts" "setTimeout\(r,\s*25000\)" "F2 flow: has 25s silent period"
Assert-Regex "webbattery_server/src/services/pollingService.ts" "setTimeout\(r,\s*1000\)" "F2 flow: has 1s test_done polling interval"
Assert-Regex "webbattery_server/src/services/pollingService.ts" "const maxReads = 60;" "F2 flow: max read count is 60"
Assert-Regex "webbattery_server/src/services/pollingService.ts" "\},\s*50\);\s*//\s*50ms" "F2 flow: harvest interval is 50ms"

# 3) Socket entry and status gating
Assert-Regex "webbattery_server/src/services/socketService.ts" "startF2FastPolling\(connectionId,\s*unitId\)" "Socket entry: startF2FastTest routes to startF2FastPolling"
Assert-Regex "webbattery_server/src/services/socketService.ts" "status\s*&\s*STATUS_BITS\.DATA_READY" "Socket gating: DATA_READY uses STATUS_BITS constant"

# 4) Storage / persistence status gating
Assert-Regex "webbattery_server/src/services/batteryService.ts" "status\s*&\s*STATUS_BITS\.DATA_READY" "Storage: DATA_READY uses STATUS_BITS constant"

# 5) Client-side mask and parse checks
Assert-Regex "webbattery_client/src/contexts/BatteryDataContext.tsx" "actualData\.status\s*&\s*0x0080" "Client context: DATA_READY mask is 0x0080"
Assert-NotRegex "webbattery_client/src/contexts/BatteryDataContext.tsx" "actualData\.status\s*&\s*0x0100" "Client context: no old DATA_READY mask 0x0100"
Assert-Regex "webbattery_client/src/components/DataDisplay.tsx" "displayStatusRawValue\s*&\s*0x0020" "Client display: TEST_DONE bit uses 0x0020"
Assert-Regex "webbattery_client/src/components/DataDisplay.tsx" "displayStatusRawValue\s*&\s*0x0080" "Client display: DATA_READY bit uses 0x0080"
Assert-Regex "webbattery_client/src/components/DataDisplay.tsx" "0xFE00\)\s*>>\s*9" "Client display: address parse uses 0xFE00 >> 9"

if ($RunBuild) {
    Write-Host ""
    Write-Host "Build verification enabled (-RunBuild)." -ForegroundColor Cyan
    Run-BuildCheck "webbattery_server" "Build: server"
    Run-BuildCheck "webbattery_client" "Build: client"
}

Write-Host ""
Write-Host "========================================"
Write-Host ("Summary: PASS={0}, FAIL={1}" -f $script:Passed, $script:Failed)
Write-Host "========================================"

if ($script:Failed -gt 0) {
    exit 1
}

exit 0