/**
 * Self-test for `dsh-idle-shutdown`.
 *
 * Runs the pure decision helpers and drives `apply` through a fake Host with
 * `dryRun: true`, so it never touches the power state. Run with `node
 * self-test.mjs`; exit code 0 means every assertion passed.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTIONS,
  COMMIT_DRIFT_MS,
  COMMIT_LATE_MS,
  DEFAULT_OS_GRACE_SECONDS,
  DEFAULT_WINDOWS,
  MAX_IDLE_MINUTES,
  MAX_OS_GRACE_SECONDS,
  MAX_WARNING_SECONDS,
  MIN_IDLE_MINUTES,
  MIN_OS_GRACE_SECONDS,
  PLATFORMS,
  REACTIVATIONS,
  SUSPEND_DRIFT_MS,
  activeWindow,
  apply,
  classifyAgent,
  agentGraceMs,
  countdownCrossedSuspend,
  keepAwakeLauncher,
  keepAwakePlan,
  keepAwakeScript,
  powerActionPlan,
  reactivateWindow,
  windowStale,
  suspendDetected,
  computeExpiresAt,
  consumeWindow,
  isConversationEvent,
  localDateKey,
  normalizeWindows,
  parseTimeOfDay,
  resolveConfig,
  serializeWindow,
  windowEndInstant,
  windowStateAt,
} from './index.js'

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`ok   ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const at = (hours, minutes, day = 15) => new Date(2026, 0, day, hours, minutes, 0, 0)

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

const defaults = resolveConfig(undefined)
equal('defaults: action', defaults.action, 'shutdown')
equal('defaults: idleMinutes', defaults.idleMinutes, 30)
equal('defaults: warningSeconds', defaults.warningSeconds, 60)
equal('defaults: tickSeconds', defaults.tickSeconds, 15)
equal('defaults: waitingGraceMinutes', defaults.waitingGraceMinutes, 10)
equal('defaults: armed', defaults.armed, true)
equal('defaults: windows', defaults.windows, DEFAULT_WINDOWS)
equal('defaults: dryRun', defaults.dryRun, false)
// The last seconds of the countdown belong to the OS command: three of them are
// enough for DSH to leave and too few to be a second, uncontrollable countdown.
equal('defaults: the OS grace is three seconds', defaults.closeLeadSeconds, DEFAULT_OS_GRACE_SECONDS)
equal('defaults: the OS grace is three seconds', DEFAULT_OS_GRACE_SECONDS, 3)
equal('clamp: a zero grace is raised to one second', resolveConfig({ closeLeadSeconds: 0 }).closeLeadSeconds, MIN_OS_GRACE_SECONDS)
equal('clamp: a huge grace is capped', resolveConfig({ closeLeadSeconds: 9999 }).closeLeadSeconds, MAX_OS_GRACE_SECONDS)
equal('clamp: a fractional grace is floored', resolveConfig({ closeLeadSeconds: 4.7 }).closeLeadSeconds, 4)
// Limits: three hours of idle wait, half an hour of countdown, 3s-1min of grace.
equal('limits: idleMinutes is capped at three hours', resolveConfig({ idleMinutes: 24 * 60 }).idleMinutes, MAX_IDLE_MINUTES)
equal('limits: the idle cap is three hours', MAX_IDLE_MINUTES, 180)
equal('limits: warningSeconds is capped at half an hour', resolveConfig({ warningSeconds: 3600 }).warningSeconds, MAX_WARNING_SECONDS)
equal('limits: the countdown cap is half an hour', MAX_WARNING_SECONDS, 1800)
equal('limits: the grace floor is three seconds', MIN_OS_GRACE_SECONDS, 3)
equal('limits: the grace cap is one minute', MAX_OS_GRACE_SECONDS, 60)

// DSH is closed by the shutdown itself (WM_QUERYENDSESSION → WM_ENDSESSION), so
// the plugin owns no "close the app" code at all.
check('lifecycle: the plugin never closes DSH itself', typeof (await import('./index.js')).sessionEndScript === 'undefined', '')

// The wake detection compares two clocks: only a wall-clock advance the
// monotonic clock did not see proves a suspend. Ordinary timer lateness
// (Windows coalesces background timers by seconds) advances both.
equal('suspend: a 5s late timer is not a wake', suspendDetected({ wallElapsed: 300_000, monotonicElapsed: 295_000, lateMs: 5_000 }), false)
equal('suspend: a late timer without drift is not a wake', suspendDetected({ wallElapsed: 305_000, monotonicElapsed: 305_000, lateMs: 5_000 }), false)
equal('suspend: a two-minute drift is a wake', suspendDetected({ wallElapsed: 420_000, monotonicElapsed: 300_000, lateMs: 120_000 }), true)
equal('suspend: an hours-long drift is a wake', suspendDetected({ wallElapsed: 3 * 3_600_000, monotonicElapsed: 300_000, lateMs: 3 * 3_600_000 }), true)
equal('suspend: a very late timer alone is a wake', suspendDetected({ wallElapsed: 900_000, monotonicElapsed: 0, lateMs: 600_000 }), true)
equal('suspend: the drift threshold is one minute', suspendDetected({ wallElapsed: 360_500, monotonicElapsed: 300_000, lateMs: 0 }), true)

// The point of no return is stricter than the idle clock: a false "wake" there
// cancels a shutdown, a missed wake switches the machine off in the user's face.
equal('commit: an on-time countdown commits', countdownCrossedSuspend({ wallElapsed: 177_000, monotonicElapsed: 177_000, lateMs: -3_000 }), false)
equal('commit: ten seconds late is a frozen countdown', countdownCrossedSuspend({ wallElapsed: 187_000, monotonicElapsed: 187_000, lateMs: 7_000 }), true)
equal('commit: a two-minute clock correction is not a suspend', countdownCrossedSuspend({ wallElapsed: 420_000, monotonicElapsed: 300_000, lateMs: -3_000 }), false)
equal('commit: an hour of drift is a suspend', countdownCrossedSuspend({ wallElapsed: 3_600_000, monotonicElapsed: 180_000, lateMs: -3_000 }), true)
check('commit: the lateness threshold is a few seconds', COMMIT_LATE_MS <= 10_000, String(COMMIT_LATE_MS))
check('commit: the drift threshold is far above the idle one', COMMIT_DRIFT_MS > SUSPEND_DRIFT_MS * 5, String(COMMIT_DRIFT_MS))

// ---------------------------------------------------------------------------
// platform power plans
//
// Only Windows owns a countdown that survives the app; the shorter the OS grace,
// the more of the countdown stays cancellable, but it must never be zero.
// ---------------------------------------------------------------------------

equal('platforms: three are supported', PLATFORMS, ['win32', 'darwin', 'linux'])
// This plugin performs exactly one action. Sleep, hibernate, restart and custom
// commands are deliberately not offered: it is an idle *shutdown*.
equal('actions: only shutdown', ACTIONS, ['shutdown'])
const winShutdown = powerActionPlan({ platform: 'win32', graceSeconds: 3 })
equal('plan/win32: shutdown hands the last three seconds to the OS', winShutdown.args, [
  '/s',
  '/t',
  '3',
  '/c',
  'DSH idle shutdown',
])
equal('plan/win32: the OS owns the countdown', winShutdown.osCounted, true)
equal(
  'plan/win32: the default grace comes from one constant',
  powerActionPlan({ platform: 'win32' }).args[2],
  String(DEFAULT_OS_GRACE_SECONDS),
)
equal(
  'plan/win32: a zero grace is clamped up',
  powerActionPlan({ platform: 'win32', graceSeconds: 0 }).args[2],
  String(MIN_OS_GRACE_SECONDS),
)
equal(
  'plan/win32: a huge grace is clamped down',
  powerActionPlan({ platform: 'win32', graceSeconds: 9999 }).args[2],
  String(MAX_OS_GRACE_SECONDS),
)
equal('plan/darwin: shutdown is an Apple event', powerActionPlan({ platform: 'darwin' }).program, 'osascript')
equal('plan/darwin: the system owns no countdown', powerActionPlan({ platform: 'darwin' }).osCounted, false)
equal('plan/linux: shutdown is systemctl poweroff', powerActionPlan({ platform: 'linux' }).args, ['poweroff'])
check(
  'plan: every platform asks for a shutdown and nothing else',
  PLATFORMS.every((platform) => {
    const plan = powerActionPlan({ platform })
    const line = plan.args.join(' ')
    return plan.description === 'shutdown' && /\/s |shut down|poweroff/.test(line)
  }),
  PLATFORMS.map((platform) => `${platform}:${powerActionPlan({ platform }).args.join(' ')}`).join(' | '),
)

// ---------------------------------------------------------------------------
// the wake guard
//
// The machine must not fall asleep between the power command and the power
// action: a deadline that expires during sleep fires the moment the user wakes
// the PC up. The guard also must not light the screen up.
// ---------------------------------------------------------------------------

const guardScript = keepAwakeScript()
check('guard: the script asks for the working state', guardScript.includes('([int]::MinValue) -bor 1'), '')
check('guard: the script never asks for the display', guardScript.includes('DISPLAY') === false, '')
check('guard: the request is released in a finally block', guardScript.includes('} finally {') && guardScript.includes('[void][DshPower.Native]::SetThreadExecutionState([int]::MinValue)'), '')
check('guard: the release also runs when the guard is aborted', guardScript.indexOf('finally') > guardScript.indexOf('while'), '')
check('guard: the marker is written after the request is held', guardScript.indexOf('SetThreadExecutionState(([int]::MinValue) -bor 1)') < guardScript.indexOf('Set-Content'), '')
// A `shutdown /a` (event 1075) after the guard armed means the deadline it was
// protecting is gone: the request must be dropped instead of held for nothing.
check('guard: a user abort is watched', guardScript.includes('Get-WinEvent') && guardScript.includes('Id = 1075'), '')
check('guard: only an abort after arming counts', guardScript.includes('$started = Get-Date') && guardScript.includes('StartTime = $started'), '')
check('guard: the promise is one-shot', guardScript.includes('while ((Get-Date) -lt $deadline)') && guardScript.includes('$deadline = $started.AddSeconds'), '')
const winGuard = keepAwakePlan('win32', 23, {
  directory: 'C:\\tmp',
  script: 'C:\\tmp\\g.ps1',
  wrapper: 'w.cmd',
  marker: 'C:\\tmp\\g.ready',
})
equal('guard/win32: a PowerShell helper holds the request', winGuard.program, 'powershell.exe')
equal('guard/win32: the hold is passed to the script', winGuard.args.at(-1), 'C:\\tmp\\g.ready')
equal('guard/win32: the marker is where the Host waits for it', winGuard.marker, 'C:\\tmp\\g.ready')
equal(
  'guard/win32: the guard is started through a wrapper',
  winGuard.wrapper,
  'w.cmd',
)
equal(
  'guard/win32: a zero hold is still a second',
  keepAwakePlan('win32', 0, { marker: 'm' }).args[keepAwakePlan('win32', 0, { marker: 'm' }).args.indexOf('-Seconds') + 1],
  '1',
)
const launcher = keepAwakeLauncher('g.cmd', "C:\\a b\\c'd")
check('guard/win32: the helper is created outside the app job', launcher.includes("([wmiclass]'Win32_Process')"), launcher)
check('guard/win32: the launcher quotes the directory', launcher.includes("'C:\\a b\\c''d'"), launcher)
check('guard/win32: the launcher reports the creation result', launcher.includes('[int]$r.ReturnValue'), '')
check('guard/win32: the console window is hidden', launcher.includes("'Win32_ProcessStartup'") && launcher.includes('ShowWindow = 0'), launcher)
equal('guard/darwin: caffeinate blocks idle sleep only', keepAwakePlan('darwin', 9).args, ['-i', '-t', '9'])
check('guard/linux: systemd-inhibit blocks sleep', keepAwakePlan('linux', 9).args.join(' ').includes('--what=sleep'), '')
equal('guard/darwin: no marker file is needed', keepAwakePlan('darwin', 9).marker, null)

// ---------------------------------------------------------------------------
// re-activating an inert persistent window
//
// A persistent window stays in the list, but "today" is stamped to the day it
// fired and a counted one can run out — without re-activation persistence would
// only keep dead rows around.
// ---------------------------------------------------------------------------

equal('reactivations: three modes', REACTIVATIONS, ['today', 'count', 'daily'])
// Which rows the Settings page offers re-activation for, and which the
// `/idle-shutdown reactivate` verb picks.
const staleAt = at(9, 0)
equal('stale: a today row stamped to another day', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'today', date: '2026-01-14', persistent: true }], staleAt)[0], staleAt), true)
equal('stale: a today row already used', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'today', used: true, persistent: true }], staleAt)[0], staleAt), true)
equal('stale: a live today row is not stale', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'today', persistent: true }], staleAt)[0], staleAt), false)
equal('stale: a counted row out of quota', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'count', remaining: 0, persistent: true }], staleAt)[0], staleAt), true)
equal('stale: a skipped row', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'daily', skipUntil: '2026-01-15T23:00:00.000Z' }], staleAt)[0], staleAt), true)
equal('stale: a daily row is never stale', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'daily' }], staleAt)[0], staleAt), false)
equal('stale: a temporary row never counts as persistent-but-inert', windowStale(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'count', remaining: 0, persistent: false }], staleAt)[0], staleAt), false)
const inertTodayRow = { start: '00:00', end: '23:59', repeat: 'today', persistent: true, date: '2026-01-14', used: true }
const reactivatedToday = reactivateWindow(inertTodayRow, 'today', { now: at(9, 0) })
equal('reactivate/today: stamped with today', reactivatedToday.date, localDateKey(at(9, 0)))
equal('reactivate/today: the used mark is cleared', reactivatedToday.used, false)
equal('reactivate/today: the repository stays persistent', reactivatedToday.persistent, true)
check(
  'reactivate/today: the window can fire again',
  activeWindow(normalizeWindows([reactivatedToday], at(9, 0)), at(9, 0)) !== null,
  '',
)
const inertCountRow = { start: '00:00', end: '23:59', repeat: 'count', persistent: true, remaining: 0, skipUntil: '2026-01-15T23:00:00.000Z' }
const reactivatedCount = reactivateWindow(inertCountRow, 'count', { remaining: 4, now: at(9, 0) })
equal('reactivate/count: a new quota', reactivatedCount.remaining, 4)
equal('reactivate/count: the skip is dropped', reactivatedCount.skipUntil, undefined)
equal('reactivate/count: the repeat type switches', reactivatedCount.repeat, 'count')
check(
  'reactivate/count: the window can fire again',
  activeWindow(normalizeWindows([reactivatedCount], at(9, 0)), at(9, 0)) !== null,
  '',
)
const reactivatedDaily = reactivateWindow(inertTodayRow, 'daily', { now: at(9, 0) })
equal('reactivate/daily: becomes a daily window', reactivatedDaily.repeat, 'daily')
equal('reactivate/daily: a daily window is persistent', reactivatedDaily.persistent, true)
equal('reactivate/daily: the stale date is gone', reactivatedDaily.date, undefined)
equal(
  'reactivate/count: a junk count becomes one use',
  reactivateWindow(inertCountRow, 'count', { remaining: 'junk' }).remaining,
  1,
)
equal(
  'reactivate: an unknown mode re-arms today',
  reactivateWindow(inertTodayRow, 'nonsense', { now: at(9, 0) }).repeat,
  'today',
)

const clamped = resolveConfig({ idleMinutes: 0, tickSeconds: 1, action: 'nope' })
check('clamp: idleMinutes floor', clamped.idleMinutes === MIN_IDLE_MINUTES, String(clamped.idleMinutes))
check('clamp: tickSeconds floor', clamped.tickSeconds === 2, String(clamped.tickSeconds))
equal('clamp: any action becomes the only one', clamped.action, 'shutdown')

equal('actions: hibernation is not offered', ACTIONS.includes('hibernate'), false)

// ---------------------------------------------------------------------------
// times and windows
// ---------------------------------------------------------------------------

equal('time: valid', parseTimeOfDay('23:05'), 23 * 60 + 5)
equal('time: midnight', parseTimeOfDay('00:00'), 0)
equal('time: invalid hour', parseTimeOfDay('24:00'), null)
equal('time: invalid minute', parseTimeOfDay('07:60'), null)
equal('time: junk', parseTimeOfDay('evening'), null)
equal('date key: local day', localDateKey(at(9, 5)), '2026-01-15')

const normalized = normalizeWindows(
  [
    { start: '23:00', end: '07:00' },
    { start: 'later', end: '07:00' },
    { start: '09:00', end: '12:00', repeat: 'count', remaining: 3, persistent: false },
    { start: '10:00', end: '11:00', repeat: 'today' },
  ],
  at(8, 0),
)
equal('windows: invalid entries are dropped', normalized.length, 3)
equal('windows: default repeat/persistent', serializeWindow(normalized[0]), {
  start: '23:00',
  end: '07:00',
  repeat: 'daily',
  persistent: true,
})
const serializedCount = serializeWindow(normalized[1])
equal('windows: count keeps its quota', [serializedCount.start, serializedCount.repeat, serializedCount.persistent, serializedCount.remaining], ['09:00', 'count', false, 3])
check('windows: a temporary window carries a lifecycle', typeof serializedCount.expiresAt === 'string', String(serializedCount.expiresAt))
const serializedToday = serializeWindow(normalized[2])
equal('windows: today is stamped with the local date', [serializedToday.start, serializedToday.repeat, serializedToday.date, serializedToday.used], ['10:00', 'today', '2026-01-15', false])

const overnight = normalizeWindows([{ start: '23:00', end: '07:00' }])
equal('window: 23:30 is inside the overnight range', windowStateAt(at(23, 30), overnight).inWindow, true)
equal('window: 02:00 is inside the overnight range', windowStateAt(at(2, 0), overnight).inWindow, true)
equal('window: 12:00 is outside the overnight range', windowStateAt(at(12, 0), overnight).inWindow, false)
equal('window: the next opening is counted', windowStateAt(at(12, 0), overnight).opensInMinutes, 11 * 60)
equal('window: the closing edge is exclusive', windowStateAt(at(7, 0), overnight).inWindow, false)
equal('window: the opening edge is inclusive', windowStateAt(at(23, 0), overnight).inWindow, true)

const daytime = normalizeWindows([{ start: '09:00', end: '12:00' }])
equal('window: daytime range inside', windowStateAt(at(10, 30), daytime).inWindow, true)
equal('window: daytime range outside', windowStateAt(at(20, 0), daytime).inWindow, false)

equal(
  'window: several ranges, first eligible match wins',
  activeWindow(normalizeWindows([{ start: '23:00', end: '07:00' }, { start: '09:00', end: '12:00' }]), at(10, 0))?.start,
  '09:00',
)
equal('window: equal start and end means the whole day', windowStateAt(at(5, 0), normalizeWindows([{ start: '05:00', end: '05:00' }])).inWindow, true)
equal('window: no windows means the whole day', windowStateAt(at(5, 0), []).inWindow, true)

const todayWindow = normalizeWindows([{ start: '10:00', end: '11:00', repeat: 'today' }], at(9, 0))
equal('today: eligible on its date', windowStateAt(at(10, 30), todayWindow).inWindow, true)
equal('today: inert on another date', windowStateAt(at(10, 30, 16), todayWindow).inWindow, false)
equal(
  'today: a used window never fires again',
  windowStateAt(at(10, 30), normalizeWindows([{ start: '10:00', end: '11:00', repeat: 'today', date: '2026-01-15', used: true }], at(9, 0))).inWindow,
  false,
)

const counted = normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'count', remaining: 2 }], at(9, 0))
equal('count: quota left means eligible', windowStateAt(at(10, 0), counted).inWindow, true)
equal(
  'count: an exhausted window is inert',
  windowStateAt(at(10, 0), normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'count', remaining: 0 }], at(9, 0))).inWindow,
  false,
)

const skipped = normalizeWindows([{ start: '00:00', end: '23:59', skipUntil: '2026-01-15T23:00:00.000Z' }], at(9, 0))
equal('skip: a skipped window is inert until the skip ends', windowStateAt(at(10, 0), skipped).inWindow, false)
equal('skip: the same window reopens after it', windowStateAt(new Date('2026-01-15T23:30:00.000Z'), skipped).inWindow, true)

// Consumption: temporary windows disappear, persistent ones only lose quota.
equal(
  'consume: temporary window is removed',
  consumeWindow(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'today', persistent: false }], at(9, 0))[0], at(10, 0)),
  null,
)
equal(
  'consume: persistent counted window loses one use',
  serializeWindow(consumeWindow(normalizeWindows([{ start: '00:00', end: '23:59', repeat: 'count', remaining: 2 }])[0], at(10, 0))),
  { start: '00:00', end: '23:59', repeat: 'count', persistent: true, remaining: 1 },
)
equal(
  'consume: persistent today window is marked used',
  serializeWindow(consumeWindow(normalizeWindows([{ start: '10:00', end: '11:00', repeat: 'today' }], at(9, 0))[0], at(10, 0))),
  { start: '10:00', end: '11:00', repeat: 'today', persistent: true, date: '2026-01-15', used: true },
)
equal(
  'consume: persistent daily window is unchanged',
  serializeWindow(consumeWindow(normalizeWindows([{ start: '00:00', end: '23:59' }])[0], at(10, 0))),
  { start: '00:00', end: '23:59', repeat: 'daily', persistent: true },
)

const endOfOvernight = windowEndInstant(normalizeWindows([{ start: '23:00', end: '07:00' }])[0], at(23, 30))
equal('skip end: overnight window ends tomorrow morning', [endOfOvernight.getDate(), endOfOvernight.getHours()], [16, 7])
const endOfDaytime = windowEndInstant(normalizeWindows([{ start: '09:00', end: '12:00' }])[0], at(10, 0))
equal('skip end: daytime window ends today', [endOfDaytime.getDate(), endOfDaytime.getHours()], [15, 12])

// Skipping one window must never touch an overlapping one.
const overlapping = normalizeWindows(
  [
    { start: '22:30', end: '07:00', repeat: 'daily', persistent: true },
    { start: '23:00', end: '07:00', repeat: 'daily', persistent: true },
  ],
  at(20, 0),
)
const firstSkipped = overlapping.map((window, index) =>
  index === 0 ? { ...window, skipUntil: windowEndInstant(window, at(23, 30)).toISOString() } : window,
)
equal('skip: the skipped window itself is inert', windowStateAt(at(23, 30), [firstSkipped[0]]).inWindow, false)
equal('skip: the overlapping window is untouched', activeWindow(firstSkipped, at(23, 30))?.start, '23:00')
equal('skip: the range as a whole stays open', windowStateAt(at(23, 30), firstSkipped).inWindow, true)

// Lifecycle of temporary windows.
const twoUses = normalizeWindows([{ start: '09:00', end: '10:00', repeat: 'count', remaining: 2, persistent: false }], at(12, 0))[0]
equal(
  'lifecycle: two uses configured at noon run from tomorrow to the day after',
  [new Date(twoUses.expiresAt).getDate(), new Date(twoUses.expiresAt).getHours()],
  [17, 10],
)
const oneUse = normalizeWindows([{ start: '09:00', end: '10:00', repeat: 'count', remaining: 1, persistent: false }], at(12, 0))[0]
equal('lifecycle: a one-shot window ends with its first future occurrence', [new Date(oneUse.expiresAt).getDate(), new Date(oneUse.expiresAt).getHours()], [16, 10])
const sameDay = normalizeWindows([{ start: '10:00', end: '11:00', repeat: 'today', persistent: false }], at(8, 0))[0]
equal('lifecycle: a today window ends today', [new Date(sameDay.expiresAt).getDate(), new Date(sameDay.expiresAt).getHours()], [15, 11])
const staleToday = normalizeWindows([{ start: '10:00', end: '11:00', repeat: 'today', date: '2026-01-16', persistent: false }], at(8, 0))[0]
equal('lifecycle: a today window on another date expires at once', staleToday.expiresAt, at(8, 0).toISOString())
const dailyTemp = normalizeWindows([{ start: '09:00', end: '10:00', repeat: 'daily', persistent: false }], at(12, 0))[0]
equal('daily: a daily window is always persistent', [dailyTemp.persistent, dailyTemp.expiresAt], [true, undefined])
const todayTemp = normalizeWindows([{ start: '09:00', end: '10:00', repeat: 'today', persistent: false }], at(9, 0))[0]
equal('today: a temporary today window keeps its lifecycle', typeof todayTemp.expiresAt, 'string')
equal('today: a temporary today window is not forced persistent', todayTemp.persistent, false)
equal('lifecycle: a persistent window has no expiry', computeExpiresAt(normalizeWindows([{ start: '09:00', end: '10:00' }])[0], at(12, 0)), null)
equal('lifecycle: an expired temporary window is inert', windowStateAt(new Date(twoUses.expiresAt), [twoUses]).inWindow, false)

// ---------------------------------------------------------------------------
// isConversationEvent / classifyAgent
// ---------------------------------------------------------------------------

equal('event: user message counts', isConversationEvent('user/message'), true)
equal('event: unknown type counts', isConversationEvent('some/unseen-event'), true)
equal('event: plugin record ignored', isConversationEvent('plugin:title'), false)
equal('event: session title ignored', isConversationEvent('session/title-updated'), false)
equal('event: status command ignored', isConversationEvent('command/run'), false)

const graceMs = 10 * 60_000
const now = 1_000_000_000
const base = { now, graceMs, openTurn: true, openStep: false, running: false }
check('agent: closed turn is idle', classifyAgent({ ...base, openTurn: false, lastActivityAt: now }) === null)
check('agent: fresh activity is active', classifyAgent({ ...base, lastActivityAt: now - 60_000 }) === 'recent-activity')
check(
  'agent: running silent step is active',
  classifyAgent({ ...base, openStep: true, running: true, lastActivityAt: now - 60 * 60_000 }) === 'running-step',
)
check(
  'agent: a turn waiting on the user stops blocking after the grace window',
  classifyAgent({ ...base, lastActivityAt: now - graceMs - 1 }) === null,
)

// Per-Agent grace: executing agents need no timer, waiting agents get the full
// window, any other open turn only the short bridge window.
equal(
  'grace: an executing step needs no timer',
  agentGraceMs({ openStep: true, running: true, waitingForUser: true, graceMs, shortGraceMs: 15_000 }),
  0,
)
equal(
  'grace: an Agent waiting on the user keeps the configured window',
  agentGraceMs({ openStep: false, running: false, waitingForUser: true, graceMs, shortGraceMs: 15_000 }),
  graceMs,
)
equal(
  'grace: a turn between steps uses the short window',
  agentGraceMs({ openStep: false, running: true, waitingForUser: false, graceMs, shortGraceMs: 15_000 }),
  15_000,
)
equal(
  'grace: the short window never exceeds the configured one',
  agentGraceMs({ openStep: false, running: false, waitingForUser: false, graceMs: 5_000, shortGraceMs: 15_000 }),
  5_000,
)
equal(
  'grace: an executing Agent ignores activity age',
  classifyAgent({ ...base, openStep: true, running: true, lastActivityAt: now - 3_600_000 }),
  'running-step',
)

// ---------------------------------------------------------------------------
// apply() against a fake Host, in dry-run
// ---------------------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'idle-shutdown-test-'))

/** Build a fake Host and run `apply` on it. */
const startHost = (incoming, statePath) => {
  const config = JSON.parse(JSON.stringify(incoming))
  const sessions = new Map()
  const live = { agents: [], turns: new Map(), jobCalls: 0, turnCalls: 0, inboxes: new Map(), reminders: new Map() }
  const handlers = new Map()
  const disposers = []
  const command = { definition: undefined }
  const saved = []
  const routes = new Map()
  let stored = { ...config }

  const fakeCtx = {
    fiber: { entry: { id: 'idle-shutdown' } },
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener])
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    async waterfall(name, payload, next) {
      const rest = await next()
      if (name !== 'workspace/session-activity') return rest
      const entries = live.reminders.get(String(payload.sessionId)) ?? []
      return [...entries, ...rest]
    },
    inject(_services, callback) {
      const child = {
        effect: (cb) => fakeCtx.effect(cb),
        webServer: {
          register: ({ path, handler }) => {
            routes.set(path, handler)
            return () => routes.delete(path)
          },
        },
        connection: { requestRejection: () => undefined },
      }
      callback(child)
      return () => {}
    },
    get(name) {
      if (name === 'agents') {
        return {
          list: () => live.agents.map((agent) => ({ inbox: live.inboxes.get(String(agent.id)) ?? { nextTurn: [], nextStep: [] }, ...agent })),
          turnBoundaryOf: (session) => {
            live.turnCalls += 1
            return live.turns.get(String(session.id)) ?? { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }
          },
        }
      }
      if (name === 'sessions') return { get: (id) => sessions.get(String(id)) }
      if (name === 'jobs') {
        return {
          list: () => {
            live.jobCalls += 1
            return []
          },
        }
      }
      if (name === 'terminals') return { hasOwnerActivity: () => false }
      if (name === 'commands') return { register: (definition) => { command.definition = definition; return () => {} } }
      if (name === 'configEditor') {
        return {
          edit: async (_entry, change) => {
            const next = { ...stored, ...change(stored) }
            stored = next
            Object.assign(config, next)
            saved.push(next)
          },
        }
      }
      return undefined
    },
  }

  const emit = (event, ...args) => {
    for (const listener of handlers.get(event) ?? []) listener(...args)
  }
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const run = async (verb) => command.definition.handler({ rawInput: verb })
  /** Call one Host route the way the page does. */
  const callPath = async (path, query = '') => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route ${path} is not registered`)
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = `${path}${query}`
    const started = Date.now()
    const res = {
      statusCode: 0,
      text: undefined,
      setHeader() {},
      end(body) {
        this.text = body
      },
    }
    await handler(req, res)
    let parsed
    try {
      parsed = JSON.parse(res.text)
    } catch {
      parsed = undefined
    }
    return { status: res.statusCode, text: res.text, body: parsed, elapsed: Date.now() - started }
  }
  const callRoute = (query = '') => callPath('/idle-shutdown/state', query)

  apply(fakeCtx, config)
  return {
    live,
    sessions,
    command,
    routes,
    callPath,
    callRoute,
    emit,
    state,
    run,
    saved: () => saved,
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Teardown is best effort in the test too.
        }
      }
    },
  }
}

const firstState = join(workdir, 'state-1.json')
const fullDay = { start: '00:00', end: '23:59', repeat: 'daily', persistent: true }
const hostConfig = {
  enabled: true,
  armed: true,
  windows: [fullDay],
  idleMinutes: 0.05,
  warningSeconds: 6,
  tickSeconds: 2,
  waitingGraceMinutes: 10,
  closeLeadSeconds: 1,
  dryRun: true,
  stateFile: firstState,
}

const host = startHost(hostConfig, firstState)
try {
  await sleep(600)
  const booted = host.state()
  equal('host: state file written at activation', booted.pid > 0, true)
  equal('host: switch reported', booted.armed, true)
  equal('host: the full-day window is open', booted.inWindow, true)
  check('host: command registered', host.command.definition?.name === 'idle-shutdown', host.command.definition?.name)

  // Performance: one seed query at activation, then nothing while the idle
  // threshold is far away.
  equal('perf: jobs are seeded once at activation', host.live.jobCalls, 1)

  // Event-driven: a conversation event realigns the idle timer and flushes the
  // status file, without scanning or polling.
  const session = { id: 'session-1', header: { createdAt: Date.now() } }
  host.sessions.set('session-1', session)
  host.live.agents = [{ id: 'session-1' }]
  host.live.turns.set('session-1', {
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  })
  const scanCalls = host.live.jobCalls
  const turnCalls = host.live.turnCalls
  host.emit('session/event', session, { type: 'tool/result', seq: 3, time: Date.now(), data: {} })
  await sleep(900)
  equal('perf: activity alone does not scan', host.live.jobCalls, scanCalls)
  equal('perf: activity does not query turn state', host.live.turnCalls, turnCalls)
  equal('perf: activity marks the tree busy', host.state().active, true)

  // The idle threshold fires from its own timer, and that evaluation is the
  // deep pass: the tree is re-checked before a countdown is ever armed.
  host.emit('agent/status', { agent: { id: 'session-1' }, status: 'idle' })
  await sleep(3600)
  equal('perf: the threshold timer arms the countdown', host.state().pending?.phase, 'countdown')
  // The committed events are the evidence: with nothing tracked as busy the
  // threshold decision needs no authoritative scan at all.
  equal('perf: the threshold decision uses events, not a scan', host.live.turnCalls, turnCalls)
  equal('perf: the threshold decision queries no jobs', host.live.jobCalls, scanCalls)
  await host.run('cancel')
  await sleep(200)
  equal('perf: cancelling clears the countdown', host.state().pending, null)

  const status = await host.run('status')
  check('command: status reports the model', status.text.includes('daily,persistent'), status.text)

  // A countdown is announced in the snapshot, then cancelled by activity.
  const armed = await host.run('now')
  check('command: now starts a countdown', armed.text.includes('countdown started'), armed.text)
  await sleep(150)
  const pendingState = host.state()
  equal('countdown: phase', pendingState.pending?.phase, 'countdown')
  equal('countdown: window recorded', pendingState.pending?.window?.start, '00:00')
  equal('countdown: cancellable', pendingState.pending?.canCancel, true)

  // Performance: a countdown is carried by its own commit timer, so nothing is
  // written while it waits and the snapshot signature stays unchanged.
  const quietWrites = pendingState.stats.writes
  await sleep(2200)
  const afterTick = host.state()
  equal('perf: a waiting countdown does not write', afterTick.stats.writes, quietWrites)

  host.emit('session/event', { id: 'session-1' }, { type: 'user/message', seq: 1, time: Date.now(), data: {} })
  await sleep(150)
  equal('cancel: pending cleared', host.state().pending, null)
  equal('cancel: reason recorded', host.state().lastCancel?.reason, 'conversation activity')

  // Skip: cancel and make this window inert until its range closes.
  await host.run('now')
  await sleep(150)
  const skippedResult = await host.run('skip')
  check('skip: acknowledged', skippedResult.kind === 'success' && skippedResult.text.includes('skipped until'), skippedResult.text)
  await sleep(150)
  const skippedState = host.state()
  equal('skip: pending cleared', skippedState.pending, null)
  equal('skip: recorded in the window list', typeof skippedState.windows[0]?.skipUntil, 'string')
  equal('skip: window is now inert', skippedState.inWindow, false)
  equal('skip: the skip was persisted', typeof host.saved().at(-1)?.windows?.[0]?.skipUntil, 'string')

  // A committed dry run consumes the window and ends without touching the OS.
  const consumedConfig = {
    ...hostConfig,
    stateFile: join(workdir, 'state-commit.json'),
    windows: [{ start: '00:00', end: '23:59', repeat: 'count', remaining: 2, persistent: true }],
    warningSeconds: 2,
    closeLeadSeconds: 0,
  }
  const committer = startHost(consumedConfig, consumedConfig.stateFile)
  try {
    await sleep(300)
    // A commit always verifies the tree authoritatively, even when events say
    // the tree is idle: seed one Session so the probe is observable.
    committer.sessions.set('c1', { id: 'c1', seq: 7, header: { createdAt: Date.now() } })
    committer.live.agents = [{ id: 'c1' }]
    committer.live.turns.set('c1', { openTurnStartSeq: null, lastStepStartSeq: 1, lastStepBoundary: { kind: 'end', seq: 1 }, lastTurn: 1 })
    const commitTurns = committer.live.turnCalls
    await committer.run('now')
    await sleep(3500)
    const committed = committer.state()
    equal('commit: the countdown ended', committed.pending, null)
    equal('commit: the dry run recorded the action', committed.lastAction?.dryRun, true)
    equal('commit: the window was consumed', committer.state().windows[0]?.remaining, 1)
    equal('commit: nothing was executed', committed.dryRunTriggered, true)
    check('commit: the tree is verified authoritatively', committer.live.turnCalls > commitTurns, `${committer.live.turnCalls} vs ${commitTurns}`)
    // The hand-over itself: the last seconds are a bounded system command, and a
    // wake guard was armed before it so the machine cannot fall asleep on it.
    const commitLog = readFileSync(join(workdir, 'dsh-idle-shutdown.log'), 'utf8')
    const commitTail = commitLog.split('\n').slice(-10).join(' | ')
    check('commit: the last seconds are handed to the system', /dry run: shutdown\.exe \/s \/t \d+ /.test(commitLog), commitTail)
    check('commit: the wake guard was armed first', /wake guard (wmi|detached|unconfirmed)/.test(commitLog), commitTail)
  } finally {
    committer.dispose()
  }

  // Busy detection is unchanged.
  host.live.turns.set('session-1', { openTurnStartSeq: 1, lastStepStartSeq: 2, lastStepBoundary: { kind: 'start', seq: 2 }, lastTurn: 1 })
  host.emit('agent/status', { agent: { id: 'session-1' }, status: 'running' })
  host.emit('session/event', session, { type: 'tool/result', seq: 3, time: Date.now(), data: {} })
  await sleep(2600)
  const busy = host.state()
  equal('busy: activity reported', busy.active, true)
  equal('busy: reason', busy.activeReasons.includes('recent-activity:session-1'), true)

} finally {
  host.dispose()
}


// The route and its split revisions, on a quiet Host (a long idle threshold
// keeps the monitor's own timers out of the way).
const routeState = join(workdir, 'state-route.json')
const routeHost = startHost({ ...hostConfig, idleMinutes: 60, warningSeconds: 60, stateFile: routeState }, routeState)
try {
  await sleep(400)
  const plain = await routeHost.callRoute()
  equal('route: GET answers', plain.status, 200)
  check(
    'route: both revisions are reported',
    Number.isFinite(plain.body?.revision?.config) && Number.isFinite(plain.body?.revision?.runtime),
    JSON.stringify(plain.body?.revision),
  )
  equal('route: the snapshot travels with the revisions', plain.body?.state?.armed, true)
  const stale = await routeHost.callRoute('?wait=2000&sinceConfig=-1&sinceRuntime=-1')
  check('route: a stale caller returns at once', stale.elapsed < 500, `${stale.elapsed}ms`)

  const since = plain.body.revision
  const bounded = await routeHost.callRoute(`?wait=600&sinceConfig=${since.config}&sinceRuntime=${since.runtime}`)
  check('route: a current caller waits for its bound', bounded.elapsed >= 550, `${bounded.elapsed}ms`)
  equal('route: nothing changed meanwhile', bounded.body.revision.config, since.config)

  const waiting = routeHost.callRoute(`?wait=5000&sinceConfig=${since.config}&sinceRuntime=${since.runtime}`)
  await sleep(200)
  await routeHost.run('on')
  const woken = await waiting
  check('route: a config change wakes the waiter early', woken.elapsed < 3000, `${woken.elapsed}ms`)
  check('route: the config revision moved', woken.body.revision.config > since.config, `${woken.body.revision.config} vs ${since.config}`)
  equal('route: the runtime revision stayed put', woken.body.revision.runtime, since.runtime)

  const chunk = await routeHost.callPath('/idle-shutdown/settings.js')
  equal('route: the settings chunk answers', chunk.status, 200)
  check('route: the chunk is a JavaScript module', String(chunk.text).includes('export default function createSettingsPage'), 'unexpected chunk body')
} finally {
  routeHost.dispose()
}
// Queued input counts as work: an Agent whose input waits for the next turn
// has produced no event, so the event stream alone cannot see it.
const queuedState = join(workdir, 'state-queued.json')
const queued = startHost(
  {
    ...hostConfig,
    windows: [{ start: '00:00', end: '23:59', repeat: 'daily', persistent: true }],
    idleMinutes: 0.05,
    warningSeconds: 6,
    stateFile: queuedState,
  },
  queuedState,
)
try {
  await sleep(400)
  queued.sessions.set('q1', { id: 'q1', seq: 3, header: { createdAt: Date.now() } })
  queued.live.agents = [{ id: 'q1' }]
  queued.live.turns.set('q1', { openTurnStartSeq: null, lastStepStartSeq: 1, lastStepBoundary: { kind: 'end', seq: 1 }, lastTurn: 1 })
  queued.live.inboxes.set('q1', { nextTurn: [{ role: 'user' }], nextStep: [] })

  // The threshold timer fires while the input is still queued: the tree counts
  // as busy, so no countdown may start.
  await sleep(4200)
  const busyState = queued.state()
  equal('queued input: the Agent counts as active', busyState.active, true)
  check('queued input: the reason is reported', busyState.activeReasons.includes('pending-input:q1'), JSON.stringify(busyState.activeReasons))
  equal('queued input: the count is reported', busyState.pendingInput, 1)
  equal('queued input: no countdown starts', busyState.pending, null)

  // The queued input keeps the idle clock fresh, so the tree is still not idle.
  equal('queued input: the idle clock keeps running', busyState.idleSeconds < 10, true)

  // Once the input is consumed, the tree may go idle and arm the countdown.
  queued.live.inboxes.set('q1', { nextTurn: [], nextStep: [] })
  await sleep(4200)
  equal('queued input: the tree is idle again', queued.state().active, false)
  equal('queued input: a countdown may now start', queued.state().pending?.phase, 'countdown')
  await queued.run('cancel')
} finally {
  queued.dispose()
}
// Armed reminders are recorded, never obeyed: a reminder stays armed long after
// the AI finished, so it must not keep the machine on.
const reminderState = join(workdir, 'state-reminder.json')
const reminder = startHost(
  {
    ...hostConfig,
    windows: [{ start: '00:00', end: '23:59', repeat: 'daily', persistent: true }],
    idleMinutes: 0.05,
    warningSeconds: 6,
    stateFile: reminderState,
  },
  reminderState,
)
try {
  await sleep(400)
  reminder.sessions.set('r1', { id: 'r1', seq: 4, header: { createdAt: Date.now() } })
  reminder.live.agents = [{ id: 'r1' }]
  reminder.live.turns.set('r1', { openTurnStartSeq: null, lastStepStartSeq: 1, lastStepBoundary: { kind: 'end', seq: 1 }, lastTurn: 1 })
  reminder.live.reminders.set('r1', [{ kind: 'schedule', items: [{ id: 's-1', label: 'nightly report' }] }])

  // The reminder does not make the tree busy: the countdown may still start.
  await sleep(4200)
  const busyState = reminder.state()
  equal('reminder: the tree is not busy', busyState.active, false)
  equal('reminder: the countdown still starts', busyState.pending?.phase, 'countdown')

  // The commit records which reminders were armed.
  await sleep(6000)
  const committed = reminder.state()
  check('reminder: the armed reminders are recorded', Array.isArray(committed.lastReminders?.sessions), JSON.stringify(committed.lastReminders))
  equal('reminder: the session is named', committed.lastReminders?.sessions?.[0]?.session, 'r1')
  equal('reminder: the count is reported', committed.lastReminders?.sessions?.[0]?.count, 1)
  equal('reminder: the label is reported', committed.lastReminders?.sessions?.[0]?.items?.[0], 'nightly report')
} finally {
  reminder.dispose()
}
// Scan shortcuts: parents-first with early exit, and no re-probe while a
// Session's log offset stays put.
const shortcutState = join(workdir, 'state-shortcut.json')
const shortcut = startHost(
  { ...hostConfig, windows: [{ start: '00:00', end: '23:59', repeat: 'daily', persistent: true }], stateFile: shortcutState },
  shortcutState,
)
try {
  await sleep(400)
  shortcut.sessions.set('p', { id: 'p', seq: 10, header: { createdAt: Date.now() } })
  shortcut.sessions.set('c', { id: 'c', seq: 20, header: { createdAt: Date.now(), parentSession: 'p', delegationDepth: 1, origin: 'subagent' } })
  shortcut.live.agents = [{ id: 'p' }, { id: 'c' }]
  shortcut.live.turns.set('p', { openTurnStartSeq: 1, lastStepStartSeq: 1, lastStepBoundary: { kind: 'start', seq: 1 }, lastTurn: 1 })
  shortcut.live.turns.set('c', { openTurnStartSeq: 1, lastStepStartSeq: 1, lastStepBoundary: { kind: 'start', seq: 1 }, lastTurn: 1 })
  shortcut.emit('agent/status', { agent: { id: 'p' }, status: 'running' })
  shortcut.emit('session/event', { id: 'p' }, { type: 'tool/call', seq: 2, time: Date.now(), data: {} })

  const probesBefore = shortcut.live.turnCalls
  await shortcut.run('status')
  equal('scan: the walk stops at the first busy parent', shortcut.live.turnCalls - probesBefore, 1)

  // A busy parent with an unchanged log covers its subtree: no probe at all.
  const secondBefore = shortcut.live.turnCalls
  await shortcut.run('status')
  equal('scan: a busy parent stops the walk before the child', shortcut.live.turnCalls - secondBefore, 0)

  const thirdBefore = shortcut.live.turnCalls
  await shortcut.run('status')
  equal('scan: unchanged log offsets are not re-probed', shortcut.live.turnCalls - thirdBefore, 0)

  // Once the parent finishes, the child is finally read (still busy there).
  shortcut.live.turns.set('p', { openTurnStartSeq: null, lastStepStartSeq: 3, lastStepBoundary: { kind: 'end', seq: 3 }, lastTurn: 1 })
  shortcut.sessions.set('p', { id: 'p', seq: 11, header: { createdAt: Date.now() } })
  shortcut.emit('agent/status', { agent: { id: 'p' }, status: 'idle' })
  shortcut.emit('session/event', { id: 'p' }, { type: 'turn/end', seq: 3, time: Date.now(), data: {} })
  const fourthBefore = shortcut.live.turnCalls
  await shortcut.run('status')
  equal('scan: an idle parent lets the child be read', shortcut.live.turnCalls - fourthBefore >= 1, true)
} finally {
  shortcut.dispose()
}
// Retention: leftovers from a crashed run and old log generations are removed
// at startup, and the log rotates into at most logMaxFiles generations.
const persistDir = mkdtempSync(join(tmpdir(), 'idle-shutdown-files-'))
{
  const stateName = 'dsh-idle-shutdown-state.json'
  const logName = 'dsh-idle-shutdown.log'
  const old = new Date(Date.now() - 3 * 60 * 60_000)
  for (const index of [1, 2, 3, 4]) writeFileSync(join(persistDir, `${logName}.${index}`), 'x'.repeat(16))
  writeFileSync(join(persistDir, `${stateName}.999.tmp`), 'old')
  utimesSync(join(persistDir, `${stateName}.999.tmp`), old, old)
  writeFileSync(join(persistDir, `${stateName}.111.tmp`), 'fresh')
  writeFileSync(join(persistDir, 'keep-me.txt'), 'foreign')

  const persistState = join(persistDir, stateName)
  const retain = startHost(
    { ...hostConfig, windows: [{ start: '00:00', end: '23:59', repeat: 'daily', persistent: true }], stateFile: persistState, logMaxKB: 1, logMaxFiles: 3, tempMaxAgeMinutes: 60 },
    persistState,
  )
  try {
    await sleep(500)
    const cleaned = retain.state()
    equal('retention: an old atomic-write leftover is removed', existsSync(join(persistDir, `${stateName}.999.tmp`)), false)
    equal('retention: a fresh leftover is kept', existsSync(join(persistDir, `${stateName}.111.tmp`)), true)
    equal('retention: log generations beyond the cap are removed', existsSync(join(persistDir, `${logName}.4`)), false)
    equal('retention: generations within the cap stay', existsSync(join(persistDir, `${logName}.3`)), true)
    equal('retention: a foreign file is never touched', existsSync(join(persistDir, 'keep-me.txt')), true)
    check('retention: the removal is recorded', Array.isArray(cleaned.lastCleanup?.removed) && cleaned.lastCleanup.removed.length >= 2, JSON.stringify(cleaned.lastCleanup))
    equal('retention: the inventory reports the limits', cleaned.files?.limits?.logMaxKB, 1)
    equal('retention: the inventory reports the directory', cleaned.files?.dir, persistDir)

    // Rotation: pre-fill the log past the limit, then append one line.
    writeFileSync(join(persistDir, logName), 'y'.repeat(2048))
    const armReply = await retain.run('now')
    check('rotation: the trigger is accepted', armReply.kind === 'success', String(armReply.text))
    await sleep(200)
    equal('rotation: the previous log is kept as generation 1', existsSync(join(persistDir, `${logName}.1`)), true)
    check('rotation: the fresh log restarts small', (readFileSync(join(persistDir, logName), 'utf8').length) < 2048, 'log did not rotate')
  } finally {
    retain.dispose()
  }
}
// A disarmed Host does no monitoring at all — no timer, no listeners.
const offState = join(workdir, 'state-off.json')
const disarmed = startHost({ ...hostConfig, armed: false, stateFile: offState }, offState)
try {
  await sleep(600)
  equal('switch off: nothing is monitored', disarmed.state().monitoring, false)
  const stamped = disarmed.state().updatedAt
  disarmed.emit('session/event', { id: 'session-1' }, { type: 'user/message', seq: 1, time: Date.now(), data: {} })
  await sleep(2300)
  equal('switch off: the status file does not tick', disarmed.state().updatedAt, stamped)
  equal('switch off: events are not tracked', disarmed.state().active, false)
  await disarmed.run('on')
  await sleep(400)
  equal('switch on: monitoring starts', disarmed.state().monitoring, true)
  await disarmed.run('off')
  await sleep(300)
  equal('switch off again: monitoring stops', disarmed.state().monitoring, false)
  equal('switch off again: listeners are gone', disarmed.state().active, false)
} finally {
  disarmed.dispose()
}

// A Host whose window is closed must never act.
const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
const fmt = (minutes) => `${String(Math.floor((((minutes % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const secondState = join(workdir, 'state-2.json')
const gated = startHost(
  {
    ...hostConfig,
    windows: [{ start: fmt(nowMinutes + 120), end: fmt(nowMinutes + 180), repeat: 'daily', persistent: true }],
    stateFile: secondState,
  },
  secondState,
)
try {
  await sleep(600)
  const gatedState = gated.state()
  equal('window: outside the configured window', gatedState.inWindow, false)
  check('window: opening time is reported', typeof gatedState.opensInMinutes === 'number' && gatedState.opensInMinutes > 90, String(gatedState.opensInMinutes))
  const blockedNow = await gated.run('now')
  equal('window: an explicit trigger is blocked', blockedNow.kind, 'error')
  check('window: the reply names the window', blockedNow.text.includes('outside every time window'), blockedNow.text)
  await sleep(2500)
  equal('window: no countdown outside the window', gated.state().pending, null)
} finally {
  gated.dispose()
  // The commit scenario now arms the real wake guard on Windows, and its helper
// may still be writing its marker when the scenario ends; retry briefly instead
// of failing the run on a sharing violation.
rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)