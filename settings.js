/**
 * Settings page of `dsh-idle-shutdown`, served as its own chunk.
 *
 * The page is the largest part of the client half and is only needed once the
 * user opens 设置 → 空闲关机, so the Host serves this file on demand and the main
 * client module imports it the first time the section is shown.
 *
 * Dependencies come from the caller, so this chunk shares the page's React
 * instance and the long-poll stream instead of starting its own.
 *
 * @returns the Settings page component.
 */
export default function createSettingsPage({ React, h, subscribeState, readState, writeState, actionLabel }) {
    /** Track whether an element is actually on screen. */
    function useOnScreen(ref) {
    const [onScreen, setOnScreen] = React.useState(true)
    React.useEffect(() => {
      const node = ref.current
      if (!node || typeof IntersectionObserver === 'undefined') return
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) setOnScreen(entry.isIntersecting)
        },
        { threshold: 0 },
      )
      observer.observe(node)
      return () => observer.disconnect()
    }, [ref])
    return onScreen
    }

    const PAGE_CSS = `
.isw-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 24px; color: var(--dsw-alias-label-primary); }
.isw-title { margin: 0; font-size: 14px; font-weight: 600; }
.isw-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-line; }
.isw-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.isw-label { font-size: 13px; }
.isw-windows { display: flex; flex-direction: column; gap: 10px; }
.isw-window {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.isw-window[data-inert='true'] { opacity: 0.62; }
.isw-note { flex-basis: 100%; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.isw-input, .isw-select {
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 4px 8px;
  color-scheme: light dark;
}
.isw-select { padding: 4px 6px; }
.isw-count { width: 56px; }
.isw-button {
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.isw-button:hover { background: var(--dsw-alias-bg-layer-2); }
.isw-button:disabled { opacity: 0.5; cursor: default; }
.isw-button[data-primary='true'] {
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-primary);
}
.isw-button[data-primary='true']:hover { background: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-label-secondary); }
.isw-switch {
  position: relative;
  width: 40px;
  height: 22px;
  border-radius: 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  cursor: pointer;
  padding: 0;
}
.isw-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.isw-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary);
  transition: transform 120ms ease;
}
.isw-switch[aria-checked='true'] .isw-knob { transform: translateX(18px); background: var(--dsw-alias-bg-base); }
.isw-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.isw-saved { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.isw-message { margin: 2px 0; }
.isw-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 5;
  padding: 8px 0 10px;
  margin-top: 4px;
  background: transparent;
}
.isw-footer[data-sticky='true'] { position: sticky; bottom: 0; }
.isw-footer-spacer { flex: 1 1 auto; }
`

    function ActionBar({ children }) {
    const barRef = React.useRef(null)
    const [pinned, setPinned] = React.useState(null)

    React.useLayoutEffect(() => {
      const bar = barRef.current
      if (!bar) return
      /** First opaque background color up the ancestor chain. */
      const surfaceOf = (start) => {
        for (let node = start; node && node !== document.documentElement; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor
          if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
        }
        return 'transparent'
      }
      // A transformed ancestor makes `fixed` relative to that ancestor
      // instead of the viewport, so fall back to the sticky layout there.
      let transformed = false
      for (let node = bar.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).transform !== 'none') {
          transformed = true
          break
        }
      }
      let scroller = bar.parentElement
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        const style = getComputedStyle(scroller)
        // The panel's content column scrolls only once the content grows
        // past it, so its `overflow-y` is the real signal — never the current
        // scrollHeight, which changes as the user adds rows.
        if (/(auto|scroll|overlay)/.test(style.overflowY) && scroller.clientHeight > 0) break
        scroller = scroller.parentElement
      }
      if (transformed || !scroller || scroller === document.body || scroller === document.documentElement) {
        const background = surfaceOf(bar.parentElement)
        setPinned({ mode: 'sticky', height: bar.offsetHeight, background, style: { background } })
        return
      }
      const background = surfaceOf(scroller)
      let signature = ''
      const update = () => {
        const root = bar.parentElement
        if (root === null) return
        const box = root.getBoundingClientRect()
        const rail = scroller.getBoundingClientRect()
        const bottom = Math.max(0, window.innerHeight - rail.bottom)
        const next = `${Math.round(box.left)}|${Math.round(box.width)}|${Math.round(bottom)}`
        if (next === signature) return
        signature = next
        setPinned({
          mode: 'fixed',
          height: bar.offsetHeight,
          background,
          style: {
            position: 'fixed',
            left: `${box.left}px`,
            width: `${box.width}px`,
            bottom: `${bottom}px`,
            background,
          },
        })
      }
      update()
      scroller.addEventListener('scroll', update, { passive: true })
      window.addEventListener('resize', update)
      const observer = new ResizeObserver(update)
      observer.observe(scroller)
      if (bar.parentElement instanceof Element) observer.observe(bar.parentElement)
      return () => {
        scroller.removeEventListener('scroll', update)
        window.removeEventListener('resize', update)
        observer.disconnect()
      }
    }, [])

    return h(
      React.Fragment,
      null,
      h(
        'div',
        {
          key: 'bar',
          ref: barRef,
          className: 'isw-footer',
          'data-sticky': pinned?.mode === 'sticky' ? 'true' : 'false',
          style: pinned?.style ?? undefined,
        },
        children,
      ),
      h('span', {
        key: 'spacer',
        style: { display: 'block', height: pinned ? `${pinned.height + 14}px` : '0px' },
      }),
    )
    }

    /** Settings page: the switch plus the window editor. */
    function SettingsPage({ t }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [windows, setWindows] = React.useState([])
    const [armed, setArmed] = React.useState(true)
    const [idleMinutes, setIdleMinutes] = React.useState(30)
    const [warningSeconds, setWarningSeconds] = React.useState(60)
    // The last seconds belong to the OS command itself: they cannot be undone.
    const [closeLeadSeconds, setCloseLeadSeconds] = React.useState(3)
    const [error, setError] = React.useState(null)
    const [saved, setSaved] = React.useState(false)
    const [busy, setBusy] = React.useState(false)

    const applyStatus = React.useCallback((next) => {
      setSnapshot(next)
      setArmed(next.armed === true)
      setError(null)
    }, [])

    const applyAll = React.useCallback((next) => {
      setSnapshot(next)
      setArmed(next.armed === true)
      setWindows(Array.isArray(next.windows) ? next.windows.map((window) => ({ ...window })) : [])
      const timing = next.config ?? {}
      if (Number.isFinite(Number(timing.idleMinutes))) setIdleMinutes(Number(timing.idleMinutes))
      if (Number.isFinite(Number(timing.warningSeconds))) setWarningSeconds(Number(timing.warningSeconds))
      if (Number.isFinite(Number(timing.closeLeadSeconds))) setCloseLeadSeconds(Number(timing.closeLeadSeconds))
      setError(null)
    }, [])

    // The page stays mounted while another settings section is shown, so the
    // timers run only while this one is actually on screen.
    const pageRef = React.useRef(null)
    const onScreen = useOnScreen(pageRef)
    const styleElement = React.useMemo(() => h('style', null, PAGE_CSS), [])

    // The page subscribes only while it is on screen; the shared stream keeps
    // running for the title-bar switch meanwhile.
    const loadedRef = React.useRef(false)
    React.useEffect(() => {
      if (!onScreen) return undefined
      return subscribeState((next) => {
        if (!loadedRef.current) {
          loadedRef.current = true
          applyAll(next)
          return
        }
        applyStatus(next)
      })
    }, [applyAll, applyStatus, onScreen])

    const reload = () => {
      setError(null)
      readState()
        .then((next) => applyAll(next))
        .catch((reason) => setError(`${t('error.load')}: ${reason instanceof Error ? reason.message : String(reason)}`))
    }

    const update = (index, field, value) => {
      setSaved(false)
      setWindows((current) => current.map((window, at) => (at === index ? { ...window, [field]: value } : window)))
    }

    const save = async (patch, options) => {
      setBusy(true)
      setError(null)
      try {
        const next = await writeState(patch)
        if (options?.keepDrafts === true) applyStatus(next)
        else applyAll(next)
        setSaved(true)
      } catch (reason) {
        setError(`${t('error.save')}: ${reason instanceof Error ? reason.message : String(reason)}`)
      } finally {
        setBusy(false)
      }
    }

    /** Discard unsaved edits: back to what the Host currently has. */
    const cancelEdits = () => {
      setSaved(false)
      if (snapshot === null) reload()
      else applyAll(snapshot)
    }

    /** Fill the form with the built-in defaults; nothing is saved yet. */
    const restoreDefaults = () => {
      setSaved(false)
      setArmed(true)
      setIdleMinutes(30)
      setWarningSeconds(60)
      setCloseLeadSeconds(3)
      setWindows([{ start: '23:00', end: '07:00', repeat: 'daily', persistent: true }])
    }


    /**
     * A locale string with a built-in fallback.
     *
     * The client bundle that registers the locale strings may be older than this
     * page (it is rebuilt by the harness), so a missing key must show readable
     * text instead of the key name.
     */
    const label = (key, fallback) => {
      const value = typeof t === 'function' ? t(key) : key
      return typeof value === 'string' && value !== '' && value !== key ? value : fallback
    }

    const statusLines = []
    if (snapshot !== null && snapshot.monitoring === false) {
      statusLines.push(`${t('switch.off')} · ${t('status.notMonitoring')}`)
    } else if (snapshot !== null) {
      statusLines.push(
        `${snapshot.armed ? t('switch.on') : t('switch.off')} · ` +
          `${snapshot.active ? t('status.busy') : t('status.idle')} · ` +
          `${snapshot.inWindow ? t('status.window.yes') : t('status.window.no')}`,
      )
      if (!snapshot.inWindow && typeof snapshot.opensInMinutes === 'number') {
        statusLines.push(t('status.next').replace('{minutes}', String(snapshot.opensInMinutes)))
      }
      if (snapshot.pending) {
        statusLines.push(
          t('status.pending').replace('{seconds}', String(snapshot.pending.remainingSeconds)).replace('{action}', actionLabel(t, snapshot.pending.action)),
        )
      }
      statusLines.push(`${t('status.idle')}: ${snapshot.idleSeconds}s`)
    }

    const windowNote = (window) => {
      const notes = []
      if (window.repeat === 'today') notes.push(t('windows.note.today').replace('{date}', window.date ?? ''))
      if (window.repeat === 'count') notes.push(t('windows.note.count').replace('{remaining}', String(window.remaining ?? 0)))
      if (window.repeat === 'today' && window.used) notes.push(t('windows.note.used'))
      if (window.skipUntil) notes.push(t('windows.note.skipped').replace('{until}', new Date(window.skipUntil).toLocaleString()))
      notes.push(window.persistent ? t('windows.note.persistent') : t('windows.note.temporary'))
      return notes.join(' · ')
    }

    /** Today's local date key, the same `sv-SE` shape the Host stamps. */
    const todayKey = () => new Date().toLocaleDateString('sv-SE')

    const windowInert = (window) =>
      (window.repeat === 'today' && (window.used || window.date !== todayKey())) ||
      (window.repeat === 'count' && (window.remaining ?? 0) <= 0) ||
      (typeof window.skipUntil === 'string' && Date.parse(window.skipUntil) > Date.now())

    /** A persistent row that still exists but can no longer fire. */
    const windowStale = (window) => window.persistent === true && windowInert(window)

    /**
     * Bring an inert row back to life through its own controls.
     *
     * Re-picking a repeat type is the re-activation: "today" re-stamps today and
     * clears the used mark, "count" gets a fresh quota, "daily" stays daily with
     * a fresh baseline, and either way the skip is dropped. This mirrors the
     * Host's `reactivateWindow`, which is the rule the saved config is
     * normalized with.
     */
    const rearm = (window, repeat, extra = {}) => {
      const next = { start: window.start, end: window.end, repeat, persistent: true }
      if (repeat === 'today') {
        next.date = todayKey()
        next.used = false
      } else if (repeat === 'count') {
        const wanted = Number(extra.remaining ?? window.remaining ?? 1)
        next.remaining = Math.max(1, Math.floor(Number.isFinite(wanted) ? wanted : 1))
      }
      return next
    }

    /**
     * Apply one draft edit, re-arming the row when it was inert.
     *
     * Editing an inert persistent row through any of its own controls is how it
     * comes back: there is no separate "re-activate" control to keep in sync.
     */
    const editWindow = (index, patch) => {
      setSaved(false)
      setWindows((current) =>
        current.map((entry, at) => {
          if (at !== index) return entry
          const repeat = patch.repeat ?? entry.repeat
          if (entry.persistent === true && windowInert(entry)) return rearm(entry, repeat, patch)
          return { ...entry, ...patch }
        }),
      )
    }

    return h(
      'div',
      { className: 'isw-page', ref: pageRef },
      styleElement,
      h('h2', { className: 'isw-title' }, t('title')),
      h(
        'div',
        { className: 'isw-row' },
        h('span', { className: 'isw-label' }, t('switch.label')),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': armed,
            'aria-label': t('switch.label'),
            className: 'isw-switch',
            disabled: busy,
            onClick: () => {
              setSaved(false)
              const next = !armed
              setArmed(next)
              save({ armed: next }, { keepDrafts: true })
            },
          },
          h('span', { className: 'isw-knob' }),
        ),
      ),
      h('p', { className: 'isw-hint' }, statusLines.join('\n')),
      h('p', { className: 'isw-title' }, t('timing.title')),
      h(
        'div',
        { className: 'isw-row' },
        h('span', { className: 'isw-label' }, t('timing.idle')),
        h('input', {
          type: 'number',
          min: 0.05,
          max: 180,
          step: 1,
          className: 'isw-input isw-count',
          value: idleMinutes,
          'aria-label': t('timing.idle'),
          onChange: (event) => {
            setSaved(false)
            setIdleMinutes(event.target.value === '' ? '' : Number(event.target.value))
          },
        }),
      ),
      h(
        'div',
        { className: 'isw-row' },
        h('span', { className: 'isw-label' }, t('timing.warning')),
        h('input', {
          type: 'number',
          min: 0,
          max: 1800,
          step: 1,
          className: 'isw-input isw-count',
          value: warningSeconds,
          'aria-label': t('timing.warning'),
          onChange: (event) => {
            setSaved(false)
            setWarningSeconds(event.target.value === '' ? '' : Number(event.target.value))
          },
        }),
      ),
      h(
        'div',
        { className: 'isw-row' },
        h('span', { className: 'isw-label' }, label('timing.grace', '最后几秒交给系统（不可撤销）')),
        h('input', {
          type: 'number',
          min: 3,
          max: 60,
          step: 1,
          className: 'isw-input isw-count',
          value: closeLeadSeconds,
          'aria-label': t('timing.grace'),
          onChange: (event) => {
            setSaved(false)
            setCloseLeadSeconds(event.target.value === '' ? '' : Number(event.target.value))
          },
        }),
      ),
      h('p', { className: 'isw-hint' }, `${t('timing.idleHint')}\n${t('timing.warningHint')}\n${label('timing.graceHint', '倒计时最后 N 秒交给系统关机命令，这几秒无法撤销，用来保证 DSH 关闭后关机仍然发生；默认 3 秒。')}`),
      h('p', { className: 'isw-title' }, t('windows.title')),
      h(
        'div',
        { className: 'isw-windows' },
        windows.length === 0 ? h('p', { className: 'isw-hint' }, t('windows.empty')) : null,
        windows.map((window, index) =>
          h(
            'div',
            { className: 'isw-window', key: `w-${index}`, 'data-inert': windowInert(window) ? 'true' : 'false' },
            h('input', {
              type: 'time',
              className: 'isw-input',
              value: window.start,
              'aria-label': t('windows.start'),
              onChange: (event) => update(index, 'start', event.target.value),
            }),
            h('span', { className: 'isw-hint' }, '→'),
            h('input', {
              type: 'time',
              className: 'isw-input',
              value: window.end,
              'aria-label': t('windows.end'),
              onChange: (event) => update(index, 'end', event.target.value),
            }),
            h(
              'select',
              {
                className: 'isw-select',
                // An inert persistent row shows a placeholder instead of its old
                // repeat type: re-picking one is exactly how it is re-activated,
                // and a native select only fires when the value really changes.
                value: windowStale(window) ? '' : window.repeat,
                title: windowStale(window)
                  ? label('windows.reactivatePick', '已失效：重新选择重复方式即可重新激活')
                  : undefined,
                'aria-label': t('windows.repeat'),
                onChange: (event) => {
                  const repeat = event.target.value
                  if (repeat === '') return
                  // "Every day" can only be persistent; the others keep what the
                  // user picked.
                  editWindow(index, repeat === 'daily' ? { repeat, persistent: true } : { repeat })
                },
              },
              windowStale(window)
                ? h('option', { value: '' }, label('windows.note.inert', '已失效，重新选择即激活'))
                : null,
              h('option', { value: 'daily' }, t('windows.repeat.daily')),
              h('option', { value: 'today' }, t('windows.repeat.today')),
              h('option', { value: 'count' }, t('windows.repeat.count')),
            ),
            window.repeat === 'count'
              ? h('input', {
                  type: 'number',
                  min: 1,
                  className: 'isw-input isw-count',
                  value: window.remaining ?? 1,
                  'aria-label': t('windows.count'),
                  // A new number is also a re-activation for a used-up row.
                  onChange: (event) => editWindow(index, { remaining: Math.max(1, Number(event.target.value) || 1) }),
                })
              : null,
            h(
              'select',
              {
                className: 'isw-select',
                value: window.repeat === 'daily' ? 'persistent' : window.persistent ? 'persistent' : 'temporary',
                // A daily window is always persistent, so the choice is not
                // offered there; switch the repeat type to get it back.
                disabled: busy || window.repeat === 'daily',
                title: window.repeat === 'daily' ? t('windows.persist.dailyForced') : undefined,
                'aria-label': t('windows.persist.persistent'),
                onChange: (event) => update(index, 'persistent', event.target.value === 'persistent'),
              },
              h('option', { value: 'persistent' }, t('windows.persist.persistent')),
              h('option', { value: 'temporary' }, t('windows.persist.temporary')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'isw-button',
                disabled: busy,
                onClick: () => {
                  setSaved(false)
                  setWindows((current) => current.filter((_window, at) => at !== index))
                },
              },
              t('windows.remove'),
            ),
            h('span', { className: 'isw-note' }, windowNote(window)),
          ),
        ),
        h(
          'div',
          { className: 'isw-window' },
          h(
            'button',
            {
              type: 'button',
              className: 'isw-button',
              disabled: busy,
              onClick: () => {
                setSaved(false)
                setWindows((current) => [...current, { start: '23:00', end: '07:00', repeat: 'daily', persistent: true }])
              },
            },
            t('windows.add'),
          ),
        ),
      ),
      h('p', { className: 'isw-hint' }, t('windows.hint')),
      saved ? h('p', { className: 'isw-saved isw-message' }, t('saved')) : null,
      error === null
        ? null
        : h(
            'p',
            { className: 'isw-error isw-message' },
            error,
            ' ',
            h('button', { type: 'button', className: 'isw-button', disabled: busy, onClick: reload }, t('action.retry')),
          ),
      // The action bar is pinned to the panel's bottom, outside the flow.
      h(
        ActionBar,
        { key: 'bar' },
        h('button', { type: 'button', className: 'isw-button', disabled: busy, onClick: restoreDefaults }, t('action.restoreDefaults')),
        h('span', { className: 'isw-footer-spacer' }),
        h('button', { type: 'button', className: 'isw-button', disabled: busy, onClick: cancelEdits }, t('action.cancel')),
        h(
          'button',
          {
            type: 'button',
            className: 'isw-button',
            'data-primary': 'true',
            disabled:
              busy ||
              windows.some((window) => window.start === '' || window.end === '') ||
              !(Number(idleMinutes) >= 0.05) ||
              Number(idleMinutes) > 180 ||
              !Number.isFinite(Number(warningSeconds)) ||
              Number(warningSeconds) < 0 ||
              Number(warningSeconds) > 1800 ||
              !Number.isFinite(Number(closeLeadSeconds)) ||
              !(Number(closeLeadSeconds) >= 3) ||
              Number(closeLeadSeconds) > 60,
            onClick: () =>
              save({
                windows,
                idleMinutes: Number(idleMinutes),
                warningSeconds: Number(warningSeconds),
                closeLeadSeconds: Math.floor(Number(closeLeadSeconds)),
              }),
          },
          t('action.save'),
        ),
      ),
    )
    }

    /** A small clock glyph for the settings navigation cell. */
  return SettingsPage
}