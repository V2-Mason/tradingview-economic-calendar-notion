#requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Trader Master Journal Market Intelligence Sync"
$taskPath = "\"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$updaterPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "update_private_earnings.ps1"))
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function ConvertTo-XmlText {
    param([string]$Value)
    return [System.Security.SecurityElement]::Escape($Value)
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Scheduled Task '$taskName' is not installed."
        exit 0
    }
    if ($PSCmdlet.ShouldProcess("Scheduled Task '$taskName'", "Unregister")) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
        Write-Host "Unregistered Scheduled Task '$taskName'."
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
    throw "Updater script is missing: $updaterPath"
}
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw "Windows PowerShell 5.1 executable is missing: $windowsPowerShell"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($null -eq $identity.User) {
    throw "Cannot determine the current Windows user SID"
}
$userSid = $identity.User.Value
$startBoundary = (Get-Date).AddMinutes(5).ToString("yyyy-MM-ddTHH:mm:ss")
$actionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updaterPath`" -PublishNotion"

$escapedAuthor = ConvertTo-XmlText $identity.Name
$escapedSid = ConvertTo-XmlText $userSid
$escapedPowerShell = ConvertTo-XmlText $windowsPowerShell
$escapedArguments = ConvertTo-XmlText $actionArguments
$escapedWorkingDirectory = ConvertTo-XmlText $repositoryRoot

$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$escapedAuthor</Author>
    <Description>Refresh private Moomoo, Yahoo, earnings, and company-news intelligence; rebuild the offline view; then publish explicitly configured Notion databases.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$escapedSid</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT2H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escapedSid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escapedPowerShell</Command>
      <Arguments>$escapedArguments</Arguments>
      <WorkingDirectory>$escapedWorkingDirectory</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

# Parse before ShouldProcess so -WhatIf still validates that the generated XML is well formed.
[xml]$null = $taskXml

Write-Host "Task name: $taskName"
Write-Host "Principal: $($identity.Name) (InteractiveToken; no stored credentials)"
Write-Host "Triggers: AtLogOn and every 2 hours"
Write-Host "Multiple instances: IgnoreNew"
Write-Host "Start when available: true"
Write-Host "Action: powershell.exe update_private_earnings.ps1 -PublishNotion"

if ($PSCmdlet.ShouldProcess("Scheduled Task '$taskName'", "Register or replace")) {
    Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $taskXml -Force | Out-Null
    $registered = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    Write-Host "Registered Scheduled Task '$($registered.TaskName)' in state $($registered.State)."
}
