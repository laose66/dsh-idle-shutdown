/**
 * Host half of `dsh-idle-shutdown`.
 *
 * Watches every conversation in this Host and, once the whole tree has been
 * idle for `idleMinutes`, shuts the machine down. The countdown
 * belongs to this plugin, so any conversation activity cancels it; only its
 * last `closeLeadSeconds` seconds are handed to the OS (`shutdown /s /t 3`),
 * which is what makes the action survive this process being closed and what
 * makes those last seconds final. Just before that hand-over a small guard
 * holds an OS power request, so a machine that is about to sleep wakes up to a
 * finished shutdown rather than to a command that fires late.
 *
 * "Busy" is derived from the Session log, not from polling a UI: a live Agent
 * whose turn is still open and either keeps committing events or is running a
 * step blocks the action, as do background jobs and terminal activity. A turn
 * that merely waits for the user (an unanswered approval or question) commits
 * nothing, so it stops blocking after `waitingGraceMinutes`; otherwise one
 * abandoned prompt would keep the machine on forever.
 *
 * The decision pipeline is exposed as pure helpers so `self-test.mjs` can
 * check it without a Host.
 *
 * @module dsh-idle-shutdown
 */

import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Diagnostic name of this Host plugin. */
export const name = 'idle-shutdown'

/** The one action this plugin performs: it is an idle *shutdown*, nothing else. */
export const ACTIONS = ['shutdown']

/** Smallest accepted `idleMinutes` (3 seconds) — exists for testing. */
export const MIN_IDLE_MINUTES = 0.05

/** Longest accepted idle wait: three hours. */
export const MAX_IDLE_MINUTES = 180

/** Longest accepted countdown: half an hour. */
export const MAX_WARNING_SECONDS = 1800

/**
 * Default whitelist window. The action may only fire inside one of the
 * configured windows, so an overnight range is the useful default: the machine
 * is shut down after the user has left it, never in the middle of a work day.
 */
export const DEFAULT_WINDOWS = [{ start: '23:00', end: '07:00', repeat: 'daily', persistent: true }]

/** How a window repeats. */
export const REPEATS = ['daily', 'today', 'count']

/** Operating systems the power action is adapted to. */
export const PLATFORMS = ['win32', 'darwin', 'linux']

/**
 * How long a window may be re-activated for, from the Settings page.
 *
 * A persistent window stays in the list after it fires, but a `today` one is
 * stamped to yesterday, a counted one can run out and a skipped one stays inert
 * until its range closes. Re-activation is what keeps "persistent" meaningful.
 */
export const REACTIVATIONS = ['today', 'count', 'daily']

/** Lifecycle of the row's re-activation quota: the smallest accepted count. */
export const MIN_REACTIVATION_COUNT = 1

/**
 * The stretch at the end of the countdown that belongs to the OS.
 *
 * The countdown itself is this plugin's: it can be cancelled right up to the
 * hand-over. The last seconds are different — they are spent inside
 * `shutdown /s /t <grace>`, which keeps the deadline even if DSH is closed, and
 * which cannot be taken back from here. Short is what makes it a safety net
 * instead of a second, uncontrollable countdown.
 */
export const DEFAULT_OS_GRACE_SECONDS = 3

/** Smallest accepted grace: `/t 0` would power off before DSH could leave. */
export const MIN_OS_GRACE_SECONDS = 3

/** Largest accepted grace, so a mistyped value cannot stretch the window. */
export const MAX_OS_GRACE_SECONDS = 60

/** The PowerShell guard written beside the status file. */
export const KEEP_AWAKE_SCRIPT = 'dsh-idle-shutdown-keep-awake.ps1'

/** The wrapper that guard is started through (a batch file has no quoting risk). */
export const KEEP_AWAKE_WRAPPER = 'dsh-idle-shutdown-keep-awake.cmd'

/** Written by the guard once the power request is actually held. */
export const KEEP_AWAKE_MARKER = 'dsh-idle-shutdown-keep-awake.ready'

/**
 * How long before the hand-over the wake guard is started.
 *
 * Starting the guard costs about 1.7 s here (WMI creation, PowerShell start,
 * `Add-Type`); starting it in the last moment would leave the first second of
 * the final countdown unprotected.
 */
export const KEEP_AWAKE_LEAD_MS = 3_000

/** Extra seconds the request is held beyond the OS grace, so it outlives it. */
export const KEEP_AWAKE_MARGIN_SECONDS = 20

/**
 * The PowerShell guard that keeps the system awake across the hand-over.
 *
 * It requests `ES_SYSTEM_REQUIRED` and nothing else: `ES_DISPLAY_REQUIRED` would
 * light the screen up, which a machine that is being switched off must not do.
 * The request is held for `Seconds` and then released, so the guard cannot keep
 * a machine awake that the OS failed to switch off.
 *
 * The marker is written only after `SetThreadExecutionState` has been called, so
 * the Host can wait for the guarantee instead of hoping the script started early
 * enough. Kept as a pure function so the script can be checked without running it.
 *
 * @returns the PowerShell source.
 */
export function keepAwakeScript() {
  return [
    "param([int]$Seconds = 20, [string]$Marker = '')",
    "Add-Type -Namespace DshPower -Name Native -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = false)]',
    'public static extern uint SetThreadExecutionState(int esFlags);',
    "'@",
    // One-shot by construction: the request belongs to this process's thread, so
    // it ends when this script ends — a reboot cannot keep it alive, and nothing
    // is scheduled to start it again later.
    '$started = Get-Date',
    'if ([DshPower.Native]::SetThreadExecutionState(([int]::MinValue) -bor 1) -eq 0) { exit 1 }',
    "if ($Marker -ne '') { Set-Content -LiteralPath $Marker -Value $PID -Encoding ascii -ErrorAction SilentlyContinue }",
    '$deadline = $started.AddSeconds([Math]::Max(1, $Seconds))',
    'try {',
    '  while ((Get-Date) -lt $deadline) {',
    '    Start-Sleep -Milliseconds 500',
    '    # 1075 = "the user aborted a shutdown". One that appears after we armed',
    '    # means the deadline this guard was protecting is gone: drop the request',
    '    # now instead of holding the machine awake for nothing.',
    "    $abort = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1075; StartTime = $started } -MaxEvents 1 -ErrorAction SilentlyContinue",
    '    if ($null -ne $abort) { break }',
    '  }',
    '} finally {',
    '  [void][DshPower.Native]::SetThreadExecutionState([int]::MinValue)',
    '}',
  ].join('\n')
}

/**
 * How this platform is asked to stay awake for a few seconds.
 *
 * Windows needs a helper process (the request is held per thread), macOS has
 * `caffeinate -i` and Linux has `systemd-inhibit --what=sleep`; both of those
 * block idle sleep only, so a blank screen stays blank.
 *
 * @param platform - `win32`, `darwin` or `linux`.
 * @param seconds - how long the request must be held.
 * @param locations - where the Windows helper files and marker live.
 * @returns the plan the engine executes.
 */
export function keepAwakePlan(platform, seconds, locations = {}) {
  const hold = Math.max(1, Math.floor(Number(seconds) || 1))
  if (platform === 'darwin') {
    return { mode: 'command', program: 'caffeinate', args: ['-i', '-t', String(hold)], marker: null }
  }
  if (platform === 'linux') {
    return {
      mode: 'command',
      program: 'systemd-inhibit',
      args: ['--what=sleep', '--why=DSH is about to switch the machine off', '--mode=block', 'sleep', String(hold)],
      marker: null,
    }
  }
  const directory = locations.directory ?? ''
  const marker = locations.marker ?? ''
  return {
    mode: 'windows',
    program: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      locations.script ?? KEEP_AWAKE_SCRIPT,
      '-Seconds',
      String(hold),
      '-Marker',
      marker,
    ],
    wrapper: locations.wrapper ?? KEEP_AWAKE_WRAPPER,
    directory,
    marker: marker === '' ? null : marker,
  }
}

/**
 * The PowerShell that starts the guard outside this process.
 *
 * A child of this Host is put in Chromium's job object and dies with DSH — which
 * is exactly the moment the guard must still be holding the request. Creating it
 * through WMI parents it to `WmiPrvSE.exe` instead, so it outlives the app.
 *
 * @param wrapper - the batch file to run, relative to `directory`.
 * @param directory - its directory, which is also the helper's cwd.
 * @returns the PowerShell command text.
 */
export function keepAwakeLauncher(wrapper, directory) {
  const quoted = `'${String(directory).replace(/'/g, "''")}'`
  const command = String(wrapper).replace(/'/g, "''")
  return (
    `$dir = ${quoted}; ` +
    // SW_HIDE: the guard is a console program, and a console window flashing up
    // on a machine that is being switched off is exactly what must not happen.
    `$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); ` +
    '$startup.ShowWindow = 0; ' +
    `$r = ([wmiclass]'Win32_Process').Create('cmd.exe /c ${command}', $dir, $startup); ` +
    '[Console]::Out.Write([int]$r.ReturnValue)'
  )
}

/**
 * The command that performs the idle shutdown on this platform.
 *
 * Only Windows owns a countdown: `shutdown /s /t <grace>` keeps the deadline
 * after this process is gone, which is why the last seconds are handed to it.
 * macOS and Linux have no equivalent, so the command is issued at the deadline
 * itself. In every case the system that is going away closes DSH.
 *
 * @param options - platform and the OS grace in seconds.
 * @returns the program, its arguments and whether the OS owns the countdown.
 */
export function powerActionPlan(options = {}) {
  const platform = PLATFORMS.includes(options.platform) ? options.platform : 'win32'
  const requested = Number(options.graceSeconds)
  const grace = Math.max(
    MIN_OS_GRACE_SECONDS,
    Math.min(MAX_OS_GRACE_SECONDS, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_OS_GRACE_SECONDS)),
  )

  if (platform === 'win32') {
    return {
      program: 'shutdown.exe',
      args: ['/s', '/t', String(grace), '/c', 'DSH idle shutdown'],
      osCounted: true,
      description: 'shutdown',
    }
  }
  if (platform === 'darwin') {
    return {
      program: 'osascript',
      args: ['-e', 'tell application "System Events" to shut down'],
      osCounted: false,
      description: 'shutdown',
    }
  }
  // Linux: systemd is the only interface that is both available and unprivileged
  // for a logged-in user (polkit asks when the seat allows it).
  return { program: 'systemctl', args: ['poweroff'], osCounted: false, description: 'shutdown' }
}


/**
 * Is this persistent window alive but unable to fire?
 *
 * A persistent row stays in the list after it fires, but a `today` row is left
 * stamped to the day it fired, a counted one can run out and a skipped one is
 * inert until its range closes. Such a row is what "re-activate" applies to.
 *
 * @param window - a normalized window.
 * @param now - the moment to judge.
 * @returns whether the row exists but can no longer fire on its own.
 */
export function windowStale(window, now = new Date()) {
  if (window?.persistent !== true) return false
  const skipped = typeof window.skipUntil === 'string' && Date.parse(window.skipUntil) > now.getTime()
  if (skipped) return true
  if (window.repeat === 'today') return window.used === true || window.date !== localDateKey(now)
  if (window.repeat === 'count') return (window.remaining ?? 0) <= 0
  return false
}

/**
 * Re-activate a persistent window that has gone inert.
 *
 * @param window - the stored window.
 * @param mode - one of REACTIVATIONS.
 * @param options - `remaining` for `count`, and the moment to stamp `today` with.
 * @returns the window to store; a re-activated row is always persistent.
 */
export function reactivateWindow(window, mode, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const next = {
    start: window.start,
    end: window.end,
    repeat: window.repeat,
    persistent: true,
  }
  if (mode === 'daily') {
    next.repeat = 'daily'
  } else if (mode === 'count') {
    next.repeat = 'count'
    const remaining = Number(options.remaining)
    next.remaining = Number.isFinite(remaining) ? Math.max(MIN_REACTIVATION_COUNT, Math.floor(remaining)) : 1
  } else {
    next.repeat = 'today'
    next.date = localDateKey(now)
    next.used = false
  }
  return next
}

/**
 * Parse `HH:MM` into minutes since local midnight.
 *
 * @param value - a time-of-day string, such as `23:00`.
 * @returns the minutes, or `null` when the text is not a valid time.
 */
export function parseTimeOfDay(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim())
  return match === null ? null : Number(match[1]) * 60 + Number(match[2])
}

/** Local calendar day of `date` as `YYYY-MM-DD`. */
export function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Normalize configured windows into the full model.
 *
 * A window carries three independent axes:
 * - its daily time range (`start`–`end`, an end before the start crosses midnight);
 * - how often it may fire (`repeat`: `daily`, `today` = only on its stamped
 *   date, `count` = at most `remaining` times);
 * - whether it survives firing (`persistent`): a temporary window is removed
 *   once it fires, a persistent one stays in the list and only becomes inert.
 *
 * `date`, `used`, `remaining` and `skipUntil` are maintained by the Host and
 * round-trip through the Settings page unchanged.
 *
 * @param raw - the config's `windows` value.
 * @param now - the moment used to stamp a new `today` window.
 * @returns normalized windows; an empty list means "all day".
 */
