/**
 * Browser half of `dsh-idle-shutdown`.
 *
 * Owns everything the user touches:
 * - the title-bar button left of the system minimize button: a power switch,
 *   which becomes an undo button while a countdown runs (with a menu to cancel
 *   or to cancel and skip the rest of the current window);
 * - the Settings page that edits the windows (time range, repeat, temporary vs
 *   persistent);
 * - the notification raised when a countdown starts.
 *
 * The Host owns every judgement about conversations, idle time, windows and the
 * power action; this half only reads `GET /idle-shutdown/state` and posts
 * changes to it.
 *
 * @module dsh-idle-shutdown/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-idle-shutdown',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and settings section key. */
    const NS = 'idle-shutdown'
    /** The Host route both halves spell the same way. */
    const STATE_PATH = '/idle-shutdown/state'
    const TITLE_CSS = `
.isw-titlebar {
  position: fixed;
  top: env(titlebar-area-y, 0px);
  right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)));
  width: 46px;
  height: env(titlebar-area-height, 40px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  z-index: 2147483000;
  transition: background 120ms ease, color 120ms ease;
}
.isw-titlebar:hover { background: rgba(128, 128, 128, 0.18); }
.isw-titlebar:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.isw-titlebar[data-on='true'] { color: var(--dsw-alias-brand-primary); }
.isw-titlebar[data-on='false'] { color: var(--dsw-alias-state-idle-primary); }
.isw-titlebar[data-mode='undo'] { color: var(--dsw-alias-state-warn-primary); }
.isw-titlebar[data-committing='true'] { color: var(--dsw-alias-brand-primary); }
/* The phase shown while the countdown is already in the system's hands. */
.isw-titlebar-fill {
  position: absolute;
  left: 5px;
  right: 5px;
  bottom: 3px;
  height: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-brand-primary);
  transform-origin: left center;
  pointer-events: none;
}
.isw-titlebar[data-open='true'] { background: rgba(128, 128, 128, 0.22); }
.isw-titlebar[disabled] { cursor: default; opacity: 0.6; }
.isw-popover {
  position: fixed;
  top: calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 40px) + 6px);
  right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)) + 4px);
  width: 260px;
  box-sizing: border-box;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  z-index: 2147483001;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  font-size: 12px;
  line-height: 1.5;
}
.isw-popover-title { font-weight: 600; margin: 0 0 2px; }
.isw-popover-body { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); }
.isw-popover-actions { display: flex; flex-direction: column; gap: 6px; }
.isw-popover button {
  font: inherit;
  text-align: left;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.isw-popover button:hover { background: var(--dsw-alias-bg-layer-2); }
.isw-popover button[data-primary='true'] { border-color: var(--dsw-alias-state-warn-primary); }
.isw-popover button:disabled { opacity: 0.5; cursor: default; }
`

    const zh = {
      'loading': '加载中…',
      nav: '空闲关机',
      title: '空闲关机',
      'switch.label': '指定时间段无活跃对话时关闭电脑',
      'switch.on': '已开启',
      'switch.off': '已关闭',
      'titlebar.on': '空闲关机：已开启。点击关闭。',
      'titlebar.off': '空闲关机：已关闭。点击开启。',
      'undo.title': '即将关机',
      'undo.body': '将在 {seconds} 秒后关闭 DSH 并{action}。',
      'undo.cancel': '撤销此次关机',
      'undo.skip': '撤销并跳过本时间段',
      'undo.skipHint': '跳过当前时间段，直到它结束都不会再触发。',
      'undo.noWindow': '本次没有对应的时间段，只能撤销。',
      'undo.tooLate': '已经开始执行，无法撤销。',
      'undo.final': '还剩 {seconds} 秒可撤销，之后最后几秒交给系统关机命令。',
      'committing.title': '正在执行',
      'committing.body': '最后 {seconds} 秒由系统关机命令执行，已无法撤销。',
      'undo.undo': '撤销',
      'notify.title': '空闲关机将在 {seconds} 秒后执行',
      'notify.body': '点击标题栏的撤销按钮可以取消，或跳过本时间段。',
      'windows.title': '允许关机的时间段',
      'windows.hint': '只有落在下列时间段内才可能关机。跨零点直接写，例如 23:00 到 07:00；没有时间段表示全天生效。',
      'timing.title': '触发条件',
      'timing.idle': '空闲等待（分钟）',
      'timing.idleHint': '所有对话持续空闲多久后才开始倒计时，例如 10 表示空闲 10 分钟。最小 0.05（3 秒，仅测试）。',
      'timing.warning': '倒计时（秒）',
      'timing.warningHint': '倒计时期间标题栏按钮会变成撤销按钮，点击可取消或跳过本时间段。',
      'timing.grace': '最后几秒交给系统（不可撤销）',
      'timing.graceHint': '倒计时最后 N 秒会交给系统关机命令，这几秒无法撤销，用来保证 DSH 关闭后关机仍然发生；默认 3 秒。',
      'windows.note.inert': '已失效，重新选择即激活',
      'windows.reactivatePick': '已失效：重新选择重复方式即可重新激活',
      'windows.add': '添加时间段',
      'windows.remove': '删除',
      'windows.start': '开始',
      'windows.end': '结束',
      'windows.repeat': '重复',
      'windows.repeat.daily': '每天',
      'windows.repeat.today': '仅今天',
      'windows.repeat.count': '限次数',
      'windows.count': '次数',
      'windows.persist.persistent': '持久',
      'windows.persist.temporary': '临时',
      'windows.persist.dailyForced': '「每天」固定为持久；改成「今天」或「限次数」后可选临时/持久',
      'windows.note.today': '仅在 {date} 生效',
      'windows.note.count': '还剩 {remaining} 次',
      'windows.note.used': '今天已执行',
      'windows.note.skipped': '本次已跳过，直到 {until}',
      'windows.note.temporary': '执行一次后自动删除',
      'windows.note.persistent': '执行后保留在列表中',
      'windows.empty': '当前没有时间段：全天生效。',
      'action.save': '保存',
      'action.reset': '还原',
      'action.cancel': '取消',
      'action.restoreDefaults': '还原默认',
      'action.retry': '重新读取',
      'status.title': '当前状态',
      'status.idle': '空闲',
      'status.busy': '有活跃对话',
      'status.window.yes': '在时间段内',
      'status.window.no': '不在时间段内',
      'status.next': '下一个时间段在 {minutes} 分钟后开始',
      'status.pending': '倒计时进行中：{seconds} 秒后{action}',
      'status.switchOff': '开关关闭：不会执行任何操作',
      'status.notMonitoring': '未监控（开关关闭时不做任何检查）',
      'status.action.shutdown': '关机',
      'status.action.restart': '重启',
      'status.action.hibernate': '休眠',
      'status.action.sleep': '睡眠',
      'status.action.custom': '执行自定义命令',
      'saved': '已保存',
      'error.load': '无法读取主机状态',
      'error.chunk': '设置页加载失败，请刷新页面后重试',
      'error.save': '保存失败',
    }

    const en = {
      'loading': 'Loading…',
      nav: 'Idle shutdown',
      title: 'Idle shutdown',
      'switch.label': 'Shut the PC down when conversations are idle inside the set windows',
      'switch.on': 'On',
      'switch.off': 'Off',
      'titlebar.on': 'Idle shutdown: on. Click to turn off.',
      'titlebar.off': 'Idle shutdown: off. Click to turn on.',
      'undo.title': 'Shutdown pending',
      'undo.body': 'DSH will quit and {action} in {seconds}s.',
      'undo.cancel': 'Cancel this shutdown',
      'undo.skip': 'Cancel and skip this window',
      'undo.skipHint': 'The current window will not fire again until it ends.',
      'undo.noWindow': 'No window applies to this run, so it can only be cancelled.',
      'undo.tooLate': 'Already committing; it can no longer be cancelled.',
      'undo.final': '{seconds}s left to cancel; the last seconds then belong to the system shutdown command.',
      'committing.title': 'Committing',
      'committing.body': 'The last {seconds}s run inside the system shutdown command; it can no longer be cancelled.',
      'undo.undo': 'Undo',
      'notify.title': 'Idle shutdown in {seconds}s',
      'notify.body': 'Use the undo button in the title bar to cancel or to skip this window.',
      'windows.title': 'Windows that allow the power action',
      'timing.title': 'Trigger',
      'timing.idle': 'Idle wait (minutes)',
      'timing.idleHint': 'How long every conversation must stay idle before the countdown starts; 10 means ten idle minutes. Minimum 0.05 (3 s, testing only).',
      'timing.warning': 'Countdown (seconds)',
      'timing.warningHint': 'While it runs, the title-bar button becomes the undo button for cancelling or skipping this window.',
      'timing.grace': 'Final seconds owned by the system',
      'timing.graceHint': 'The last N seconds run inside the system shutdown command, so they can no longer be undone; that is what keeps the action alive once DSH is closed. Default 3 s.',
      'windows.note.inert': 'inactive - pick a repeat type to re-activate',
      'windows.reactivatePick': 'Inactive: pick a repeat type to re-activate it',
      'windows.hint': 'The action can only fire inside these ranges. Write an overnight range directly, such as 23:00 to 07:00. No range means all day.',
      'windows.add': 'Add window',
      'windows.remove': 'Remove',
      'windows.start': 'Start',
      'windows.end': 'End',
      'windows.repeat': 'Repeat',
      'windows.repeat.daily': 'Every day',
      'windows.repeat.today': 'Today only',
      'windows.repeat.count': 'Limited times',
      'windows.count': 'Times',
      'windows.persist.persistent': 'Persistent',
      'windows.persist.temporary': 'Temporary',
      'windows.persist.dailyForced': 'A daily window is always persistent; switch to Today or Limited times to choose.',
      'windows.note.today': 'Only on {date}',
      'windows.note.count': '{remaining} use(s) left',
      'windows.note.used': 'Already used today',
      'windows.note.skipped': 'Skipped until {until}',
      'windows.note.temporary': 'Removed after it fires once',
      'windows.note.persistent': 'Kept after it fires',
      'windows.empty': 'No windows: the action may fire all day.',
      'action.save': 'Save',
      'action.reset': 'Reset',
      'action.cancel': 'Cancel',
      'action.restoreDefaults': 'Restore defaults',
      'action.retry': 'Retry',
      'status.title': 'Current state',
      'status.idle': 'idle',
      'status.busy': 'conversation active',
      'status.window.yes': 'inside a window',
      'status.window.no': 'outside every window',
      'status.next': 'the next window opens in {minutes} min',
      'status.pending': 'countdown running: {action} in {seconds}s',
      'status.switchOff': 'switch off: nothing will happen',
      'status.notMonitoring': 'not monitoring (nothing runs while the switch is off)',
      'status.action.shutdown': 'shut down',
      'status.action.restart': 'restart',
      'status.action.hibernate': 'hibernate',
      'status.action.sleep': 'sleep',
      'status.action.custom': 'run the custom command',
      'saved': 'Saved',
      'error.load': 'Cannot read the Host state',
      'error.chunk': 'The settings page failed to load; refresh to retry',
      'error.save': 'Could not save',
    }

    /** Read the Host snapshot (the route also reports its revision). */
    const readState = async () => {
      const response = await fetch(STATE_PATH, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return body?.state ?? body
    }

    /**
     * One long-poll stream shared by every mounted consumer.
     *
     * The Host holds each request for up to 25 seconds and answers the moment
     * something changes, so the page needs no polling loop and reacts at once
     * when the switch is flipped elsewhere (a command, another window). While a
     * countdown runs the wait shrinks so the seconds stay live.
     */
    const streamListeners = new Set()
    let streamSnapshot = null
    // Mirrors the Host's two revisions; a request holds until either moves.
    let streamRevisions = { config: -1, runtime: -1 }
    let streamRunning = false
    let streamController = null
    let streamFailures = 0
    let streamNoRevision = false

    const streamDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const streamOnce = async (waitMs) => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      streamController = controller
      let timedOut = false
      const guard = controller === null ? null : setTimeout(() => {
        timedOut = true
        controller.abort()
      }, waitMs + 5000)
      try {
        const response = await fetch(
          `${STATE_PATH}?wait=${waitMs}&sinceConfig=${streamRevisions.config}&sinceRuntime=${streamRevisions.runtime}`,
          { cache: 'no-store', signal: controller?.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        const next = body?.state ?? body
        const nextRevision = body?.revision ?? {}
        const config = Number(nextRevision.config)
        const runtime = Number(nextRevision.runtime)
        streamNoRevision = !Number.isFinite(config) || !Number.isFinite(runtime)
        if (!streamNoRevision) streamRevisions = { config, runtime }
        streamSnapshot = next
        streamFailures = 0
        for (const listener of [...streamListeners]) listener(next)
        return true
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') return true
        streamFailures = Math.min(5, streamFailures + 1)
        return false
      } finally {
        if (guard !== null) clearTimeout(guard)
        streamController = null
      }
    }

    const streamLoop = async () => {
      if (streamRunning) return
      streamRunning = true
      while (streamListeners.size > 0) {
        const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible'
        const pendingNow = streamSnapshot?.pending !== null && streamSnapshot?.pending !== undefined
        // Two failures in a row mean long-polling is not viable here (a proxy or
        // the fetch layer cutting the request), so fall back to plain polling.
        const waitMs = streamFailures >= 2 ? 0 : pendingNow ? 1500 : hidden ? 60_000 : 25_000
        const ok = await streamOnce(waitMs)
        if (!ok) await streamDelay(Math.min(30_000, 1000 * 2 ** streamFailures))
        // Without a revision the Host answers at once; keep the loop gentle.
        else if (streamNoRevision || streamFailures >= 2) await streamDelay(streamFailures >= 2 ? 15_000 : 5000)
      }
      streamRunning = false
    }

    /** Subscribe to live Host snapshots; returns the unsubscribe function. */
    const subscribeState = (listener) => {
      streamListeners.add(listener)
      if (streamSnapshot !== null) listener(streamSnapshot)
      if (!streamRunning) streamLoop()
      return () => {
        streamListeners.delete(listener)
        if (streamListeners.size === 0 && streamController !== null) streamController.abort?.()
      }
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && streamController !== null) streamController.abort?.()
      })
    }

    /** Persist a change and return the Host's refreshed snapshot. */
    const writeState = async (patch) => {
      const response = await fetch(STATE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload.state
    }

    /** The power glyph of the switch state. */
    function PowerGlyph({ on }) {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M8 1.6v6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', {
          d: 'M4.7 4.3a4.9 4.9 0 1 0 6.6 0',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          opacity: on ? 1 : 0.75,
        }),
      )
    }

    /** The undo glyph shown while a countdown runs. */
    function UndoGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M3.2 7.4h6.1a3.3 3.3 0 1 1 0 6.6H6.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5.6 4.4 2.8 7.4l2.8 2.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** The action's human name for notifications and the popover. */
    const actionLabel = (t, action) => {
      if (action === 'shutdown') return t('status.action.shutdown')
      if (action === 'restart') return t('status.action.restart')
      if (action === 'hibernate') return t('status.action.hibernate')
      if (action === 'sleep') return t('status.action.sleep')
      return t('status.action.custom')
    }

    /** One-line human summary of the Host snapshot. */
    function describe(t, snapshot) {
      const parts = [snapshot.active ? t('status.busy') : t('status.idle')]
      parts.push(snapshot.inWindow ? t('status.window.yes') : t('status.window.no'))
      if (!snapshot.armed) parts.push(t('status.switchOff'))
      if (snapshot.pending) {
        parts.push(t('status.pending').replace('{seconds}', String(snapshot.pending.remainingSeconds)).replace('{action}', actionLabel(t, snapshot.pending.action)))
      }
      return parts.join(' · ')
    }

    /**
     * Title-bar control: a power switch, or the undo button plus its menu while
     * a countdown runs.
     */
    function TitleBarButton({ t }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const notifiedRef = React.useRef(null)

      // One shared long-poll stream feeds this switch and the Settings page.
      React.useEffect(() => subscribeState((next) => setSnapshot(next)), [])

      // Raise one system notification per countdown.
      React.useEffect(() => {
        const pending = snapshot?.pending
        if (!pending) {
          notifiedRef.current = null
          return
        }
        const key = pending.dueAt
        if (notifiedRef.current === key) return
        notifiedRef.current = key
        try {
          if (typeof Notification === 'undefined') return
          if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
          if (Notification.permission !== 'granted') return
          const note = new Notification(t('notify.title').replace('{seconds}', String(pending.remainingSeconds)), {
            body: t('notify.body'),
            silent: false,
          })
          note.onclick = () => window.focus()
        } catch {
          // A missing notification permission is not an error worth surfacing.
        }
      }, [snapshot, t])

      // Close the menu on an outside press or Escape.
      React.useEffect(() => {
        if (!menuOpen) return
        const onDown = (event) => {
          if (event.target instanceof Element && event.target.closest('.isw-popover') !== null) return
          if (event.target instanceof Element && event.target.closest('.isw-titlebar') !== null) return
          setMenuOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [menuOpen])

      const styleElement = React.useMemo(() => h('style', null, TITLE_CSS), [])
      const pending = snapshot?.pending ?? null
      // The last seconds belong to the system command: from that point the undo
      // button turns back into the switch, and the phase is shown as progress.
      const canCancel = pending !== null && pending.canCancel === true
      const committing = pending !== null && !canCancel
      const mode = canCancel ? 'undo' : 'switch'
      const on = snapshot?.armed === true

      // The stream only moves on state changes, so the final seconds get a local
      // tick: the progress (and any remaining-seconds text) keeps moving without
      // asking the Host anything.
      const [clockAt, setClockAt] = React.useState(() => Date.now())
      const dueAt = pending === null ? null : Date.parse(pending.dueAt)
      React.useEffect(() => {
        if (dueAt === null || Number.isNaN(dueAt)) return undefined
        const timer = setInterval(() => setClockAt(Date.now()), 500)
        return () => clearInterval(timer)
      }, [dueAt])
      const secondsLeft =
        dueAt === null || Number.isNaN(dueAt) ? 0 : Math.max(0, Math.round((dueAt - clockAt) / 1000))
      const graceSeconds = committing ? Math.max(1, Number(pending.graceSeconds) || 0) : 0
      const progress = graceSeconds > 0 ? Math.min(1, Math.max(0, secondsLeft / graceSeconds)) : 0

      // A phase change invalidates the undo menu it was opened for.
      React.useEffect(() => {
        if (!canCancel) setMenuOpen(false)
      }, [canCancel])

      const toggleSwitch = async () => {
        if (busy || snapshot === null) return
        setBusy(true)
        try {
          setSnapshot(await writeState({ armed: !on }))
        } catch {
          // Keep showing the last known truth.
        } finally {
          setBusy(false)
        }
      }

      const sendCommand = async (command) => {
        if (busy) return
        setBusy(true)
        try {
          setSnapshot(await writeState({ command }))
          setMenuOpen(false)
        } catch {
          // The Host answers 409 when the commit already started; refresh then.
          try {
            setSnapshot(await readState())
          } catch {}
        } finally {
          setBusy(false)
        }
      }

      const caption =
        snapshot === null
          ? undefined
          : canCancel
            ? `${t('undo.title')} · ${describe(t, snapshot)}`
            : committing
              ? `${t('committing.title')} · ${t('committing.body').replace('{seconds}', String(secondsLeft))}`
              : `${t(on ? 'titlebar.on' : 'titlebar.off')}\n${describe(t, snapshot)}`

      return h(
        React.Fragment,
        null,
        styleElement,
        h(
          'button',
          {
            type: 'button',
            key: 'button',
            className: 'isw-titlebar',
            'data-on': on ? 'true' : 'false',
            'data-mode': mode,
            'data-committing': committing ? 'true' : 'false',
            'data-open': menuOpen ? 'true' : 'false',
            'aria-pressed': mode === 'switch' ? on : menuOpen,
            'aria-label': mode === 'switch' ? t('switch.label') : t('undo.undo'),
            title: caption,
            disabled: busy || snapshot === null,
            onClick: () => {
              if (mode === 'undo') setMenuOpen((open) => !open)
              else toggleSwitch()
            },
          },
          mode === 'undo' ? h(UndoGlyph) : h(PowerGlyph, { on }),
          // Even though the button is a switch again, the phase stays visible.
          committing
            ? h('span', {
                className: 'isw-titlebar-fill',
                style: { transform: `scaleX(${Math.max(0, Math.min(1, progress)).toFixed(3)})` },
              })
            : null,
        ),
        menuOpen && pending !== null
          ? h(
              'div',
              { className: 'isw-popover', key: 'menu' },
              h('p', { className: 'isw-popover-title' }, t('undo.title')),
              h(
                'p',
                { className: 'isw-popover-body' },
                t('undo.body')
                  .replace('{seconds}', String(pending.remainingSeconds))
                  .replace('{action}', actionLabel(t, pending.action)),
              ),
              // The tail of the countdown belongs to the system command and can no
              // longer be taken back; say so before the undo button stops working.
              pending.graceSeconds > 0
                ? h(
                    'p',
                    { className: 'isw-popover-body' },
                    pending.canCancel
                      ? t('undo.final').replace('{seconds}', String(pending.cancelSeconds ?? 0))
                      : t('undo.tooLate'),
                  )
                : null,
              h(
                'div',
                { className: 'isw-popover-actions' },
                h(
                  'button',
                  { type: 'button', 'data-primary': 'true', disabled: busy || !pending.canCancel, onClick: () => sendCommand('cancel') },
                  t('undo.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || !pending.canCancel || pending.window === null,
                    title: pending.window === null ? t('undo.noWindow') : t('undo.skipHint'),
                    onClick: () => sendCommand('skip'),
                  },
                  t('undo.skip'),
                ),
                pending.canCancel ? null : h('span', { className: 'isw-hint' }, t('undo.tooLate')),
              ),
            )
          : null,
      )
    }

    /**
     * The action bar, pinned to the bottom of the panel that scrolls this page.
     *
     * `position: sticky` is not reliable here: the element that scrolls is the
     * settings column above this section, not the section itself. Measuring that
     * column and pinning with `position: fixed` keeps the bar still while the
     * content scrolls, whatever the column contains. A spacer keeps the last
     * rows reachable behind it.
     *
     * The pin is recomputed only when the geometry actually changes, so drag
     * scrolling costs a few `getBoundingClientRect` reads and no re-renders.
     */
    /** Minimal shell shown while the settings chunk loads. */
    const PAGE_SHELL_CSS = `
.isw-loading {
  padding: 28px 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}
`

    /** Load the Settings page chunk once; a failure resets so a retry works. */
    let settingsChunk = null
    const loadSettingsPage = () => {
      if (settingsChunk === null) {
        settingsChunk = import('/idle-shutdown/settings.js')
          .then((module) => module.default({ React, h, subscribeState, readState, writeState, actionLabel }))
          .catch((error) => {
            settingsChunk = null
            throw error
          })
      }
      return settingsChunk
    }

    /**
     * Settings section entry point: a thin shell that pulls the page chunk.
     *
     * Keeping the heavy page out of the startup bundle means the title-bar
     * switch and the stream start before it is parsed; a load failure degrades
     * to a short message instead of an empty section.
     */
    function SettingsSection({ t }) {
      const [Page, setPage] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        loadSettingsPage()
          .then((factory) => {
            if (alive) setPage(() => factory)
          })
          .catch((error) => {
            console.warn('[idle-shutdown] the settings chunk failed to load:', error)
            if (alive) setFailed(true)
          })
        return () => {
          alive = false
        }
      }, [])
      if (Page === null) {
        return h(
          'div',
          { className: 'isw-page' },
          h('style', null, PAGE_SHELL_CSS),
          h('div', { className: 'isw-loading' }, t(failed ? 'error.chunk' : 'loading')),
        )
      }
      return h(Page, { t })
    }

    function NavGlyph() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true, focusable: false },
        h('circle', { cx: 9, cy: 9, r: 6.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M9 5.4V9l2.6 1.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'idle-shutdown: dictionaries')
        const t = ctx.locale.bind(NS)

        const isDesktop = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
        if (isDesktop) {
          ctx.effect(() =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: 'idle-shutdown.switch', order: 10 }, () => h(TitleBarButton, { t })),
            ),
          )
        }

        ctx.effect(() =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 6, label: () => t('nav'), locale: NS },
              () => h(SettingsSection, { t }),
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('settings.section.icon', () =>
            ctx.slots.register({ name: 'settings.section.icon', id: NS, order: 6, locale: NS }, NavGlyph),
          ),
        )
      },
    }
  },
})