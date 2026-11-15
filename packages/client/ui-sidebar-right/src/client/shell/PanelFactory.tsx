/**
 * The public right Sidebar panel Factory.
 *
 * One occurrence renders one Session's panel. The frame's right column renders
 * the main variant: it passes the column width it keeps while collapsed, the
 * fullscreen it presents, the on-screen flag, and its View-backed keepMounted
 * lease. A host surface renders the embedded variant: it fills the box its host
 * provides, owns no frame presentation, and draws the docked tree only.
 *
 * Both variants read the same store instance for the Session, so layout, tabs,
 * history, and persistence are one state wherever the panel appears.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HalvesFit, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type {} from '../contract/slots.ts'
import type { SidebarRightPanelProps } from '../contract/slots.ts'
import { SidebarPanel, type PanelProps, type SidebarRightRetainTab } from './SidebarRight.tsx'
import css from './SidebarRight.module.css'

/**
 * A counted lease for keepMounted bodies of an occurrence that owns no View.
 *
 * The embedding host already retains the Session, so this lease only tracks the
 * bodies the occurrence itself keeps mounted; releasing the body's lifetime
 * drops its hold.
 * @returns the lease a panel occurrence hands to its tab bodies.
 */
/** @internal Exported for the package's own specs; not part of the client entry point. */
export function createLocalRetention(): SidebarRightRetainTab {
  const held = new Map<TabId, number>()
  return (tabId, signal) => {
    if (signal.aborted) return () => {}
    held.set(tabId, (held.get(tabId) ?? 0) + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal.removeEventListener('abort', release)
      const count = (held.get(tabId) ?? 1) - 1
      if (count <= 0) held.delete(tabId)
      else held.set(tabId, count)
    }
    signal.addEventListener('abort', release, { once: true })
    return release
  }
}

/**
 * One panel occurrence: the frame's column or a surface a host owns.
 * @param props - occurrence inputs plus the store, locale, children, and injected face.
 * @returns the panel, or nothing while the occurrence must not draw.
 */
export function SidebarRightPanel({
  variant, fullscreen = false, active = true, width, retainTab,
  sessionId, useStore, actions, t, renderSlot, openTab, closeTab, splitPane, toggleFullscreen,
  measureRoom, enterEmbedded, takePendingExpansion, useContextMenu, useContextMenuTarget,
  useTabTypes, useTabNavigation, useFlash, useShortcuts, occurrence,
}: SidebarRightPanelProps): ReactNode {
  const embedded = variant === 'embedded'
  const surface = useStore(state => state.bySession[sessionId])
  const expanded = surface?.layout.expanded ?? false
  const { getTriggerProps } = useContextMenu()
  const tabMenuOpen = useContextMenuTarget(target => target?.kind === 'tab' && target.value.sessionId === sessionId)
  const shortcuts = useShortcuts(entries => entries)
  const localLease = useMemo(createLocalRetention, [])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [measuredWidth, setMeasuredWidth] = useState<number | undefined>(undefined)
  // The wrapper attaches only once the occurrence has a surface to draw, so the
  // measurement follows that commit rather than the mount.
  const panelVisible = surface !== undefined && expanded

  // The embedded occurrence fills the box its host provides and measures it, so
  // the panel never depends on frame props for its width.
  useLayoutEffect(() => {
    if (!embedded || !panelVisible) return undefined
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    const measure = (): void => { setMeasuredWidth(element.getBoundingClientRect().width || undefined) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [embedded, panelVisible])

  // An expansion recorded before this Session's panel existed is applied once,
  // after the store instance exists, so no store is minted outside registration.
  useLayoutEffect(() => {
    const pending = takePendingExpansion()
    if (pending !== undefined) actions.setExpanded(sessionId, pending)
  }, [actions, sessionId, takePendingExpansion])

  // While an embedded occurrence is mounted and expanded it is the Sidebar's
  // navigation target, and the frame occurrence leaves this Session's bodies to it.
  useLayoutEffect(() => {
    if (!embedded || !expanded) return undefined
    return enterEmbedded()
  }, [embedded, expanded, enterEmbedded])

  const reportRoom = useCallback((fits: ReadonlyMap<PaneId, HalvesFit>): void => {
    measureRoom(paneId => fits.get(paneId)?.row !== false)
  }, [measureRoom])

  if (surface === undefined) return null
  if (embedded && !expanded) return null
  const panel: PanelProps = {
    sessionId,
    surface,
    actions,
    t,
    renderSlot,
    openTab,
    closeTab,
    getTabTriggerProps: (tab, paneId, handlers) =>
      getTriggerProps({ kind: 'tab', value: { sessionId, tab, paneId } }, handlers),
    tabMenuOpen,
    splitPane,
    toggleFullscreen,
    shortcuts,
    useTabTypes,
    useTabNavigation,
    useStore,
    useFlash,
    occurrence,
    fullscreen: !embedded && fullscreen,
    active,
    variant,
    retainTab: retainTab ?? localLease,
    reportRoom,
  }
  if (!embedded) return <SidebarPanel {...panel} width={width} />
  return (
    <div ref={rootRef} className={css.embeddedRoot} data-sidebar-right-surface="">
      <SidebarPanel {...panel} width={measuredWidth} />
    </div>
  )
}