export function normalizeWindows(raw, now = new Date()) {
  if (!Array.isArray(raw)) return []
  const windows = []
  for (const entry of raw) {
    const start = parseTimeOfDay(entry?.start)
    const end = parseTimeOfDay(entry?.end)
    if (start === null || end === null) continue
    const repeat = REPEATS.includes(entry?.repeat) ? entry.repeat : 'daily'
    // "Every day" is inherently persistent: a daily window must keep firing on
    // later days, so a temporary flag has no meaning there and is forced on.
    const persistent =
      repeat === 'daily' ? true : typeof entry?.persistent === 'boolean' ? entry.persistent : true
    const window = {
      start: String(entry.start).trim(),
      end: String(entry.end).trim(),
      repeat,
      persistent,
      startMinutes: start,
      endMinutes: end,
    }
    if (repeat === 'count') {
      const remaining = Number(entry?.remaining)
      window.remaining = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 1
    }
    if (repeat === 'today') {
      window.date = typeof entry?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : localDateKey(now)
      window.used = entry?.used === true
    }
    if (typeof entry?.skipUntil === 'string' && !Number.isNaN(Date.parse(entry.skipUntil))) {
      window.skipUntil = new Date(entry.skipUntil).toISOString()
    }
    // A temporary window has a lifecycle: it is removed once the last
    // occurrence it may still use has ended. Recomputed from `now` every time,
    // so a restart, a clock change or a quota change all stay consistent.
    const expiresAt = computeExpiresAt(window, now)
    if (expiresAt !== null) window.expiresAt = expiresAt
    windows.push(window)
  }
  return windows
}

/**
 * When does a temporary window stop existing?
 *
 * The lifecycle starts at the first occurrence whose end is still ahead of
 * `now` (today's when its range has not closed yet, otherwise tomorrow's) and
 * spans the number of occurrences the window may still fire: `remaining` for a
 * counted window, one for `today` and for a one-shot daily window.
 *
 * Example: 09:00–10:00 with two uses, configured at 12:00, lives from tomorrow
 * 09:00 until the day after tomorrow 10:00, then disappears by itself.
 *
 * @returns the ISO instant the window expires, or `null` when persistent.
 */
export function computeExpiresAt(window, now = new Date()) {
  if (window.persistent === true) return null
  if (window.repeat === 'today' && (window.date !== localDateKey(now) || window.used === true)) {
    return now.toISOString()
  }
  const remaining = window.repeat === 'count' ? Math.max(0, window.remaining ?? 0) : 1
  if (remaining <= 0) return now.toISOString()
  const firstEnd = windowEndInstant(window, now)
  const expires = new Date(firstEnd.getTime() + (remaining - 1) * 86_400_000)
  return expires.toISOString()
}

/** Is `date`'s local time inside this window's daily range? */
function windowInside(window, date) {
  if (window.startMinutes === window.endMinutes) return true
  const minutes = date.getHours() * 60 + date.getMinutes()
  return window.startMinutes < window.endMinutes
    ? minutes >= window.startMinutes && minutes < window.endMinutes
    : minutes >= window.startMinutes || minutes < window.endMinutes
}

/**
 * May this window fire at `date`?
 *
 * @returns `true` when the window is inside its range, still has quota for the
 * day/occurrence, and was not skipped by the user.
 */
function windowEligible(window, date) {
  if (typeof window.skipUntil === 'string' && Date.parse(window.skipUntil) > date.getTime()) return false
  if (typeof window.expiresAt === 'string' && Date.parse(window.expiresAt) <= date.getTime()) return false
  if (!windowInside(window, date)) return false
  if (window.repeat === 'today') return window.date === localDateKey(date) && window.used !== true
  if (window.repeat === 'count') return (window.remaining ?? 0) > 0
  return true
}

/**
 * The window currently allowing the action, if any.
 *
 * @param windows - normalized windows.
 * @param date - the moment to test.
 * @returns the first eligible open window, or `null`.
 */
export function activeWindow(windows, date) {
  const list = Array.isArray(windows) ? windows : []
  if (list.length === 0) return null
  for (const window of list) if (windowEligible(window, date)) return window
  return null
}

/**
 * Is the action allowed now, and when does the next eligible window open?
 *
 * An empty window list allows every time.
 *
 * @param date - the moment to test (local time is used).
 * @param windows - normalized windows.
 * @returns whether the action may run now, the window that allows it, and the
 * minutes until the next eligible window opens when it may not.
 */
export function windowStateAt(date, windows) {
  const list = Array.isArray(windows) ? windows : []
  if (list.length === 0) return { inWindow: true, active: null, opensInMinutes: null }
  const active = activeWindow(list, date)
  if (active !== null) return { inWindow: true, active, opensInMinutes: null }
  const minutes = date.getHours() * 60 + date.getMinutes()
  let opensInMinutes = Number.POSITIVE_INFINITY
  for (const window of list) {
    if (window.repeat === 'today' && window.date !== localDateKey(date)) continue
    if (window.repeat === 'count' && (window.remaining ?? 0) <= 0) continue
    if (typeof window.skipUntil === 'string' && Date.parse(window.skipUntil) > date.getTime()) continue
    if (typeof window.expiresAt === 'string' && Date.parse(window.expiresAt) <= date.getTime()) continue
    const wait = window.startMinutes - minutes
    opensInMinutes = Math.min(opensInMinutes, wait < 0 ? wait + 24 * 60 : wait)
  }
  return { inWindow: false, active: null, opensInMinutes: Number.isFinite(opensInMinutes) ? opensInMinutes : null }
}

/**
 * The instant the current occurrence of a window ends.
 *
 * Used by "skip this window": the skip lasts until the range closes, so the
 * same window cannot fire again a minute later.
 */
export function windowEndInstant(window, date) {
  const end = new Date(date.getTime())
  end.setSeconds(0, 0)
  end.setHours(Math.floor(window.endMinutes / 60), window.endMinutes % 60, 0, 0)
  if (end.getTime() <= date.getTime()) end.setDate(end.getDate() + 1)
  return end
}

/**
 * Apply one firing of a window.
 *
 * A temporary window is removed. A persistent window stays in the list: a
 * counted window loses one remaining use, a `today` window is marked used, and
 * a daily window is unchanged.
 *
 * @returns the window to store (or `null` when it must be removed).
 */
export function consumeWindow(window, date) {
  if (window.persistent !== true) return null
  const next = { ...window }
  delete next.skipUntil
  if (window.repeat === 'count') next.remaining = Math.max(0, (window.remaining ?? 0) - 1)
  if (window.repeat === 'today') next.used = true
  return next
}

/** Serialize one normalized window for config/state (no parsed minutes). */
export function serializeWindow(window) {
  const out = {
    start: window.start,
    end: window.end,
    repeat: window.repeat,
    persistent: window.persistent === true,
  }
  if (window.repeat === 'count') out.remaining = window.remaining ?? 0
  if (window.repeat === 'today') {
    out.date = window.date
    out.used = window.used === true
  }
  if (typeof window.skipUntil === 'string') out.skipUntil = window.skipUntil
  if (typeof window.expiresAt === 'string') out.expiresAt = window.expiresAt
  return out
}

/**
 * Session records that describe bookkeeping rather than conversation work.
 *
 * They must not refresh the idle clock: a title or a checkpoint written while
 * the user is away would otherwise postpone the action indefinitely. Command
 * lifecycle records are excluded too, so an operator reading the countdown with
 * `/idle-shutdown status` cannot cancel it by looking.
 */
const IGNORED_EVENT_TYPES = new Set(['command/run', 'command/done', 'session/end-seed'])
const IGNORED_EVENT_PREFIXES = ['plugin:', 'session/title', 'session/checkpoint']

/** Agent status values that mean the driver is not producing anything. */
const NOT_RUNNING = 'idle'

/**
 * Should this Session event refresh the conversation's activity clock?
 *
 * @param type - the Session event type.
 * @returns `false` for bookkeeping records, `true` otherwise (unknown types
 * count as conversation activity, which is the safe direction).
 */
