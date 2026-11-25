# Does `shutdown /s /t N` count from the wall clock or from a monotonic timer?
#
# Run this ELEVATED (it changes the system clock, which needs administrator):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-clock.ps1
#
# It answers the question the plugin's design depends on:
#
#   * If the timeout follows the WALL CLOCK, moving the clock back one hour moves
#     the deadline one hour later, so the machine is still running well after the
#     nominal deadline.
#   * If the timeout follows a MONOTONIC counter (system uptime), the clock change
#     changes nothing and the machine switches itself off on schedule.
#
# Both outcomes are recorded in the verdict file, so the answer survives the
# machine going away mid-test. The clock is restored and the shutdown aborted on
# every path where this script survives.
param(
  [int]$Seconds = 120,
  [string]$VerdictFile = (Join-Path $env:TEMP 'dsh-idle-shutdown-clock-verdict.txt')
)

$ErrorActionPreference = 'Stop'

function Write-Verdict([string]$line) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "$stamp  $line" | Tee-Object -FilePath $VerdictFile -Append | Out-Null
  Write-Host "$stamp  $line"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This probe must run elevated: it moves the system clock (SeSystemtimePrivilege).'
  Write-Host "Right-click PowerShell -> 'Run as administrator', then run this file again."
  exit 2
}

if ($Seconds -lt 60) { $Seconds = 60 }
$original = Get-Date
$restored = $false
function Restore-Clock {
  if ($script:restored) { return }
  $script:restored = $true
  try {
    Set-Date -Date $script:original -ErrorAction Stop
    Write-Verdict "clock restored"
  } catch {
    Write-Verdict ("clock could NOT be restored: {0}; run 'w32tm /resync' or set it back manually" -f $_.Exception.Message)
  }
}

Write-Verdict ("PROBE START  timeout={0}s  clock={1:yyyy-MM-dd HH:mm:ss}" -f $Seconds, $original)
try {
  # Arm the OS timeout, then move the clock back one hour. Nothing else is
  # touched: no Task Scheduler, no reboot, no data.
  & shutdown.exe /s /t $Seconds /c "DSH idle shutdown clock probe" | Out-Null
  Write-Verdict "armed shutdown.exe /s /t $Seconds"
  Start-Sleep -Seconds 3
  # The shift must happen AFTER arming and the timeout must NOT be re-armed:
  # re-arming would compute a fresh deadline from the shifted clock and both
  # kinds of timer would then fire at the same real time.
  Set-Date -Date $original.AddHours(-1) | Out-Null
  Write-Verdict "clock moved back one hour; waiting past the nominal deadline"
  $deadline = (Get-Date).AddSeconds($Seconds + 25)
  while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }

  Write-Verdict "SURVIVED past the nominal deadline => the timeout follows the WALL CLOCK"
  Write-Verdict "   (a monotonic timeout would have powered the machine off at the deadline)"
  & shutdown.exe /a | Out-Null
  Write-Verdict "shutdown aborted"
} catch {
  Write-Verdict ("probe error: {0}" -f $_.Exception.Message)
} finally {
  Restore-Clock
  Write-Verdict "PROBE END (no SURVIVED line above => the timeout is monotonic: the deadline moved with the machine, not the clock)"
  Write-Host "verdict file: $VerdictFile"
}