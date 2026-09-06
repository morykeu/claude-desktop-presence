<#
.SYNOPSIS
    Registers claude-desktop-presence as a Scheduled Task that starts at logon.

.DESCRIPTION
    Three settings here are not cosmetic; without them the task registers happily and
    then fails in ways that are hard to diagnose:

    1. LogonType Interactive ("run only when the user is logged on"). The Discord IPC
       pipe is per-session. A task running as SYSTEM, or anything parked in session 0,
       simply never sees \\.\pipe\discord-ipc-0 and the daemon reconnects forever.

    2. ExecutionTimeLimit PT0S (no limit). The default is 3 days, after which the task
       scheduler kills the daemon without a word.

    3. An explicit WorkingDirectory. resolveBaseDir has a fallback, but a Scheduled
       Task's working directory is typically C:\Windows\System32 — which is exactly
       where you do not want the daemon looking for config.json, or writing it.

    The startup folder is deliberately not used: it flashes a console window on every
    logon.

.PARAMETER ExePath
    Path to claude-desktop-presence.exe. Defaults to the .exe next to this script, then
    to one in the parent directory.

.PARAMETER TaskName
    Scheduled Task name. Default: ClaudeDesktopPresence

.PARAMETER Uninstall
    Removes the task instead of creating it.

.EXAMPLE
    .\install-autostart.ps1
    .\install-autostart.ps1 -ExePath C:\Tools\claude-desktop-presence.exe
    .\install-autostart.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [string] $ExePath,
    [string] $TaskName = 'ClaudeDesktopPresence',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

function Get-ExistingTask {
    param([string] $Name)
    try {
        return Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    } catch {
        return $null
    }
}

if ($Uninstall) {
    $existing = Get-ExistingTask -Name $TaskName
    if ($null -eq $existing) {
        Write-Host "Task '$TaskName' is not registered; nothing to remove."
        exit 0
    }

    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } catch {
        # Not running. Fine.
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

    if ($null -eq (Get-ExistingTask -Name $TaskName)) {
        Write-Host "Removed scheduled task '$TaskName'."
        Write-Host 'Your config.json and the daemon log were left alone.'
        exit 0
    }

    Write-Error "Task '$TaskName' still exists after unregistering."
    exit 1
}

# --- resolve the executable -------------------------------------------------

if (-not $ExePath) {
    $candidates = @(
        (Join-Path $PSScriptRoot 'claude-desktop-presence.exe'),
        (Join-Path (Split-Path $PSScriptRoot -Parent) 'claude-desktop-presence.exe')
    )
    $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $ExePath -or -not (Test-Path $ExePath)) {
    Write-Error @'
Could not find claude-desktop-presence.exe.
Pass it explicitly:  .\install-autostart.ps1 -ExePath C:\path\to\claude-desktop-presence.exe
'@
    exit 1
}

$ExePath = (Resolve-Path $ExePath).Path
$workingDirectory = Split-Path $ExePath -Parent

$configPath = Join-Path $workingDirectory 'config.json'
if (-not (Test-Path $configPath)) {
    Write-Warning "No config.json next to the exe yet. Run '$ExePath' once to create it, then fill in clientId."
}

# --- register ---------------------------------------------------------------

# WorkingDirectory is set explicitly: a Scheduled Task otherwise starts in
# C:\Windows\System32 and the daemon would look for its config there.
$action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory $workingDirectory

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Interactive: the Discord IPC pipe is per-session and invisible from session 0.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# ExecutionTimeLimit 0 = PT0S = no limit. The 3-day default would kill the daemon.
# Restart on failure, and keep going on battery — this is a laptop-friendly daemon.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

if ($null -ne (Get-ExistingTask -Name $TaskName)) {
    Write-Host "Task '$TaskName' already exists; replacing it."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Discord Rich Presence for Claude Desktop' | Out-Null

# --- verify -----------------------------------------------------------------

$task = Get-ExistingTask -Name $TaskName
if ($null -eq $task) {
    Write-Error "Registration reported success but the task is not there."
    exit 1
}

$limit = $task.Settings.ExecutionTimeLimit
if ($limit -ne 'PT0S') {
    Write-Warning "ExecutionTimeLimit came back as '$limit', not PT0S. The daemon may be killed after that long."
}

Write-Host ''
Write-Host "Registered scheduled task '$TaskName'."
Write-Host "  exe                : $ExePath"
Write-Host "  working directory  : $workingDirectory"
Write-Host "  runs               : at logon, in your own session"
Write-Host "  execution limit    : $limit"
Write-Host ''
Write-Host 'Start it now with:   Start-ScheduledTask -TaskName ' + $TaskName
Write-Host 'Remove it with:      .\install-autostart.ps1 -Uninstall'