export function isConversationEvent(type) {
  if (typeof type !== 'string' || type.length === 0) return true
  if (IGNORED_EVENT_TYPES.has(type)) return false
  return !IGNORED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * How far the wall clock may run ahead of the monotonic clock before the two
 * are treated as a suspend/resume rather than ordinary timer lateness.
 *
 * Windows coalesces background timers by seconds, so a late timer is normal;
 * only a wall-clock advance the monotonic clock did not see proves a sleep.
 */
export const SUSPEND_DRIFT_MS = 60_000

/** Wall-clock lateness that counts as a suspend even without a drift reading. */
export const SUSPEND_LATE_MS = 120_000

/**
 * How late the commit timer may fire before the countdown is considered frozen.
 *
 * The timer is set for `deadline - grace`, so it normally fires a few seconds
 * *before* the deadline and its lateness is negative. Firing seconds after it
 * means the machine was asleep, the wall clock jumped, or this process was
 * frozen — none of which should end in the machine switching itself off.
 */
export const COMMIT_LATE_MS = 5_000

/**
 * Drift that proves a suspend even when the countdown was not late.
 *
 * Kept far above `SUSPEND_DRIFT_MS`: DSH's Host is subject to timer throttling
 * and clock corrections that have been measured at a couple of minutes here, and
 * cancelling a shutdown over that would be worse than missing a short nap.
 */
export const COMMIT_DRIFT_MS = 10 * 60_000

/**
 * Did the countdown cross a suspend, a clock jump or a frozen process?
 *
 * Used at the point of no return. Unlike the idle clock, which only loses a few
 * seconds when it is wrong, this decision must not fire on a wake-up: the user
 * would find the machine shutting down in the moment they started using it.
 *
 * @param facts - how late the commit timer fired, and how far the wall clock ran
 *   ahead of the monotonic one since the countdown was armed.
 * @returns whether the shutdown must be cancelled instead of committed.
 */
export function countdownCrossedSuspend(facts) {
  const late = Number(facts.lateMs)
  if (Number.isFinite(late) && late > COMMIT_LATE_MS) return true
  const drift = Number(facts.wallElapsed) - Number(facts.monotonicElapsed)
  return Number.isFinite(drift) && drift > COMMIT_DRIFT_MS
}

/**
 * Was the machine suspended between scheduling a timer and it firing?
 *
 * @param facts - wall-clock elapsed, monotonic elapsed, and how late the timer
 *   fired relative to its own deadline.
 * @returns whether the difference can only be explained by a suspend.
 */
export function suspendDetected(facts) {
  const wall = Number(facts.wallElapsed)
  const monotonic = Number(facts.monotonicElapsed)
  const drift = wall - monotonic
  if (Number.isFinite(drift) && drift > SUSPEND_DRIFT_MS) return true
  return Number.isFinite(Number(facts.lateMs)) && Number(facts.lateMs) > SUSPEND_LATE_MS
}

/**
 * Decide whether one open turn still counts as an active conversation.
 *
 * @param facts - the turn boundary, the Agent's last activity, and status.
 * @returns the reason it is active, or `null` when it is idle.
 */
/**
 * Grace window for one Agent.
 *
 * An Agent that is executing a step is busy by state and needs no timer; an
 * Agent whose last word was to the user waits the full configured window; any
 * other open turn only needs enough grace to bridge the gap between steps.
 *
 * @param facts - openStep, running, waitingForUser, the configured grace and
 *   the short bridge window.
 * @returns milliseconds the Agent stays busy after its last activity.
 */
export function agentGraceMs(facts) {
  const short = facts.shortGraceMs ?? 15_000
  if (facts.openStep && facts.running) return 0
  const configured = facts.graceMs ?? short
  return facts.waitingForUser ? configured : Math.min(configured, short)
}

export function classifyAgent(facts) {
  if (!facts.openTurn) return null
  // A step that is still open while the driver reports running is a model
  // request or tool call in flight; that is busy by state, not by a timer.
  if (facts.openStep && facts.running) return 'running-step'
  // Everything else is busy only while its own grace window lasts: an Agent
  // waiting on the user gets the long window, one that is merely between
  // steps gets a short one.
  const recent = facts.now - facts.lastActivityAt < facts.graceMs
  return recent ? 'recent-activity' : null
}

/**
 * Normalize one patch row's `config` into the values the engine uses.
 *
 * @param raw - the Loader's config value; may be absent or partial.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const boolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const string = (value, fallback) => (typeof value === 'string' ? value : fallback)

  return {
    enabled: boolean(source.enabled, true),
    armed: boolean(source.armed, true),
    windows:
      Array.isArray(source.windows) || source.windows === undefined
        ? normalizeWindows(source.windows ?? DEFAULT_WINDOWS).map(serializeWindow)
        : DEFAULT_WINDOWS,
    idleMinutes: Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, number(source.idleMinutes, 30))),
    warningSeconds: Math.min(MAX_WARNING_SECONDS, Math.max(0, Math.floor(number(source.warningSeconds, 60)))),
    tickSeconds: Math.max(2, Math.floor(number(source.tickSeconds, 15))),
    waitingGraceMinutes: Math.max(0, number(source.waitingGraceMinutes, 10)),
    // DSH is closed by the shutdown itself, so there is no close-first knob and\r
    // no second action to choose.\r
    action: 'shutdown',
    // The last seconds of the countdown, owned by the power command itself.
    closeLeadSeconds: Math.max(
      MIN_OS_GRACE_SECONDS,
      Math.min(MAX_OS_GRACE_SECONDS, Math.floor(number(source.closeLeadSeconds, DEFAULT_OS_GRACE_SECONDS))),
    ),
    logMaxKB: Math.max(0, Math.floor(number(source.logMaxKB, 256))),
    logMaxFiles: Math.max(0, Math.min(10, Math.floor(number(source.logMaxFiles, 3)))),
    tempMaxAgeMinutes: Math.max(5, Math.floor(number(source.tempMaxAgeMinutes, 60))),
    dryRun: boolean(source.dryRun, false),
    stateFile: string(source.stateFile, '').trim(),
  }
}

// ---------------------------------------------------------------------------
// Optional Config schema
//
// The bundle is installed as a local directory, so `@deepseek-ai/schemastery`
// is resolved from whichever `node_modules` the Host ends up linking. Validate
// the row when it is available and fall back to `resolveConfig` when it is not,
// rather than failing to activate.
// ---------------------------------------------------------------------------

let Schema = null
try {
  const module = await import('@deepseek-ai/schemastery')
  Schema = module?.default ?? module
} catch {
  Schema = null
}

/** Live Config schema, present only when schemastery resolves. */
export const Config = Schema?.object({
  enabled: Schema.boolean().default(true),
  /** The title-bar switch: on means "inside a window, go idle → act". */
  armed: Schema.boolean().default(true).volatile(),
  /** Whitelist windows; the action may only fire inside one of them. */
  windows: Schema.array(
    Schema.object({
      start: Schema.string().default('23:00'),
      end: Schema.string().default('07:00'),
      repeat: Schema.union(REPEATS).default('daily'),
      persistent: Schema.boolean().default(true),
      remaining: Schema.number().default(1),
      date: Schema.string().default(''),
      used: Schema.boolean().default(false),
      skipUntil: Schema.string().default(''),
      expiresAt: Schema.string().default(''),
    }),
  )
    .default(DEFAULT_WINDOWS)
    .volatile(),
  idleMinutes: Schema.number().min(MIN_IDLE_MINUTES).max(MAX_IDLE_MINUTES).default(30).volatile(),
  warningSeconds: Schema.number().step(1).min(0).max(MAX_WARNING_SECONDS).default(60).volatile(),
  tickSeconds: Schema.number().step(1).min(2).default(15),
  waitingGraceMinutes: Schema.number().min(0).default(10),
  action: Schema.union(ACTIONS).default('shutdown'),
  closeLeadSeconds: Schema.number().step(1).min(MIN_OS_GRACE_SECONDS).max(MAX_OS_GRACE_SECONDS).default(DEFAULT_OS_GRACE_SECONDS),
  logMaxKB: Schema.number().step(1).min(0).default(256),
  logMaxFiles: Schema.number().step(1).min(0).max(10).default(3),
  tempMaxAgeMinutes: Schema.number().step(1).min(5).default(60),
  dryRun: Schema.boolean().default(false),
  stateFile: Schema.string().default(''),
})

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/**
 * Host plugin body.
 *
 * @param ctx - the Host plugin context.
 * @param rawConfig - the entry's config, as written in `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    console.log('[idle-shutdown] disabled by config; no conversation is being monitored')
    return
  }

  /**
   * Read one config field's current value.
   *
   * A `.volatile()` field arrives as a schemastery accessor whose `.get()`
   * returns the live value after the Settings page or the title-bar switch
   * persists an edit, so the monitor never has to restart to see a change. A
   * plain value (no schema, or a non-volatile field) is used as-is.
   */
  const live = (field, fallback) => {
    const value = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig[field] : undefined
    if (value !== null && value !== undefined && typeof value.get === 'function') {
      const current = value.get()
      return current === undefined || current === null ? fallback : current
    }
    return value === undefined || value === null ? fallback : value
  }

  const currentArmed = () => live('armed', config.armed) === true
  const currentWindows = () => normalizeWindows(live('windows', config.windows))
  const currentGate = (time) => windowStateAt(new Date(time), currentWindows())
  /** Idle wait, live: the Settings page can change it without a restart. */
  const currentIdleMinutes = () =>
    Math.min(
      MAX_IDLE_MINUTES,
      Math.max(MIN_IDLE_MINUTES, Number(live('idleMinutes', config.idleMinutes)) || config.idleMinutes),
    )
  /** Countdown length, live for the same reason. */
  const currentWarningSeconds = () =>
    Math.min(
      MAX_WARNING_SECONDS,
      Math.max(0, Math.floor(Number(live('warningSeconds', config.warningSeconds)) || 0)),
    )

  const idleMs = currentIdleMinutes() * 60_000
  const graceMs = Math.min(config.waitingGraceMinutes * 60_000, idleMs)
  // An open turn that is not executing anything only needs enough grace to
  // bridge the gap between two steps; the long waitingGrace is reserved for
  // an Agent whose last word was to the user.
  const SHORT_GRACE_MS = 15_000

  /** @type {Map<string, number>} */
  const sessionActivity = new Map()
  /** Last committed event type per Agent, for its grace rule. */
  const lastEventType = new Map()
  /** @type {Map<string, string>} */
  const agentStatus = new Map()
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set()

  let disposed = false
  let pending = null

  const state = {
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    busyReasons: [],
    agents: [],
    armed: config.armed,
    monitoring: false,
    lastMonitoring: null,
    windows: config.windows,
    inWindow: true,
    opensInMinutes: null,
    triggerCount: 0,
    lastTrigger: null,
    lastCancel: null,
    lastConsume: null,
    lastSkip: null,
    lastReactivate: null,
    lastAbort: null,
    lastExpire: null,
    lastError: null,
    lastAction: null,
    commandRegistered: null,
    /** Cheap counters for comparing cost before/after a change. */
    stats: { ticks: 0, writes: 0, serviceCalls: 0, reconciles: 0, reconcileProbes: 0, reconcileExits: 0, fastPathSkips: 0 },
  }

  const log = (message) => {
    console.log(`[idle-shutdown] ${message}`)
  }
  const warn = (message) => {
    console.warn(`[idle-shutdown] ${message}`)
  }

  /**
   * Delete any wake-guard files left by an earlier run.
   *
   * The guard is one-shot by construction — the request lives in a helper
   * process, so it ends with that process and cannot survive a reboot — and the
   * files it needs are rewritten for every hand-over. Clearing them at startup
   * keeps a dead guard from looking like a live one.
   */
  const forgetWakeGuard = () => {
    for (const name of [KEEP_AWAKE_SCRIPT, KEEP_AWAKE_WRAPPER, KEEP_AWAKE_MARKER]) {
      try {
        unlinkSync(join(ownedDir(), name))
      } catch {
        // Not there is the usual case.
      }
    }
  }
  forgetWakeGuard()

  // -- small utilities ------------------------------------------------------

  const later = (callback, delay) => {
    const handle = setTimeout(() => {
      timers.delete(handle)
      if (!disposed) callback()
    }, Math.max(0, delay))
    timers.add(handle)
    return handle
  }

  const clearTimer = (handle) => {
    if (handle === undefined || handle === null) return
    if (timers.delete(handle)) clearTimeout(handle)
  }

  /** Look up an optional service without throwing when it is not composed. */
  const service = (serviceName) => {
    try {
      return ctx.get?.(serviceName)
    } catch {
      return undefined
    }
  }

  const iso = (time) => new Date(time).toISOString()

  /**
   * Milliseconds from a clock that never jumps.
   *
   * `hrtime` keeps counting while the process runs and does not follow wall
   * clock changes or suspend, which is exactly what the wake detection needs to
   * compare against `Date.now()`.
   */
  const monotonicNow = () => {
    if (typeof process.hrtime?.bigint === 'function') return Number(process.hrtime.bigint() / 1_000_000n)
    if (typeof performance?.now === 'function') return performance.now()
    return Date.now()
  }

  // -- activity tracking ----------------------------------------------------

  const noteActivity = (sessionId) => {
    if (disposed) return
    const time = Date.now()
    state.lastActivityAt = time
    if (sessionId !== undefined) {
      sessionActivity.set(String(sessionId), time)
      // Show "busy" right away instead of waiting for the next evaluation;
      // the deep pass overwrites this list with the authoritative reasons.
      const marker = `recent-activity:${sessionId}`
      if (!state.busyReasons.includes(marker)) state.busyReasons = [...state.busyReasons, marker]
    }
    // Any real conversation work cancels a countdown that is still running.
    if (pending !== null) cancelPending('conversation activity')
    else {
      flushSoon()
      reschedule()
    }
  }

  /**
   * Session/Agent listeners used by the monitor.
   *
   * They are installed only while the switch is on: a disarmed monitor does no
   * bookkeeping at all, so a Host with the feature turned off pays nothing per
   * conversation event.
   *
   * Besides activity, the listeners keep the turn/step state and the running-job
   * set current, which is what lets an evaluation run without querying a
   * service for every live Agent.
   */
  let eventDisposers = []
  const bindEvents = () => {
    if (eventDisposers.length > 0) return
    eventDisposers = [
      ctx.on('session/event', (session, event) => {
        const id = session?.id
        if (id === undefined) return
        const key = String(id)
        const type = event?.type
        if (type === 'turn/start') turnOpen.set(key, true)
        else if (type === 'turn/end') turnOpen.set(key, false)
        else if (type === 'step/start') stepOpen.set(key, true)
        else if (type === 'step/end') stepOpen.set(key, false)
        if (!isConversationEvent(type)) return
        noteActivity(id)
      }),
      ctx.on('agent/created', (payload) => {
        agentStatus.delete(String(payload?.agent?.id))
        noteActivity(payload?.agent?.id)
      }),
      ctx.on('agent/disposed', (payload) => {
        const key = String(payload?.agent?.id)
        agentStatus.delete(key)
        turnOpen.delete(key)
        stepOpen.delete(key)
        sessionActivity.delete(key)
        lastEventType.delete(key)
        lastSeq.delete(key)
        lastTurnSeen.delete(key)
        noteActivity()
      }),
      ctx.on('agent/status', (payload) => {
        const id = payload?.agent?.id
        if (id === undefined) return
        agentStatus.set(String(id), payload.status)
        if (payload.status !== NOT_RUNNING) noteActivity(id)
      }),
      ctx.on('agent/inbox/inserted', (payload) => noteActivity(payload?.agent?.id)),
      subscribeJobEvents(),
    ]
  }

  const unbindEvents = () => {
    for (const dispose of eventDisposers) {
      try {
        dispose?.()
      } catch {
        // A listener removed with its context is already gone.
      }
    }
    eventDisposers = []
  }

  // -- busy evaluation ------------------------------------------------------

  // Turn, step and job state maintained from events; the frequent evaluations
  // read these maps instead of asking the services, and a reconcile refreshes
  // them authoritatively at every decision point.
  const turnOpen = new Map()
  const stepOpen = new Map()
  const runningJobs = new Map()
  const lastTurnSeen = new Map()
  /** Last seen Session log offset per Agent; an unchanged offset cannot change turn state. */
  const lastSeq = new Map()
  let jobEventsLive = false

  /** Subscribe to job lifecycle events; falls back to querying when absent. */
  const subscribeJobEvents = () => {
    const events = service('jobs')?.events
    if (events === undefined || typeof events.subscribe !== 'function') return () => {}
    try {
      const dispose = events.subscribe({ owners: 'all' }, (event) => {
        const jobId = String(event?.job?.id ?? event?.id ?? '')
        if (jobId === '') return
        if (event?.type === 'registered') runningJobs.set(jobId, String(event?.job?.owner ?? ''))
        else if (event?.type === 'settled' || event?.type === 'removed') runningJobs.delete(jobId)
        jobEventsLive = true
      })
      jobEventsLive = true
      return dispose
    } catch {
      jobEventsLive = false
      return () => {}
    }
  }

  /** Seed the running-job set once; events keep it current afterwards. */
  const jobSeed = () => {
    const jobsService = service('jobs')
    if (typeof jobsService?.list !== 'function') return
    let agents = []
    try {
      agents = service('agents')?.list?.() ?? []
    } catch {
      agents = []
    }
    state.stats.serviceCalls += 1
    for (const agent of agents) {
      const id = String(agent.id)
      try {
        for (const view of jobsService.list(agent.id) ?? []) {
          if (view?.status === 'running' || view?.status === 'stopping') runningJobs.set(String(view.id), id)
        }
      } catch {
        // A refused read only means this caller cannot see that owner.
      }
    }
    try {
      for (const view of jobsService.list() ?? []) {
        if (view?.status === 'running' || view?.status === 'stopping') runningJobs.set(String(view.id), '')
      }
    } catch {
      // Same as above.
    }
  }

  /**
   * Authoritative refresh of turn/step/job state.
   *
   * Two cheap shortcuts keep this off the hot path:
   * - a Session whose log offset (`session.seq`) has not moved since the last
   *   read cannot have changed its turn or step state, so `turnBoundaryOf` is
   *   skipped for it;
   * - agents are visited parents-first (a subagent is spawned from a tool call
   *   inside its parent's open step), and the walk stops at the first parent
   *   that is definitely busy: that parent already blocks the action, and its
   *   whole subtree is covered by its own open step.
   *
   * @param options.stopOnBusy - stop at the first busy parent session.
   */
  const reconcileTree = (options = {}) => {
    const agentsService = service('agents')
    const sessionsService = service('sessions')
    let agents = []
    try {
      agents = agentsService?.list?.() ?? []
    } catch {
      agents = []
    }
    state.stats.serviceCalls += 1
    state.stats.reconciles += 1
    if (!jobEventsLive) jobSeed()

    const queue = []
    for (const agent of agents) {
      const id = String(agent.id)
      let session
      try {
        session = sessionsService?.get?.(agent.id)
      } catch {
        session = undefined
      }
      const depth = typeof session?.header?.delegationDepth === 'number' ? session.header.delegationDepth : 0
      queue.push({ id, session, depth })
    }
    // Parents before their subagents.
    queue.sort((a, b) => a.depth - b.depth)

    /** Is this Agent tracked as busy right now? */
    const trackedBusy = (id) =>
      turnOpen.get(id) === true && (stepOpen.get(id) === true || (agentStatus.get(id) ?? NOT_RUNNING) !== NOT_RUNNING)

    for (const entry of queue) {
      const { id, session } = entry
      if (session === undefined) continue
      const seq = Number(session.seq)
      const unchanged = Number.isFinite(seq) && lastSeq.get(id) === seq
      // A busy parent whose log has not moved still covers its subtree, and
      // its tracked state cannot have changed without an event we received.
      if (options.stopOnBusy !== false && entry.depth === 0 && trackedBusy(id)) {
        if (unchanged) state.stats.reconcileExits += 1
        if (unchanged) break
      }
      if (unchanged) continue
      state.stats.reconcileProbes += 1
      state.stats.serviceCalls += 1
      let turn = null
      try {
        turn = agentsService?.turnBoundaryOf?.(session) ?? null
      } catch {
        turn = null
      }
      turnOpen.set(id, turn?.openTurnStartSeq !== null && turn?.openTurnStartSeq !== undefined)
      stepOpen.set(id, turn?.lastStepBoundary?.kind === 'start')
      if (turn?.lastTurn !== undefined && turn?.lastTurn !== null) lastTurnSeen.set(id, turn.lastTurn)
      if (Number.isFinite(seq)) lastSeq.set(id, seq)
      if (options.stopOnBusy !== false && entry.depth === 0 && trackedBusy(id)) {
        state.stats.reconcileExits += 1
        break
      }
    }
  }

  /**
   * Pending input queued in an Agent's inbox.
   *
   * The desktop shell's own quit inspection counts `agent.inbox.nextTurn` and
   * `agent.inbox.nextStep` as work that a quit would interrupt, because queued
   * input has not produced any event yet. The same holds here: an Agent whose
   * input waits for the next turn or the next step is not idle yet.
   *
   * @param agent - one live Agent.
   * @returns the number of queued inputs, or 0 when the shape is unknown.
   */
  const pendingInputCount = (agent) => {
    try {
      const inbox = agent?.inbox
      if (inbox === undefined || inbox === null) return 0
      const turns = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0
      const steps = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0
      return turns + steps
    } catch {
      return 0
    }
  }

  /**
   * Armed scheduled reminders of the loaded sessions.
   *
   * The desktop shell's quit inspection treats a `schedule` reminder as work
   * that a quit would interrupt, which is right for a confirmation dialog but
   * wrong for an automatic shutdown: a reminder stays armed long after the AI
   * finished its work, so treating it as busy would keep the machine on all
   * night. It is therefore recorded, never a gate.
   *
   * @returns the reminders found, per session.
   */
  const collectScheduledReminders = async () => {
    const agentsService = service('agents')
    if (agentsService === undefined || typeof ctx.waterfall !== 'function') return null
    let agents = []
    try {
      agents = agentsService.list() ?? []
    } catch {
      return null
    }
    const found = []
    for (const agent of agents) {
      try {
        const entries = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => [])
        const schedules = (entries ?? []).filter((entry) => entry?.kind === 'schedule')
        if (schedules.length > 0) {
          found.push({
            session: String(agent.id),
            count: schedules.length,
            items: schedules.flatMap((entry) => (entry.items ?? []).map((item) => item?.label ?? item?.id ?? '')),
          })
        }
      } catch {
        // A session that cannot answer simply has no reminder to report.
      }
    }
    return found
  }

  /**
   * Do the committed events alone already prove the tree is idle?
   *
   * Every Session commit reaches this Host as an event, and the listeners keep
   * per-Agent recency, turn/step flags, status and the running-job set current.
   * When none of them shows work, an authoritative scan has nothing to find —
   * the same evidence the Session list's "1 hour / 3 days" labels are made of.
   * The slow safety evaluation and the commit always scan anyway.
   */
  const eventsProveIdle = (time) => {
    if (pending !== null) return false
    if (runningJobs.size > 0) return false
    const fresh = Math.min(graceMs, SHORT_GRACE_MS)
    for (const at of sessionActivity.values()) if (time - at < fresh) return false
    for (const value of turnOpen.values()) if (value === true) return false
    for (const value of stepOpen.values()) if (value === true) return false
    for (const status of agentStatus.values()) if (status !== NOT_RUNNING) return false
    return true
  }

  /**
   * Collect the conversation tree's facts.
   *
   * The frequent pass reads only maps maintained by events (plus the Agent
   * list), so it costs one call; the deep pass adds terminal activity and the
   * running-job count, and always reconciles first so the decision is made on
   * authoritative state.
   *
   * @param options.deep - include jobs and terminal activity (default true).
   * @param options.reconcile - force an authoritative refresh (safety tick).
   * @returns the reasons plus per-Agent rows for the status file.
   */
  const collectBusy = (options = {}) => {
    const deep = options.deep !== false
    const time = Date.now()
    const force = options.force === true || options.reconcile === true
    const reconcileNow = force || !eventsProveIdle(time)
    const reasons = []
    const rows = []
    const agentsService = service('agents')
    const terminalsService = deep ? service('terminals') : undefined
    state.stats.serviceCalls += 1

    let agents = []
    try {
      agents = agentsService?.list?.() ?? []
    } catch {
      agents = []
    }

    if (reconcileNow) reconcileTree({ stopOnBusy: !force })
    else state.stats.fastPathSkips += 1

    const jobsByOwner = new Map()
    if (deep) {
      for (const [, owner] of runningJobs) jobsByOwner.set(owner, (jobsByOwner.get(owner) ?? 0) + 1)
    }

    for (const agent of agents) {
      const id = String(agent.id)
      const openTurn = turnOpen.get(id) === true
      const openStep = stepOpen.get(id) === true
      const status = agentStatus.get(id)
      // An Agent that predates this plugin has no status event yet; trust the
      // open step rather than assuming it is idle.
      const running = status === undefined ? openStep : status !== NOT_RUNNING
      const lastActivityAt = sessionActivity.get(id) ?? state.startedAt
      const waitingForUser = lastEventType.get(id) === 'assistant/message'
      const agentGrace = agentGraceMs({ openStep, running, waitingForUser, graceMs, shortGraceMs: SHORT_GRACE_MS })
      const reason = classifyAgent({ now: time, graceMs: agentGrace, lastActivityAt, openTurn, openStep, running })

      const jobs = deep ? (jobsByOwner.get(id) ?? 0) : 0
      if (jobs > 0) reasons.push(`job:${id}`)

      // Queued input has produced no event yet, so the event stream cannot see
      // it: the Agent is not idle while its input waits.
      const pendingInput = pendingInputCount(agent)
      if (pendingInput > 0) reasons.push(`pending-input:${id}`)

      let terminal = false
      if (deep) {
        state.stats.serviceCalls += 1
        try {
          terminal = terminalsService?.hasOwnerActivity?.(agent) === true
        } catch {
          terminal = false
        }
        if (terminal) reasons.push(`terminal:${id}`)
      }

      if (reason !== null) reasons.push(`${reason}:${id}`)

      rows.push({
        id,
        turn: lastTurnSeen.get(id) ?? null,
        openTurn,
        openStep,
        running,
        idleSeconds: Math.max(0, Math.round((time - lastActivityAt) / 1000)),
        graceSeconds: Math.round(agentGrace / 1000),
        jobs,
        pendingInput,
        terminal,
        active: reason !== null || jobs > 0 || terminal || pendingInput > 0,
      })
    }

    // Jobs that no Agent owns still mean work in flight.
    if (deep) {
      const unowned = jobsByOwner.get('') ?? 0
      if (unowned > 0) reasons.push(`job:unowned:${unowned}`)
    }

    return { reasons, rows, time, deep }
  }

  // -- status file ----------------------------------------------------------

  // The status file and the durable log are diagnostics, not state: everything
  // the engine must remember lives in the row's config. They therefore belong
  // next to the code that writes them — removing the bundle removes them with it
  // — and a linked (checkout) installation is kept clean by a `.gitignore` the
  // plugin writes into that directory. Only a read-only package directory falls
  // back to the system temp directory.

  const DATA_DIRECTORY = '.dsh-idle-shutdown'

  const dataDirectory = (() => {
    let resolved = null
    return () => {
      if (resolved !== null) return resolved
      const explicit = config.stateFile
      if (explicit) {
        resolved = dirname(explicit)
        return resolved
      }
      const inside = join(dirname(fileURLToPath(import.meta.url)), DATA_DIRECTORY)
      try {
        mkdirSync(inside, { recursive: true })
        const probe = join(inside, `.probe-${process.pid}`)
        writeFileSync(probe, '')
        unlinkSync(probe)
        const ignore = join(inside, '.gitignore')
        if (!existsSync(ignore)) writeFileSync(ignore, '# written by dsh-idle-shutdown\n*\n')
        resolved = inside
      } catch {
        // A read-only package directory (a system-wide installation): the temp
        // directory is the only place left.
        resolved = tmpdir()
      }
      return resolved
    }
  })()

  const stateFile = () => config.stateFile || join(dataDirectory(), 'dsh-idle-shutdown-state.json')

  /** Durable, append-only log beside the status file; survives a crash. */
  const logFile = () => join(dirname(stateFile()), 'dsh-idle-shutdown.log')

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * Retention for the files this plugin owns.
   *
   * Everything lives in one directory, and only a bounded part of it may stay:
   * the status file (rewritten in place), the durable log with up to
   * `logMaxFiles` rotated generations of at most `logMaxKB`, and no atomic-write
   * leftover older than `tempMaxAgeMinutes`. The oldest files go first, and only
   * names this plugin created are ever touched.
   */
  const ownedDir = () => dirname(stateFile())
  const stateName = () => basename(stateFile())
  const logName = () => basename(logFile())

  const listOwned = () => {
    try {
      return readdirSync(ownedDir())
    } catch {
      return []
    }
  }

  /** Rotated log generations of this plugin, ascending by index. */
  const logGenerations = (files) => {
    const pattern = new RegExp(`^${escapeRegExp(logName())}\\.(\\d+)$`)
    return files
      .map((name) => {
        const match = pattern.exec(name)
        return match === null ? null : { name, index: Number(match[1]) }
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.index - b.index)
  }

  /**
   * Delete what the retention policy no longer allows.
   *
   * @returns the removed names, for the status file and the durable log.
   */
  const pruneFiles = () => {
    const dir = ownedDir()
    const files = listOwned()
    const removed = []
    const now = Date.now()
    const temporary = new RegExp(`^${escapeRegExp(stateName())}\\.\\d+\\.tmp$`)
    for (const name of files) {
      if (!temporary.test(name)) continue
      try {
        if (now - statSync(join(dir, name)).mtimeMs > config.tempMaxAgeMinutes * 60_000) {
          unlinkSync(join(dir, name))
          removed.push(name)
        }
      } catch {
        // A file removed by someone else is already gone.
      }
    }
    for (const entry of logGenerations(files)) {
      if (entry.index <= config.logMaxFiles) continue
      try {
        unlinkSync(join(dir, entry.name))
        removed.push(entry.name)
      } catch {
        // Same as above.
      }
    }
    state.lastCleanup = {
      at: iso(now),
      removed,
      limits: {
        logMaxKB: config.logMaxKB,
        logMaxFiles: config.logMaxFiles,
        tempMaxAgeMinutes: config.tempMaxAgeMinutes,
      },
    }
    return removed
  }

  /** Drop the oldest log generation and shift the rest one step. */
  const rotateLog = () => {
    const file = logFile()
    const max = config.logMaxFiles
    if (max <= 0) {
      try {
        writeFileSync(file, '', 'utf8')
      } catch {
        // Rotation is best effort.
      }
      return
    }
    for (let index = max; index >= 1; index -= 1) {
      const target = `${file}.${index}`
      const source = index === 1 ? file : `${file}.${index - 1}`
      try {
        if (!existsSync(source)) continue
        if (existsSync(target)) unlinkSync(target)
        renameSync(source, target)
      } catch {
        // A failed rotation must not stop the log.
      }
    }
  }

  /** Bytes, generations and limits of the files this plugin owns. */
  const fileInventory = () => {
    const dir = ownedDir()
    const sizeOf = (name) => {
      try {
        return statSync(join(dir, name)).size
      } catch {
        return 0
      }
    }
    return {
      dir,
      stateBytes: sizeOf(stateName()),
      logBytes: sizeOf(logName()),
      logGenerations: logGenerations(listOwned()).map((entry) => ({ name: entry.name, bytes: sizeOf(entry.name) })),
      limits: {
        logMaxKB: config.logMaxKB,
        logMaxFiles: config.logMaxFiles,
        tempMaxAgeMinutes: config.tempMaxAgeMinutes,
      },
    }
  }

  /** Throttle for the size check, so a chatty log does not stat per line. */
  let logCheckedAt = 0
  let logLinesSinceCheck = 0

  /** Append one line to the durable log; never throws into the monitor. */
  const logLine = (message) => {
    try {
      mkdirSync(ownedDir(), { recursive: true })
      const now = Date.now()
      logLinesSinceCheck += 1
      if (config.logMaxKB > 0 && (now - logCheckedAt > 2000 || logLinesSinceCheck >= 32)) {
        logCheckedAt = now
        logLinesSinceCheck = 0
        try {
          if (statSync(logFile()).size > config.logMaxKB * 1024) rotateLog()
        } catch {
          // A missing log is the normal first write.
        }
      }
      appendFileSync(logFile(), `${iso(now)} ${message}\n`, 'utf8')
    } catch {
      // Logging is diagnostic only.
    }
  }

  /** This plugin's version, read once so the status file can be matched to it. */
  const pluginVersion = (() => {
    try {
      const manifest = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
      return JSON.parse(manifest).version ?? null
    } catch {
      return null
    }
  })()


  /**
   * Every file this plugin creates outside its own package.
   *
   * @returns the absolute paths, including the rotated log generations and the
   *   wake-guard files.
   */
  const ownedPaths = () => {
    const files = [stateFile(), logFile()]
    for (let generation = 1; generation <= config.logMaxFiles; generation += 1) {
      files.push(`${logFile()}.${generation}`)
    }
    for (const name of [KEEP_AWAKE_SCRIPT, KEEP_AWAKE_WRAPPER, KEEP_AWAKE_MARKER]) {
      files.push(join(ownedDir(), name))
    }
    return files
  }



  /**
   * Move the files an older version left in the temp directory into the package
   * directory, so upgrading does not strand them.
   *
   * Both are diagnostics, and a newer copy always wins: the package directory is
   * where the next write goes.
   */
  const adoptLegacyFiles = () => {
    const legacy = tmpdir()
    const target = ownedDir()
    if (target === legacy) return
    const names = [stateName(), logName()]
    for (let generation = 1; generation <= config.logMaxFiles; generation += 1) {
      names.push(`${logName()}.${generation}`)
    }
    names.push(KEEP_AWAKE_SCRIPT, KEEP_AWAKE_WRAPPER, KEEP_AWAKE_MARKER)
    const moved = []
    for (const name of names) {
      try {
        const from = join(legacy, name)
        if (!existsSync(from)) continue
        const to = join(target, name)
        if (existsSync(to)) unlinkSync(from)
        else {
          renameSync(from, to)
          moved.push(name)
        }
      } catch {
        // Held by another instance: it will adopt its own files later.
      }
    }
    if (moved.length > 0) log(`adopted ${moved.join(', ')} from the temp directory`)
  }


  /**
   * Remove the files when they had to fall back to the temp directory.
   *
   * Inside the package directory they leave with the package, so an uninstall
   * cleans them without running any code. Only a read-only package directory
   * needs this, and nothing is lost there: the status snapshot is rebuilt from
   * the config, and the log is a diagnostic.
   */
  const removeFallbackFiles = () => {
    if (ownedDir() !== tmpdir()) return
    for (const path of ownedPaths()) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        // Held by another instance; it cleans up on its own unload.
      }
    }
  }

  /**
   * Build the snapshot the status file and the browser both read.
   *
   * @param extra - fields layered on top for one write.
   * @returns a plain JSON-safe object.
   */
  const buildSnapshot = (extra) => {
    const now = Date.now()
    const armed = currentArmed()
    const windows = currentWindows()
    const gate = windowStateAt(new Date(now), windows)
    // Optimistic "recent activity" markers are only trusted while the grace
    // window lasts; the deep pass replaces the whole list on its next run.
    const liveReasons = state.busyReasons.filter((reason) => {
      const match = /^recent-activity:(.*)$/.exec(reason)
      if (match === null) return true
      const at = sessionActivity.get(match[1])
      return at !== undefined && now - at < graceMs
    })
    return {
      updatedAt: iso(now),
      version: pluginVersion,

      pid: process.pid,
      profile: process.env.DSH_PROFILE ?? null,
      runtime: {
        ppid: process.ppid,
        execPath: process.execPath,
        platform: process.platform,
      },
      config: {
        enabled: config.enabled,
        action: config.action,
        idleMinutes: currentIdleMinutes(),
        warningSeconds: currentWarningSeconds(),
        // The last seconds come from the OS command itself; the UI shows them so
        // "no undo any more" is a stated boundary rather than a surprise.
        closeLeadSeconds: osGraceSeconds(),
        osOwnsCountdown: osOwnsCountdown(),
        waitingGraceMinutes: config.waitingGraceMinutes,
        dryRun: config.dryRun,
      },
      armed,
      monitoring: state.monitoring,
      lastMonitoring: state.lastMonitoring ?? null,
      windows: windows.map(serializeWindow),
      inWindow: gate.inWindow,
      opensInMinutes: gate.opensInMinutes,
      idleSeconds: Math.max(0, Math.round((now - state.lastActivityAt) / 1000)),
      lastActivityAt: iso(state.lastActivityAt),
      active: state.busyReasons.length > 0,
      activeReasons: liveReasons,
      pendingInput: state.pendingInput ?? 0,
      agents: state.agents.filter((row) => row.active === true),
      agentCount: state.agents.length,
      activeCount: state.agents.filter((row) => row.active === true).length,
      stats: { ...state.stats },
      pending:
        pending === null
          ? null
          : {
              action: pending.action,
              phase: pending.phase,
              window: pending.window,
              dueAt: iso(pending.dueAt),
              remainingSeconds: Math.max(0, Math.round((pending.dueAt - now) / 1000)),
              graceSeconds: pending.graceSeconds ?? osGraceSeconds(),
              // How long the undo button still does something: the countdown
              // ends its cancellable part when the OS takes over.
              cancelSeconds: Math.max(0, Math.round((pending.dueAt - (pending.graceSeconds ?? 0) * 1000 - now) / 1000)),
              canCancel: pending.phase === 'countdown',
            },
      triggerCount: state.triggerCount,
      saveCount: state.saveCount ?? 0,
      lastSave: state.lastSave ?? null,
      command: state.commandRegistered,
      services: {
        agents: service('agents') !== undefined,
        sessions: service('sessions') !== undefined,
        jobs: service('jobs') !== undefined,
        terminals: service('terminals') !== undefined,
        commands: service('commands') !== undefined,
        webServer: service('webServer') !== undefined,
        configEditor: service('configEditor') !== undefined,
      },
      route: state.routeRegistered === true,
      logFile: logFile(),
      lastTrigger: state.lastTrigger,
      lastCancel: state.lastCancel,
      lastConsume: state.lastConsume,
      lastSkip: state.lastSkip,
      lastReactivate: state.lastReactivate ?? null,
      lastAbort: state.lastAbort ?? null,
      lastExpire: state.lastExpire,
      lastDebug: state.lastDebug ?? null,
      lastCleanup: state.lastCleanup ?? null,
      lastReminders: state.lastReminders ?? null,
      lastAction: state.lastAction,
      lastError: state.lastError,
      ...extra,
    }
  }

  /** Fields whose change is worth a disk write. */
  const signatureOf = (payload) =>
    [
      payload.armed,
      payload.monitoring,
      payload.inWindow,
      payload.opensInMinutes,
      (payload.activeReasons ?? []).join('|'),
      payload.pending ? `${payload.pending.phase}@${payload.pending.dueAt}` : 'none',
      JSON.stringify(payload.windows ?? []),
      payload.triggerCount,
      payload.saveCount,
      payload.activeCount,
      payload.agentCount,
      payload.lastCancel?.at,
      payload.lastConsume?.at,
      payload.lastSkip?.at,
      payload.lastReactivate?.at,
      payload.lastAbort?.at,
      payload.lastExpire?.at,
      payload.lastAction?.at,
      payload.lastError,
      payload.config?.idleMinutes,
      payload.config?.warningSeconds,
      payload.config?.dryRun,
      payload.lastDebug?.at,
      payload.route,
    ].join('#')

  let lastSignature = null
  let lastWrittenAt = 0

  /**
   * Write the status file, but only when something meaningful changed.
   *
   * The monitor runs every tick; rewriting a few kilobytes four times a minute
   * for a file nobody reads most of the time is pure waste. Callers that just
   * changed state pass `true` to force the write.
   *
   * @param extra - fields layered on top for this write.
   * @param force - write even when the signature is unchanged.
   */
  const writeState = (extra, force = false) => {
    // The status file also reports what the retention policy currently holds,
    // so its size and generations can be checked without extra tooling.
    const payload = buildSnapshot({ files: fileInventory(), ...extra })
    const signature = signatureOf(payload)
    const now = Date.now()
    const stale = now - lastWrittenAt >= 60_000
    if (!force && signature === lastSignature && !stale) return
    const file = stateFile()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
      lastSignature = signature
      lastWrittenAt = now
      state.stats.writes += 1
      bumpRevision('runtime')
    } catch (error) {
      // The status file is diagnostic only; never let it break the monitor.
      if (state.lastError === null) {
        state.lastError = `state file: ${error instanceof Error ? error.message : String(error)}`
        warn(state.lastError)
      }
    }
  }

  // -- power actions --------------------------------------------------------

  const runAwaited = (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
        if (error) {
          state.lastError = `${command}: ${error.message}${stderr ? ` ${String(stderr).trim()}` : ''}`
          warn(state.lastError)
          resolve({ ok: false, stdout: String(stdout ?? '') })
          return
        }
        resolve({ ok: true, stdout: String(stdout ?? '') })
      })
    })

  /** The last seconds of the countdown: live, clamped, never below one. */
  const osGraceSeconds = () => {
    const requested = Number(live('closeLeadSeconds', config.closeLeadSeconds))
    return Math.max(
      MIN_OS_GRACE_SECONDS,
      Math.min(MAX_OS_GRACE_SECONDS, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_OS_GRACE_SECONDS)),
    )
  }

  /** Does the power command keep its own deadline after DSH is closed? */
  const osOwnsCountdown = () => process.platform === 'win32'

  /**
   * Write the Windows wake guard beside the status file.
   *
   * Rewritten for every hand-over: the wrapper embeds absolute paths and the
   * hold duration, and the directory moves when `stateFile` is configured.
   *
   * @param holdSeconds - how long the request must be held.
   * @returns the paths and the wrapper's bare name.
   */
  const writeKeepAwakeFiles = (holdSeconds) => {
    const dir = ownedDir()
    mkdirSync(dir, { recursive: true })
    const script = join(dir, KEEP_AWAKE_SCRIPT)
    const wrapper = join(dir, KEEP_AWAKE_WRAPPER)
    const marker = join(dir, KEEP_AWAKE_MARKER)
    writeFileSync(script, keepAwakeScript(), 'utf8')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const lines = [
      '@echo off',
      `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}" ` +
        `-Seconds ${Math.max(1, Math.floor(holdSeconds))} -Marker "${marker}"`,
    ]
    writeFileSync(wrapper, `${lines.join('\r\n')}\r\n`, 'utf8')
    return { dir, script, wrapper, wrapperName: KEEP_AWAKE_WRAPPER, marker }
  }

  /** Wait until a file appears, or the timeout expires. */
  const waitForFile = async (path, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(path)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return existsSync(path)
  }

  /**
   * Ask the OS to stay out of sleep until the power command has landed.
   *
   * This is the guarantee that makes a short OS-owned grace safe: even if this
   * process stops right after issuing the command, the machine cannot slip into
   * sleep and wake up hours later to an already-expired deadline.
   *
   * Windows holds the request in a helper process. A plain child would be taken
   * down with DSH by Chromium's job object — in the very second the request is
   * needed — so it is created through WMI instead, and a detached child is only
   * the fallback. macOS and Linux hold theirs in `caffeinate` / `systemd-inhibit`.
   *
   * @param seconds - how long the machine must stay awake.
   * @returns how the request was made, or `null` when no guard could be armed.
   */
  const holdSystemAwake = async (seconds) => {
    const hold = Math.max(MIN_OS_GRACE_SECONDS, Math.ceil(seconds))
    if (process.platform !== 'win32') {
      const plan = keepAwakePlan(process.platform, hold)
      try {
        const child = spawn(plan.program, plan.args, { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return { how: plan.program, confirmed: true }
      } catch (error) {
        state.lastError = `wake guard: ${error instanceof Error ? error.message : String(error)}`
        warn(state.lastError)
        return null
      }
    }
    const files = writeKeepAwakeFiles(hold)
    try {
      unlinkSync(files.marker)
    } catch {
      // No marker from an earlier hand-over is the normal case.
    }
    const plan = keepAwakePlan('win32', hold, {
      directory: files.dir,
      script: files.script,
      wrapper: files.wrapperName,
      marker: files.marker,
    })
    let how = null
    const launcher = keepAwakeLauncher(files.wrapperName, files.dir)
    const viaWmi = await runAwaited('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher])
    if (viaWmi.ok && viaWmi.stdout.trim() === '0') how = 'wmi'
    if (how === null) {
      try {
        const child = spawn(plan.program, plan.args, { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        how = 'detached'
      } catch (error) {
        state.lastError = `wake guard: ${error instanceof Error ? error.message : String(error)}`
        warn(state.lastError)
        return null
      }
    }
    const confirmed = await waitForFile(files.marker, KEEP_AWAKE_LEAD_MS + 2_000)
    if (!confirmed) warn('the wake guard did not confirm its power request in time')
    return { how, confirmed }
  }

  /**
   * Issue the power command of this platform.
   *
   * On Windows, `shutdown /s /t <grace>` is owned by the OS: it survives this
   * process, the app closing, and our own death — the one guarantee a detached
   * child does not have. macOS and Linux run the command directly.
   *
   * @param graceSeconds - the OS-owned part of the countdown.
   * @returns whether the platform accepted the command.
   */
  const runPowerAction = async (graceSeconds) => {
    const plan = powerActionPlan({ platform: process.platform, graceSeconds })
    logLine(`power command: ${plan.program} ${plan.args.join(' ')}`)
    const result = await runAwaited(plan.program, plan.args)
    logLine(`power command ok=${result.ok} (${plan.description})`)
    if (!result.ok) warn(`${plan.description} was refused by the system`)
    return { ok: result.ok, plan }
  }

  /** Find the same window in the live list, by identity of its defining fields. */
  const findWindowIndex = (windows, target) =>
    windows.findIndex(
      (window) =>
        window.start === target.start &&
        window.end === target.end &&
        window.repeat === target.repeat &&
        (window.date ?? null) === (target.date ?? null),
    )

  /**
   * Record that a window fired.
   *
   * A temporary window is removed; a persistent one stays and only loses quota
   * (count) or is marked used (today). Written through the config editor, so
   * the Settings page and the next start agree with what happened.
   */
  const consumeFiredWindow = async (target) => {
    if (target === null) return
    const windows = currentWindows()
    const index = findWindowIndex(windows, target)
    if (index < 0) return
    const consumed = consumeWindow(windows[index], new Date())
    const merged = windows.map(serializeWindow)
    if (consumed === null) merged.splice(index, 1)
    else merged[index] = serializeWindow(consumed)
    // Re-derive the lifecycle so a counted window's expiry follows its quota.
    const next = normalizeWindows(merged, new Date()).map(serializeWindow)
    try {
      await saveConfig({ windows: next })
      state.lastConsume = {
        at: iso(Date.now()),
        removed: consumed === null,
        window: serializeWindow(windows[index]),
      }
      log(`window ${windows[index].start}-${windows[index].end} fired${consumed === null ? ' and was removed (temporary)' : ''}`)
    writeState(undefined, true)
    } catch (error) {
      warn(`could not record the window firing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Remove temporary windows whose lifecycle has ended.
   *
   * A persistent window is never removed — it only becomes inert. A temporary
   * one disappears once the last occurrence it could still use has passed
   * (fired or not), which is what `expiresAt` encodes.
   */
  let pruning = false
  const pruneExpiredWindows = async () => {
    if (pruning) return
    const windows = currentWindows()
    const now = Date.now()
    const expired = windows.filter(
      (window) =>
        window.persistent !== true &&
        typeof window.expiresAt === 'string' &&
        Date.parse(window.expiresAt) <= now,
    )
    if (expired.length === 0) return
    const keep = windows.filter((window) => !expired.includes(window)).map(serializeWindow)
    pruning = true
    try {
      await saveConfig({ windows: keep })
      state.lastExpire = { at: iso(now), removed: expired.map(serializeWindow) }
      log(`${expired.length} temporary window(s) reached the end of their lifecycle and were removed`)
    } catch (error) {
      warn(`could not remove expired windows: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      pruning = false
    }
  }

  /**
   * The point of no return: consume the window, start the power action, then
   * ask DSH to quit normally.
   *
   * Shutdown and restart are scheduled with Windows itself (`shutdown /t`) so
   * the deadline survives this process and the app closing; DSH is then closed
   * normally, and only force-closed if it refuses to leave. Hibernate, sleep
   * and custom commands are issued directly from here — they have no OS
   * countdown, and issuing them means DSH has to stay open.
   */
  const commitPending = async () => {
    if (pending === null || pending.phase === 'committing') return
    const now = Date.now()
    // A countdown that crossed a suspend proves nothing about the conversation,
    // and a wall clock that jumped proves nothing about the time. Either way the
    // user must not be ambushed by a shutdown at the moment the PC wakes up, so
    // the countdown is dropped and the idle clock starts again.
    const frozen = countdownCrossedSuspend({
      wallElapsed: now - pending.armedWall,
      monotonicElapsed: monotonicNow() - pending.armedMonotonic,
      lateMs: now - pending.dueAt,
    })
    if (frozen) {
      logLine(
        `commit skipped: the countdown crossed a suspend, a clock jump or a frozen process (${Math.round((now - pending.dueAt) / 1000)}s late)`,
      )
      cancelPending('the machine was suspended during the countdown')
      return
    }
    // Nothing polls the tree during a countdown any more, so verify it one last
    // time: a job that started meanwhile must still stop the action.
    const busyNow = collectBusy({ deep: true, force: true })
    if (busyNow.reasons.length > 0) {
      state.agents = busyNow.rows
      state.busyReasons = busyNow.reasons
      cancelPending('conversation is active again')
      return
    }
    const committing = pending
    committing.phase = 'committing'
    clearTimer(committing.commitTimer)
    committing.commitTimer = undefined
    clearTimer(committing.awakeTimer)
    committing.awakeTimer = undefined
    state.lastAction = { action: config.action, at: iso(Date.now()), dryRun: config.dryRun }
    writeState(undefined, true)
    log(`committing ${config.action}`)

    // Reminders are recorded, not obeyed: the shutdown may postpone them, and
    // the user should be able to see that in the log.
    const reminders = await collectScheduledReminders()
    if (reminders !== null && reminders.length > 0) {
      state.lastReminders = { at: iso(Date.now()), sessions: reminders }
      logLine(`reminders armed: ${reminders.map((entry) => `${entry.session}(${entry.count})`).join(', ')}`)
    }

    await consumeFiredWindow(committing.window)

    // The wake guard was started a few seconds earlier; here it must have
    // confirmed, because the command that follows may outlive this process.
    if (committing.awake !== undefined && committing.awake !== null) {
      const guard = await committing.awake
      if (pending === committing && guard !== null) {
        logLine(`wake guard ${guard.how}${guard.confirmed ? '' : ' (unconfirmed)'}`)
      }
    }

    const graceSeconds = osGraceSeconds()
    const osCounted = osOwnsCountdown()
    const plan = powerActionPlan({ platform: process.platform, graceSeconds })
    if (config.dryRun) {
      // A dry run builds the command and waits for the wake guard without running
      // it: that is the only safe way to prove the hand-over without switching
      // the PC off.
      log(`DRY RUN: would run the ${config.action} now`)
      logLine(`dry run: ${plan.program} ${plan.args.join(' ')} (not executed)`)
      pending = null
      writeState({ dryRunTriggered: true }, true)
      return
    }
    logLine(`commit: action=${config.action} platform=${process.platform} grace=${graceSeconds}s`)

    if (!osCounted) {
      // No OS-owned deadline here: wait for the end of the countdown and then
      // run the command; the OS that is switching off closes DSH for us.
      const wait = Math.max(0, committing.dueAt - Date.now())
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const result = await runPowerAction(graceSeconds)
      if (!result.ok) {
        state.lastError = `the system refused the ${config.action} action`
        warn(state.lastError)
        logLine('power command refused; DSH left running')
        writeState(undefined, true)
        return
      }
      logLine(`${config.action}: DSH stays open; the system closes it`)
      return
    }

    // Windows owns the last seconds: the deadline survives this process, and it
    // is the point from which the countdown can no longer be taken back. The
    // wait is bounded by the grace, so a wall clock that moved backwards cannot
    // stretch the final, uncancellable stretch.
    const remaining = Math.max(
      MIN_OS_GRACE_SECONDS,
      Math.min(graceSeconds, Math.ceil((committing.dueAt - Date.now()) / 1000)),
    )
    const result = await runPowerAction(remaining)
    if (!result.ok) {
      // Windows refused the power action. Leaving a working app untouched
      // beats hiding it for an action that will not happen.
      state.lastError = `the system refused the ${config.action} action`
      warn(state.lastError)
      logLine('power action refused; DSH left running')
      writeState(undefined, true)
      return
    }

    // The command is in the OS's hands now. If the machine is still running well
    // past the deadline, somebody aborted it from outside (a `shutdown /a`): the
    // countdown is over either way, so drop it instead of leaving the title bar
    // stuck in "committing" forever.
    committing.settleTimer = later(
      () => {
        committing.settleTimer = undefined
        if (pending !== committing) return
        pending = null
        state.lastActivityAt = Date.now()
        state.lastAbort = { at: iso(Date.now()), action: config.action }
        logLine('the power action did not happen (aborted outside the plugin); the countdown was dropped')
        log('the shutdown was aborted outside the plugin; the countdown was dropped')
        reschedule()
        writeState(undefined, true)
      },
      Math.max(6_000, committing.dueAt - Date.now() + 12_000),
    )

    // DSH is not closed from here. The shutdown the OS is now running is what
    // closes DSH — it sends WM_QUERYENDSESSION/WM_ENDSESSION, the message
    // Electron exits on — and `/t` implies `/f`, so the app cannot hold it up.
    // Keeping the plugin out of that path is the whole point: the action belongs
    // to the system, not to the process that may die with the app.
    logLine(`shutdown handed to the system; the OS closes DSH within ${remaining}s`)
    log('shutdown handed to the system; DSH is closed by it')
  }

  const arm = (reason) => {
    if (pending !== null) return false
    if (!currentArmed()) {
      log('not starting a countdown: the switch is off')
      return false
    }
    const gate = currentGate(Date.now())
    if (!gate.inWindow) {
      log('not starting a countdown: outside the configured time window')
      return false
    }
    const time = Date.now()
    const warningSeconds = currentWarningSeconds()
    const warningMs = Math.max(0, warningSeconds * 1000)
    const idleSeconds = Math.round((time - state.lastActivityAt) / 1000)
    state.triggerCount += 1
    state.lastTrigger = {
      at: iso(time),
      idleSeconds,
      action: config.action,
      dryRun: config.dryRun,
      window: gate.active === null ? null : serializeWindow(gate.active),
      reason: reason ?? 'idle',
    }
    logLine(`trigger idle=${idleSeconds}s action=${config.action} dryRun=${config.dryRun}`)
    log(
      `all conversations idle for ${idleSeconds}s; starting ${config.action}` +
        ` countdown of ${warningSeconds}s${config.dryRun ? ' (dry run)' : ''}`,
    )

    bumpRevision('runtime')
    // The commit starts where the OS-owned grace starts: those last seconds are
    // the window that can no longer be taken back, which is what the countdown
    // reports as "no undo any more".
    const graceSeconds = osGraceSeconds()
    const commitIn = Math.max(0, warningMs - graceSeconds * 1000)
    pending = {
      action: config.action,
      dueAt: time + warningMs,
      phase: 'countdown',
      window: gate.active === null ? null : serializeWindow(gate.active),
      commitTimer: undefined,
      awakeTimer: undefined,
      awake: undefined,
      settleTimer: undefined,
      graceSeconds,
      armedWall: time,
      armedMonotonic: monotonicNow(),
    }
    const armed = pending
    pending.commitTimer = later(() => {
      commitPending().catch((error) => warn(`commit failed: ${error instanceof Error ? error.message : String(error)}`))
    }, commitIn)
    // Keep the machine out of sleep across the hand-over, so a shutdown that was
    // issued just before a sleep cannot ambush the user on the next wake-up.
    // Started early on purpose: the guard needs about two seconds to hold its
    // request, and it must be holding it before the power command is issued. A
    // countdown shorter than that lead arms it at once, so the commit always
    // finds a promise to wait for.
    if (osOwnsCountdown() && graceSeconds > 0) {
      const hold = graceSeconds + KEEP_AWAKE_MARGIN_SECONDS
      const prepare = () => {
        armed.awakeTimer = undefined
        if (pending !== armed || disposed) return
        armed.awake = holdSystemAwake(hold)
      }
      const lead = commitIn - KEEP_AWAKE_LEAD_MS
      if (lead <= 0) prepare()
      else armed.awakeTimer = later(prepare, lead)
    }
    // The countdown owns the clock now; the idle timer steps aside.
    reschedule()
    writeState()
    return true
  }

  const cancelPending = (reason) => {
    if (pending === null) return false
    const cancelled = pending
    if (cancelled.phase === 'committing') {
      log('too late to cancel: the power action is already being committed')
      return false
    }
    pending = null
    clearTimer(cancelled.commitTimer)
    clearTimer(cancelled.awakeTimer)
    clearTimer(cancelled.settleTimer)
    // Reset the idle clock so the same countdown cannot restart immediately.
    state.lastActivityAt = Date.now()
    state.lastCancel = { at: iso(Date.now()), reason, action: cancelled.action, window: cancelled.window }
    logLine(`countdown cancelled: ${reason}`)
    flushSoon()
    reschedule()
    log(`countdown cancelled: ${reason}`)
    writeState(undefined, true)
    return true
  }

  /**
   * Cancel and make the current window inert until its range closes.
   *
   * @returns the skip result for the caller (command / browser).
   */
  const skipCurrentWindow = async () => {
    if (pending === null) return { ok: false, error: 'no countdown is running' }
    if (pending.phase === 'committing') return { ok: false, error: 'too late to cancel: the action is being committed' }
    const target = pending.window
    cancelPending('skipped by the user')
    if (target === null) return { ok: true, skipped: null, until: null }
    const windows = currentWindows()
    const index = findWindowIndex(windows, target)
    if (index < 0) return { ok: true, skipped: null, until: null }
    const until = windowEndInstant(windows[index], new Date()).toISOString()
    const merged = windows.map(serializeWindow)
    merged[index] = { ...merged[index], skipUntil: until }
    // Only this exact window is skipped; overlapping windows stay independent.
    const next = normalizeWindows(merged, new Date()).map(serializeWindow)
    try {
      await saveConfig({ windows: next })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    state.lastSkip = { at: iso(Date.now()), window: next[index], until }
    writeState(undefined, true)
    log(`skipping the ${windows[index].start}-${windows[index].end} window until ${until}`)
    tick()
    return { ok: true, skipped: next[index], until }
  }

  // -- scheduling -----------------------------------------------------------

  // Nothing polls on a fixed cadence: work is woken by the exact instant it is
  // needed — the idle threshold, a window boundary, a countdown deadline — and
  // by conversation events. A slow safety evaluation exists only to correct a
  // lost event (a job that started without any listener firing).
  let idleTimer = null
  let gateTimer = null
  let safetyTimer = null
  let flushTimer = null

  /** Safety-net evaluation interval; corrections only, never the normal path. */
  const SAFETY_INTERVAL_MS = Math.max(60_000, config.tickSeconds * 1000 * 20)

  /** Milliseconds until the window gate can change (null: it never will). */
  const msUntilGateChange = () => {
    const now = Date.now()
    const date = new Date(now)
    const windows = currentWindows()
    if (windows.length === 0) return null
    const nowGate = windowStateAt(date, windows)
    if (nowGate.inWindow) {
      if (nowGate.active === null) return null
      return Math.max(200, windowEndInstant(nowGate.active, date).getTime() - now + 500)
    }
    let best = null
    const minutesNow = date.getHours() * 60 + date.getMinutes()
    const secondsIntoMinute = date.getSeconds() * 1000 + date.getMilliseconds()
    const consider = (delta) => {
      if (!Number.isFinite(delta) || delta < 0) return
      best = best === null ? delta : Math.min(best, delta)
    }
    for (const window of windows) {
      if (window.repeat === 'today' && window.date !== localDateKey(date)) continue
      if (window.repeat === 'count' && (window.remaining ?? 0) <= 0) continue
      if (typeof window.skipUntil === 'string' && Date.parse(window.skipUntil) > now) {
        consider(Date.parse(window.skipUntil) - now)
        continue
      }
      if (typeof window.expiresAt === 'string' && Date.parse(window.expiresAt) > now) {
        consider(Date.parse(window.expiresAt) - now)
      }
      let deltaMinutes = window.startMinutes - minutesNow
      if (deltaMinutes < 0) deltaMinutes += 24 * 60
      consider(deltaMinutes * 60_000 - secondsIntoMinute)
    }
    return best === null ? null : Math.max(200, best + 500)
  }

  /**
   * Point every timer at the next instant that matters. Idempotent.
   *
   * The idle timer is the heart of the design: it is set once to the moment
   * the tree reaches the idle threshold, and every activity event moves it,
   * so a quiet Host costs no wakeups at all.
   */
  const reschedule = () => {
    if (disposed || !state.monitoring) return
    // The switch is authoritative: if it was turned off without a route call,
    // stop here instead of keeping listeners alive.
    if (!currentArmed()) {
      stopMonitoring('the switch was turned off')
      return
    }
    if (idleTimer !== null) {
      clearTimer(idleTimer)
      idleTimer = null
    }
    if (gateTimer !== null) {
      clearTimer(gateTimer)
      gateTimer = null
    }
    if (safetyTimer !== null) {
      clearTimer(safetyTimer)
      safetyTimer = null
    }
    if (pending === null && currentArmed()) {
      const deadline = state.lastActivityAt + currentIdleMinutes() * 60_000
      // Record both clocks: a suspend advances the wall clock only.
      const scheduledWall = Date.now()
      const scheduledMonotonic = monotonicNow()
      idleTimer = later(() => {
        idleTimer = null
        const late = Date.now() - deadline
        const suspended = suspendDetected({
          wallElapsed: Date.now() - scheduledWall,
          monotonicElapsed: monotonicNow() - scheduledMonotonic,
          lateMs: late,
        })
        if (suspended) {
          state.lastActivityAt = Date.now()
          logLine(`the machine was suspended for ${Math.round(late / 1000)}s (wall clock only); the idle clock restarted`)
        }
        tick()
      }, Math.max(250, deadline - Date.now()))
    }
    const gateDelay = msUntilGateChange()
    if (gateDelay !== null) {
      gateTimer = later(() => {
        gateTimer = null
        tick()
      }, gateDelay)
    }
    safetyTimer = later(() => {
      safetyTimer = null
      tick({ reconcile: true })
    }, SAFETY_INTERVAL_MS)
  }

  /** Write the status file soon after an activity change (debounced). */
  const flushSoon = () => {
    if (!state.monitoring || disposed) return
    if (flushTimer !== null) clearTimer(flushTimer)
    flushTimer = later(() => {
      flushTimer = null
      writeState()
    }, 500)
  }

  const clearSchedules = () => {
    for (const handle of [idleTimer, gateTimer, safetyTimer, flushTimer]) {
      if (handle !== null) clearTimer(handle)
    }
    idleTimer = null
    gateTimer = null
    safetyTimer = null
    flushTimer = null
  }

  const tick = (options = {}) => {
    if (disposed || !state.monitoring) return
    state.stats.ticks += 1
    const armed = currentArmed()
    const windows = currentWindows()
    const gate = windowStateAt(new Date(), windows)

    // The deep pass only runs when it can still change the decision: a
    // countdown is running, or the idle threshold has been reached.
    const idleSecondsNow = (Date.now() - state.lastActivityAt) / 1000
    const threshold = currentIdleMinutes() * 60
    const deep = pending !== null || idleSecondsNow >= threshold
    const busy = collectBusy({ deep, reconcile: options.reconcile === true })
    state.agents = busy.rows
    state.busyReasons = busy.reasons
    state.pendingInput = busy.rows.reduce((total, row) => total + (row.pendingInput ?? 0), 0)

    state.armed = armed
    state.windows = windows.map(serializeWindow)
    state.inWindow = gate.inWindow
    state.opensInMinutes = gate.opensInMinutes

    // Temporary windows that ran out of life disappear by themselves.
    pruneExpiredWindows().catch((error) => warn(`prune failed: ${error?.message ?? error}`))

    // Continuous work keeps the idle clock fresh, so the clock restarts from
    // the moment the tree actually goes quiet.
    if (busy.reasons.length > 0) state.lastActivityAt = busy.time

    // Work can also reappear without a fresh session event (a job left running,
    // a step that started before the countdown); never act on a busy tree.
    if (pending !== null && busy.reasons.length > 0) cancelPending('conversation is active again')

    // The switch and the window are gates, not just pre-checks: turning the
    // switch off, or a window closing, cancels a countdown already running.
    if (!armed) {
      cancelPending('the switch was turned off')
      stopMonitoring('the switch was turned off')
      return
    }
    if (pending !== null && !gate.inWindow) cancelPending('the configured time window closed')

    if (pending === null && armed && gate.inWindow && busy.reasons.length === 0) {
      const idleSeconds = (busy.time - state.lastActivityAt) / 1000
      if (idleSeconds >= threshold) arm('idle')
    }

    writeState()
    reschedule()
  }

  // -- commands -------------------------------------------------------------

  const describeStatus = () => {
    const time = Date.now()
    const busy = collectBusy()
    const idleSeconds = Math.max(0, Math.round((time - state.lastActivityAt) / 1000))
    const armed = currentArmed()
    const windows = currentWindows()
    const gate = windowStateAt(new Date(time), windows)
    const windowText = (window) => {
      const repeat =
        window.repeat === 'today'
          ? `today(${window.date}${window.used ? ',used' : ''})`
          : window.repeat === 'count'
            ? `x${window.remaining ?? 0}`
            : 'daily'
      return `${window.start}-${window.end}[${repeat},${window.persistent ? 'persistent' : 'temporary'}]`
    }
    const lines = [
      `switch=${armed ? 'on' : 'off'} monitoring=${state.monitoring ? 'running' : 'stopped'} action=${config.action} dryRun=${config.dryRun}`,
      `windows=${windows.length === 0 ? 'all day' : windows.map(windowText).join(', ')} inWindow=${gate.inWindow}`,
      `idle=${idleSeconds}s / ${Math.round(currentIdleMinutes() * 60)}s (tick ${config.tickSeconds}s)`,
      `grace=${osGraceSeconds()}s platform=${process.platform}` +
        ` ${osOwnsCountdown() ? '(the OS owns the last seconds)' : '(the command runs at the deadline)'}`,
      `agents=${busy.rows.length} active=${busy.reasons.length > 0}`,
    ]
    if (busy.reasons.length > 0) lines.push(`activeBecause: ${busy.reasons.join(', ')}`)
    else if (!armed) lines.push('the switch is off; nothing happens until it is on')
    else if (!gate.inWindow) {
      lines.push(`outside every time window; the next one opens in ${gate.opensInMinutes} min`)
    } else if (idleSeconds >= currentIdleMinutes() * 60 - config.tickSeconds) {
      lines.push('threshold reached; a countdown starts on the next tick')
    } else {
      lines.push(`action at ${Math.round(currentIdleMinutes() * 60 - idleSeconds)}s of idle`)
    }
    if (pending !== null) {
      lines.push(
        `pending: ${pending.action} in ${Math.max(0, Math.round((pending.dueAt - time) / 1000))}s` +
          ` (phase=${pending.phase}, window=${pending.window === null ? 'all day' : `${pending.window.start}-${pending.window.end}`})`,
      )
    } else {
      lines.push('pending: none')
    }
    lines.push(`stateFile=${stateFile()}`)
    if (state.lastError !== null) lines.push(`lastError=${state.lastError}`)
    return lines.join('\n')
  }

  /**
   * Persist a change to this row's config.
   *
   * The profile's patch file belongs to the user, so the plugin never rewrites
   * it directly: the config editor validates the candidate and serializes the
   * write. `armed` and `windows` are volatile, so a saved change reaches the
   * running monitor without restarting this entry.
   */
  const saveConfig = async (patch) => {
    const editor = service('configEditor')
    const entry = ctx.fiber?.entry
    state.saveCount = (state.saveCount ?? 0) + 1
    if (editor === undefined || entry === undefined) {
      const error = 'configuration cannot be saved in this profile (no config editor)'
      state.lastSave = { at: iso(Date.now()), patch, ok: false, error }
      throw new Error(error)
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      state.lastSave = { at: iso(Date.now()), patch, ok: true, error: null }
      bumpRevision('config')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastSave = { at: iso(Date.now()), patch, ok: false, error: message }
      throw error
    }
  }

  /** Why a countdown cannot start right now, for command and HTTP replies. */
  const blockedReason = () => {
    if (pending !== null) return 'a countdown is already running'
    if (!currentArmed()) return 'the switch is off'
    if (!state.monitoring) return 'monitoring is not running'
    const gate = currentGate(Date.now())
    if (!gate.inWindow) return `outside every time window (next opens in ${gate.opensInMinutes} min)`
    return undefined
  }

  // -- browser state route --------------------------------------------------

  /** Path the Client half reads and writes; both sides spell it the same. */
  const STATE_PATH = '/idle-shutdown/state'
  /** Path of the lazily loaded Settings page chunk. */
  const SETTINGS_PATH = '/idle-shutdown/settings.js'

  /** Directory of this plugin, for serving the client chunk from disk. */
  const pluginDir = () => dirname(fileURLToPath(import.meta.url))
  let settingsSourceCache = null
  const settingsSource = () => {
    if (settingsSourceCache === null) settingsSourceCache = readFileSync(join(pluginDir(), 'settings.js'), 'utf8')
    return settingsSourceCache
  }

  /**
   * Two revisions, because the two kinds of change are watched differently:
   * `config` moves when the user's settings change, `runtime` moves on activity,
   * countdowns and window edges. A waiter only holds while the kinds it asked
   * about are unchanged, so a Settings form is not re-read for idle churn.
   */
  const revisions = { config: 0, runtime: 0 }
  /** Long-poll waiters: { kinds, resolve }. */
  const stateWaiters = new Set()

  const bumpRevision = (kind) => {
    if (kind === 'config') revisions.config += 1
    else if (kind === 'runtime') revisions.runtime += 1
    else {
      revisions.config += 1
      revisions.runtime += 1
    }
    for (const waiter of [...stateWaiters]) {
      if (!waiter.kinds.has(kind) && kind !== 'both') continue
      stateWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  const readJsonBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('request body is too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      req.on('error', reject)
    })

  const registerRoutes = () => {
    if (typeof ctx.inject !== 'function') return
    // Do NOT pre-check `webServer` here: a cold profile boot applies this row
    // before the carrier exists, and the /state route (shared by the title-bar
    // switch and the Settings page) must appear as soon as it does.
    ctx.inject(['webServer', 'connection'], (child) => {
      child.effect(() => {
        const dispose = child.webServer.register({
          kind: 'exact',
          path: STATE_PATH,
          handler: async (req, res) => {
            // The same Host/Origin fence and login cookie every in-app route
            // uses, so only this authenticated GUI can flip the switch.
            const rejection = child.connection.requestRejection(req)
            res.setHeader('cache-control', 'no-store')
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            const method = (req.method ?? 'GET').toUpperCase()
            const reply = (status, payload) => {
              res.statusCode = status
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify(payload))
            }
            if (method === 'GET') {
              const url = new URL(req.url ?? STATE_PATH, 'http://localhost')
              const waitParam = Math.floor(Number(url.searchParams.get('wait') ?? '0'))
              const waitMs = Number.isFinite(waitParam) ? Math.min(25_000, Math.max(0, waitParam)) : 0
              const watch = url.searchParams.get('watch') ?? 'all'
              const kinds = watch === 'config' ? ['config'] : watch === 'runtime' ? ['runtime'] : ['config', 'runtime']
              const upToDate = kinds.every((kind) => Number(url.searchParams.get(`since${kind === 'config' ? 'Config' : 'Runtime'}`)) === revisions[kind])
              // Long poll: hold the request until a watched revision moves or
              // the caller's own bound expires, so the page needs no polling.
              if (waitMs >= 500 && upToDate) {
                await new Promise((resolvePromise) => {
                  let settled = false
                  const timer = setTimeout(finish, waitMs)
                  const waiter = { kinds: new Set(kinds), resolve: finish }
                  function finish() {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    stateWaiters.delete(waiter)
                    resolvePromise()
                  }
                  stateWaiters.add(waiter)
                  req.on('close', finish)
                })
              }
              reply(200, { revision: { ...revisions }, state: buildSnapshot() })
              return
            }
            if (method !== 'POST') {
              res.setHeader('allow', 'GET, POST')
              reply(405, { ok: false, error: 'method not allowed' })
              return
            }

            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              return
            }

            // Title-bar undo: cancel this countdown, or cancel and skip the
            // rest of the window that allowed it.
            if (body?.command === 'cancel' || body?.command === 'skip') {
              if (body.command === 'cancel') {
                const cancelled = cancelPending('cancelled from the title bar')
                reply(
                  cancelled ? 200 : 409,
                  cancelled
                    ? { ok: true, state: buildSnapshot() }
                    : { ok: false, error: 'too late to cancel: the action is being committed', state: buildSnapshot() },
                )
                return
              }
              const result = await skipCurrentWindow()
              reply(
                result.ok ? 200 : 409,
                result.ok
                  ? { ok: true, state: buildSnapshot(), skipped: result.skipped, until: result.until }
                  : { ok: false, error: result.error, state: buildSnapshot() },
              )
              return
            }

            // Diagnostics from the browser half (layout measurements); never config.
            if (body?.debug !== undefined) {
              state.lastDebug = { at: iso(Date.now()), debug: body.debug }
              reply(200, { ok: true, state: buildSnapshot() })
              return
            }

            const patch = {}
            if (typeof body?.armed === 'boolean') patch.armed = body.armed
            if (body?.idleMinutes !== undefined) {
              const minutes = Number(body.idleMinutes)
              if (!Number.isFinite(minutes) || minutes < MIN_IDLE_MINUTES || minutes > MAX_IDLE_MINUTES) {
                reply(400, { ok: false, error: `idleMinutes must be between ${MIN_IDLE_MINUTES} and ${MAX_IDLE_MINUTES}` })
                return
              }
              patch.idleMinutes = minutes
            }
            if (body?.warningSeconds !== undefined) {
              const seconds = Math.floor(Number(body.warningSeconds))
              if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WARNING_SECONDS) {
                reply(400, { ok: false, error: `warningSeconds must be between 0 and ${MAX_WARNING_SECONDS}` })
                return
              }
              patch.warningSeconds = seconds
            }
            if (body?.closeLeadSeconds !== undefined) {
              const seconds = Math.floor(Number(body.closeLeadSeconds))
              if (!Number.isFinite(seconds) || seconds < MIN_OS_GRACE_SECONDS || seconds > MAX_OS_GRACE_SECONDS) {
                reply(400, {
                  ok: false,
                  error: `closeLeadSeconds must be between ${MIN_OS_GRACE_SECONDS} and ${MAX_OS_GRACE_SECONDS}`,
                })
                return
              }
              patch.closeLeadSeconds = seconds
            }
            if (Array.isArray(body?.windows)) {
              const normalized = normalizeWindows(body.windows)
              if (normalized.length !== body.windows.length) {
                reply(400, { ok: false, error: 'a window is not a valid HH:MM range' })
                return
              }
              patch.windows = normalized.map(serializeWindow)
            }
            if (Object.keys(patch).length === 0) {
              reply(400, { ok: false, error: 'nothing to change' })
              return
            }

            try {
              await saveConfig(patch)
            } catch (error) {
              reply(500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
              return
            }
            // Follow the switch at once: turning it on starts monitoring,
            // turning it off stops every listener and timer.
            syncMonitoring('saved from the browser')
            bumpRevision('config')
            reply(200, { ok: true, state: buildSnapshot() })
          },
        })
        state.routeRegistered = true
        // One write so the status file reflects the route even while the
        // monitor is stopped (no tick runs then).
        writeState()

        // The Settings page is its own chunk: serve it on demand so the page
        // only parses it when the section is opened.
        const disposeChunk = child.webServer.register({
          kind: 'exact',
          path: SETTINGS_PATH,
          handler: (req, res) => {
            if (child.connection.requestRejection(req) !== undefined) {
              res.statusCode = 401
              res.end()
              return
            }
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
              res.statusCode = 405
              res.end()
              return
            }
            try {
              const source = settingsSource()
              res.statusCode = 200
              res.setHeader('content-type', 'text/javascript; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(source)
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'text/plain; charset=utf-8')
              res.end(error instanceof Error ? error.message : String(error))
            }
          },
        })
        return () => {
          dispose?.()
          disposeChunk?.()
        }
      })
    })
  }

  const registerCommand = () => {
    const definition = {
      name: 'idle-shutdown',
      description: 'Inspect or control the idle-shutdown monitor (status, on, off, cancel, skip, now, reactivate)',
      input: { hint: 'status | on | off | cancel | skip | now | reactivate [today|count|daily]' },
      handler: async (invocation) => {
        const verb = String(invocation?.rawInput ?? '').trim().toLowerCase()
        if (verb === '' || verb === 'status') return { kind: 'success', text: describeStatus() }
        if (verb === 'cancel') {
          if (pending === null) {
            state.lastActivityAt = Date.now()
            return { kind: 'success', text: 'no countdown was pending; the idle clock was reset' }
          }
          const cancelled = cancelPending('command')
          return cancelled
            ? { kind: 'success', text: 'countdown cancelled' }
            : { kind: 'error', text: 'too late to cancel: the power action is being committed' }
        }
        if (verb === 'skip') {
          const result = await skipCurrentWindow()
          if (!result.ok) return { kind: 'error', text: result.error }
          return {
            kind: 'success',
            text:
              result.skipped === null
                ? 'countdown cancelled (no window to skip)'
                : `countdown cancelled; ${result.skipped.start}-${result.skipped.end} skipped until ${result.until}`,
          }
        }
        if (verb === 'on' || verb === 'off') {
          try {
            await saveConfig({ armed: verb === 'on' })
          } catch (error) {
            return {
              kind: 'error',
              text: `cannot save the switch: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
          syncMonitoring(`switch turned ${verb}`)
          return {
            kind: 'success',
            text: verb === 'on' ? 'switch is on; monitoring started' : 'switch is off; monitoring stopped',
          }
        }
        if (verb === 'reactivate' || verb.startsWith('reactivate ')) {
          const mode = (verb.split(/\s+/)[1] ?? 'today').toLowerCase()
          if (!REACTIVATIONS.includes(mode)) {
            return { kind: 'error', text: `reactivate needs one of: ${REACTIVATIONS.join(', ')}` }
          }
          const windows = currentWindows()
          const now = new Date()
          const index = windows.findIndex((window) => windowStale(window, now))
          if (index < 0) return { kind: 'error', text: 'no inert persistent window to re-activate' }
          const next = windows.map((window, at) => (at === index ? reactivateWindow(window, mode, { now }) : window))
          try {
            await saveConfig({ windows: next.map(serializeWindow) })
          } catch (error) {
            return {
              kind: 'error',
              text: `cannot save the re-activated window: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
          state.lastReactivate = { at: iso(Date.now()), mode, window: serializeWindow(next[index]) }
          logLine(`window ${next[index].start}-${next[index].end} re-activated as ${next[index].repeat}`)
          tick()
          return {
            kind: 'success',
            text: `re-activated ${next[index].start}-${next[index].end} as ${next[index].repeat}`,
          }
        }
        if (verb === 'now') {
          const blocked = blockedReason()
          if (blocked !== undefined) return { kind: 'error', text: `cannot start a countdown: ${blocked}` }
          arm('command')
          return {
            kind: 'success',
            text: `countdown started (${config.action} in ${currentWarningSeconds()}s${config.dryRun ? ', dry run' : ''})`,
          }
        }
        return { kind: 'error', text: `unknown argument "${verb}"; use status, on, off, cancel, skip, now, or reactivate` }
      },
    }

    const commands = service('commands')
    if (commands !== undefined) {
      ctx.effect(() => {
        const dispose = commands.register(definition)
        state.commandRegistered = definition.name
        return dispose
      })
      return
    }
    // The registry may compose after this plugin; register once it appears.
    ctx.inject?.(['commands'], (child) => {
      child.effect(() => {
        const dispose = child.commands.register(definition)
        state.commandRegistered = definition.name
        return dispose
      })
    })
  }

  // -- lifecycle ------------------------------------------------------------

  // The monitor runs only while the switch is on: no ticking, no Agent or
  // Session listeners, no conversation scanning at all when it is off.
  const startMonitoring = () => {
    if (disposed) return
    if (state.monitoring) {
      // Already running: just refresh the snapshot and realign the timers.
      tick()
      reschedule()
      return
    }
    state.monitoring = true
    state.lastActivityAt = Date.now()
    sessionActivity.clear()
    agentStatus.clear()
    bindEvents()
    state.lastMonitoring = { startedAt: iso(Date.now()), adaptive: true }
    bumpRevision('config')
    log('monitoring started')
    tick({ reconcile: true })
    reschedule()
  }

  const stopMonitoring = (reason) => {
    clearSchedules()
    if (state.monitoring) log(`monitoring stopped: ${reason}`)
    state.monitoring = false
    unbindEvents()
    state.lastMonitoring = { ...(state.lastMonitoring ?? {}), stoppedAt: iso(Date.now()), reason }
    writeState(undefined, true)
    bumpRevision('config')
  }

  /** Follow the switch: start when it is on, stop when it is off. */
  const syncMonitoring = (reason) => {
    if (currentArmed()) startMonitoring()
    else stopMonitoring(reason ?? 'the switch is off')
  }

  registerCommand()
  registerRoutes()
  // A guard left by an earlier run is dead (its process is gone); clear its
  // files before this run can arm a new one.
  forgetWakeGuard()
  // An older version kept its files in the temp directory; take them along.
  adoptLegacyFiles()
  // Enforce the retention policy once at startup: leftovers from a crashed run,
  // and log generations beyond the configured cap, go now.
  const prunedAtStart = pruneFiles()
  if (prunedAtStart.length > 0) log(`retention: removed ${prunedAtStart.join(', ')}`)
  syncMonitoring('activation')

  // Unloading cancels a countdown that has not committed yet. Once the action is
  // committed the detached helper owns it, and a pending commit is left alone so
  // an unload cannot silently strand a half-closed DSH.
  ctx.effect(() => () => {
    disposed = true
    clearSchedules()
    state.monitoring = false
    unbindEvents()
    for (const handle of timers) clearTimeout(handle)
    timers.clear()
    if (pending !== null && pending.phase === 'countdown') {
      pending = null
      log('plugin unloaded during the countdown; nothing was committed')
    }
    writeState({ stopped: true }, true)
    // Inside the package directory the runtime files leave with the package; a
    // read-only installation that fell back to the temp directory cleans them
    // here, so an uninstall cannot leave them behind.
    removeFallbackFiles()
  })

  log(
    `configured: switch=${currentArmed() ? 'on' : 'off'}, windows=` +
      `${config.windows.length === 0 ? 'all day' : config.windows.map((w) => `${w.start}-${w.end}(${w.repeat}${w.persistent ? ',persistent' : ',temporary'})`).join(', ')}, ` +
      `${currentIdleMinutes()} min idle -> ${config.action}` +
      ` (warning ${currentWarningSeconds()}s, tick ${config.tickSeconds}s, dryRun=${config.dryRun})`,
  )
  writeState(undefined, true)
}