/**
 * The Sidebar's seat in the frame, and the panel both occurrences draw.
 *
 * The frame owns the right column's geometry; the panel owns one content tree
 * at the column width or spanning the viewport. A shown wide panel retains its
 * track in fullscreen, preserving the conversation width. Below 768px
 * fullscreen is derived from viewport width, without changing manual mode.
 *
 * The seat is now an adapter: it computes the frames's presentation facts,
 * reports them through the injected face, and renders the public panel Factory
 * in its `main` variant. The panel component below is shared with the
 * `embedded` variant a host renders in its own surface, which reaches it
 * through the same Factory and the same Session store.
 *
 * Docked content stays mounted while collapsed, translated off the frame's right
 * edge, so opening and closing are one gesture in both presentations: a slide
 * from and to that edge. An item mounted by the opening, such as the first tab
 * of an empty column, starts at that edge, so it joins the slide. Normal
 * presentation moves the frame's tracks with the panel. A fullscreen opening
 * reserves its underlying track only after the panel covers the frame, without
 * animating those hidden columns.
 *
 * The panel has no header of its own: its two controls — presentation switch
 * and collapse — ride the docking kit's chrome seat at the end of the top-right
 * pane's tab strip, so the strip is the panel's whole top edge. An embedded
 * occurrence keeps the collapse control and drops the presentation switch,
 * because its host decides how it is presented. The way back in while collapsed
 * is not here either: it is one button in the conversation header
 * (`ExpandButton.tsx`), because it exists only while this panel is hidden.
 * Floating panels remain in the same content tree in the frame occurrence;
 * untransformed ancestors let their fixed-position frames cross the column and
 * conversation. An embedded occurrence draws the docked tree only.
 *
 * Tab bodies do not live here. Each one is a registration under its type's kind,
 * dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
 * title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
 * to this file. What a body receives beyond the record — navigation, lifetime
 * signal, actions — is read through the slot-owned useTabInfo hook. The Tab
 * domain follows each session's store commits, including sessions off screen.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsRenderFactories, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { DockIntents, DockMode, DockSurfaceProps, FloatRect, TabId, TabRecord, TabRenderer } from '@deepseek-ai/dsh-client-ui-dockkit'
import { canSplit, dockPaneIds, DockLayout, findPaneContentTab } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HalvesFit, LayoutState, PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { GUIDE_KIND, pageAddress } from '../contract/seed.ts'
import { dockLabels } from '../labels.ts'
import type { SidebarRightPanelProps } from '../contract/slots.ts'
import type { createSidebarRightStore, SurfaceState } from '../stores.ts'
import { canCloseTab } from '../stores.ts'
import type { TabHookContext } from '../tab-info.ts'
import { flashPane } from './flash.ts'
import css from './SidebarRight.module.css'

/** The store share the panel receives. */
type Store = PropsStore<ReturnType<typeof createSidebarRightStore>>

/** A `keepMounted` lease: one body held for the caller's occurrence. */
export type SidebarRightRetainTab = (tabId: TabId, signal: AbortSignal) => () => void

/** What the panel reports to the frame: drawn or not, and whether it wants a track. */
export interface SidebarRightPresentation {
  /** Whether the panel is drawn at all. */
  readonly shown: boolean
  /** Whether the drawn panel wants the conversation to make room for it. */
  readonly track: boolean
  /** Whether the panel fills the viewport, independently of its retained track. */
  readonly fullscreen: boolean
}

/** What the frame occurrence needs from its host beyond the framework shares. */
export interface SidebarRightFrameInjected {
  /**
   * Report the panel's presentation to the frame.
   *
   * The frame sizes the track and places the resize handle; this only tells it
   * the composition of the facts this package owns, and is called whenever that
   * composition changes.
   */
  readonly syncPresentation: (presentation: SidebarRightPresentation) => void
  /**
   * Record whether the frame width this seat renders at presents an expanded panel fullscreen automatically.
   *
   * The fullscreen command reads the latest report: while it holds, the command
   * closes the panel instead of switching its recorded mode.
   * @param autoFullscreen - whether the frame is narrower than the automatic fullscreen width.
   */
  readonly reportAutoFullscreen: (autoFullscreen: boolean) => void
  /** How many embedded occurrences of a Session are drawing its panel, by Session id. */
  readonly keyedHooks: { readonly drawnElsewhere: (key: string) => HostObservable<number> }
}

/** The column seat's props: session scope, so the session arrives as a standard prop. */
export type RightbarSeatProps =
  & PropsRuntime<'rightbar.session'>
  & Store
  & PropsRenderFactories
  & InjectFace<SidebarRightFrameInjected>

/** Everything the panel needs, already bound to one session. */
export type PanelProps =
  & Pick<SidebarRightPanelProps,
    | 'sessionId' | 'useStore' | 'actions' | 't' | 'renderSlot' | 'openTab' | 'closeTab'
    | 'splitPane' | 'toggleFullscreen' | 'useTabTypes' | 'useTabNavigation' | 'useFlash' | 'occurrence'>
  & {
    readonly surface: SurfaceState
    readonly getTabTriggerProps: NonNullable<DockSurfaceProps['getTabTriggerProps']>
    readonly tabMenuOpen: boolean
    readonly shortcuts: readonly ShortcutCatalogEntry[]
    readonly fullscreen: boolean
    readonly active: boolean
    /** `main` draws in the frame's column; `embedded` fills a host surface and draws the docked tree only. */
    readonly variant: 'main' | 'embedded'
    /** Frame occurrence only: the column width the panel keeps while collapsed. */
    readonly width?: number | undefined
    readonly retainTab: SidebarRightRetainTab
    /** Receives the kit's room-rule readings for the service's `split`. */
    readonly reportRoom: (fits: ReadonlyMap<PaneId, HalvesFit>) => void
  }

/** The guide tab one pane holds, if any: a pane holds at most one. */
function guideIn(layout: LayoutState, paneId: PaneId): TabId | undefined {
  return findPaneContentTab(layout, paneId, pageAddress(GUIDE_KIND), GUIDE_KIND)
}

/**
 * Build the kit's intent face for one session out of the store's actions.
 * @param sessionId - the session the seat draws; every action is bound to it.
 * @param actions - the seat's bound store actions.
 * @param openTab - the navigation face's `openTab`, which the strip's add control asks for a guide through.
 * @returns the intents the kit reports gestures to.
 */
export function intentsFor(sessionId: SessionId, actions: Store['actions'], openTab: PanelProps['openTab'], closeTab?: PanelProps['closeTab'], splitPane?: PanelProps['splitPane']): DockIntents {
  return {
    focusTab: (tabId) => { actions.focusTab(sessionId, tabId) },
    focusPane: (paneId) => { actions.focusPane(sessionId, paneId) },
    splitPane: splitPane ?? ((paneId) => { actions.splitPane(sessionId, paneId) }),
    // The guide is unique per pane: the control is drawn only while its pane
    // holds none (`canAddTab` below) and asks for one there without regard to
    // guides in other panes; the store settles the open on a guide the pane
    // already holds, so the ask is idempotent all the same.
    addTab: (paneId) => { openTab(GUIDE_KIND, { paneId, revealIfOpened: false }) },
    closeTab: closeTab ?? ((tabId) => { actions.closeTab(sessionId, tabId) }),
    duplicateTab: (tabId) => { actions.duplicateTab(sessionId, tabId) },
    floatTab: (tabId, rect?: FloatRect) => { actions.floatTab(sessionId, tabId, rect) },
    unfloatPane: (paneId) => { actions.unfloatPane(sessionId, paneId) },
    placeTab: (tabId, toPaneId, index) => { actions.placeTab(sessionId, tabId, toPaneId, index) },
    dropTab: (tabId, paneId, zone) => { actions.dropTab(sessionId, tabId, paneId, zone) },
    moveFloat: (paneId, x, y) => { actions.moveFloat(sessionId, paneId, x, y) },
    resizeFloat: (paneId, rect) => { actions.resizeFloat(sessionId, paneId, rect) },
    resizeSplit: (splitId, sizes) => { actions.resizeSplit(sessionId, splitId, sizes) },
  }
}

/**
 * The intents an embedded occurrence exposes: it draws no floating pane and
 * begins no split there, so those three gestures change nothing. Every other
 * intent passes through unchanged.
 * @param intents - the full intent face the kit reports gestures to.
 * @returns the same face with floating and splitting pinned to no-ops.
 */
export function embeddedIntents(intents: DockIntents): DockIntents {
  return { ...intents, floatTab: () => {}, unfloatPane: () => {}, splitPane: () => {} }
}

/** One tab's slot dispatch: which seat, and what to render when no type registered. */
interface TabSlotProps extends Pick<PanelProps, 'renderSlot' | 'occurrence' | 'useTabTypes' | 'useTabNavigation' | 'useStore' | 'fullscreen' | 'active' | 'retainTab' | 'shortcuts'> {
  readonly tab: TabRecord
  readonly seat: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'
  readonly fallback: ReactNode
}

/**
 * Dispatch one tab's body or title with stable framework hooks and record lifetime.
 */
function TabSlot({
  renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, shortcuts, active, retainTab, tab, seat, fallback,
}: TabSlotProps): ReactNode {
  const { id, signal, tabActions } = occurrence(tab)
  const definition = useTabTypes(types => types.find(definition => definition.kind === tab.kind))
  const retained = seat === 'sidebar.right.pane.tab' && definition?.keepMounted === true
  useLayoutEffect(() => retained ? retainTab(tab.id, signal) : undefined, [retained, retainTab, tab.id, signal])
  const hookContext = useMemo((): TabHookContext => ({
    tabId: tab.id,
    shortcuts,
    title: seat === 'sidebar.right.pane.tab.title',
    fullscreen,
    active,
    signal,
    actions: tabActions,
    useStore,
    useTabNavigation,
  }), [tab.id, seat, fullscreen, active, signal, tabActions, useStore, useTabNavigation, shortcuts])
  const content = renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
  return seat === 'sidebar.right.pane.tab.title'
    ? <span key={id} className={css.tabTitle} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</span>
    : <div key={id} className={css.tabBody} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</div>
}

/**
 * Dispatch a tab's body to its registered type.
 *
 * A kind with no registrant is a real state, not a defect: a session log can
 * carry a tab whose type shipped in a plugin that is no longer mounted. Saying so
 * is better than an empty pane.
 */
function bodiesFor(panel: PanelProps): TabRenderer {
  const { t, ...rest } = panel
  // Slot dispatch selects a type; the record key separates bodies of that type.
  return tab => (
    <TabSlot
      key={tab.id}
      {...rest}
      tab={tab}
      seat="sidebar.right.pane.tab"
      fallback={<p className={css.unavailable} data-sidebar-right-unavailable>{t('tab.unavailable')}</p>}
    />
  )
}

/** Dispatch a tab's title to its registered type; without one the chip shows the title captured at open time. */
function titlesFor(panel: PanelProps): TabRenderer {
  return tab => <TabSlot key={tab.id} {...panel} tab={tab} seat="sidebar.right.pane.tab.title" fallback={tab.title} />
}

/** Expand-to-viewport glyph from the shared product artwork. */
function FullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
    </svg>
  )
}

/** Restore-from-fullscreen glyph from the shared product artwork. */
function ExitFullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
      <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
    </svg>
  )
}

/**
 * The panel's controls, placed by the kit at the top-right pane's strip end.
 * An embedded occurrence offers collapse only: its host owns presentation.
 */
function PanelChrome({
  variant, sessionId, fullscreen, actions, t, shortcuts, toggleFullscreen,
}: Pick<PanelProps, 'sessionId' | 'actions' | 't' | 'fullscreen' | 'shortcuts' | 'toggleFullscreen'> & {
  readonly variant: PanelProps['variant']
}): ReactNode {
  const next: DockMode = fullscreen ? 'push' : 'fullscreen'
  const modeLabel = fullscreen ? t('chrome.exitFullscreen') : t('chrome.toFullscreen')
  const mode = shortcuts.find(entry => entry.id === 'pane.fullscreen.toggle')
  const toggle = shortcuts.find(entry => entry.id === 'sidebar.right.toggle')
  return (
    <>
      {variant === 'main' && (
        <Tooltip label={modeLabel} shortcutKeys={mode?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={modeLabel}
            aria-keyshortcuts={mode?.aria}
            data-sidebar-right-mode={next}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
          </button>
        </Tooltip>
      )}
      <Tooltip label={t('chrome.collapse')} shortcutKeys={toggle?.keys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('chrome.collapseAria')}
          aria-keyshortcuts={toggle?.aria}
          data-sidebar-right-toggle
          onClick={() => { actions.toggleExpanded(sessionId) }}
        >
          <IconPanelLeftOutlineRegular className={css.collapseGlyph} />
        </button>
      </Tooltip>
    </>
  )
}

/**
 * The panel: the docked surface with its controls in the top-right strip,
 * anchored to its owner's box. The frame occurrence anchors to the column and
 * slides off it while collapsed; an embedded occurrence fills the box its host
 * gives it and is drawn only while expanded.
 */
export function SidebarPanel(panel: PanelProps): ReactNode {
  const { sessionId, surface, actions, t, openTab, width, reportRoom, fullscreen, active, variant } = panel
  const { expanded } = surface.layout
  const embedded = variant === 'embedded'
  const panelRef = useRef<HTMLDivElement | null>(null)
  const types = panel.useTabTypes(value => value)
  const flash = panel.useFlash(value => value)
  // Each request plays at most once, and only on screen: the request current
  // when the panel mounts, or one arriving while its Session is hidden, is
  // already past. Hiding the Session ends a glow in progress.
  const played = useRef(flash?.serial)
  // The glow is DOM-only: the docking kit owns the pane elements it marks.
  useLayoutEffect(() => {
    if (flash === undefined || flash.serial === played.current) return undefined
    played.current = flash.serial
    return panel.active ? flashPane(panelRef.current, flash) : undefined
  }, [flash, panel.active])
  // True from the render that opens the on-screen panel until a transition in
  // it ends, the panel closes, or it leaves the screen, which cancels the
  // slide; the stylesheet starts items mounted meanwhile at the closed position.
  const [opened, setOpened] = useState(expanded)
  const [opening, setOpening] = useState(false)
  if (opened !== expanded) {
    setOpened(expanded)
    setOpening(expanded && panel.active && !embedded)
  } else if (opening && !panel.active) {
    setOpening(false)
  }
  const intents = intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane)
  // The embedded occurrence owns no floating panes: a drag released clear of it
  // and a split request leave the shared layout unchanged.
  const effectiveIntents: DockIntents = embedded ? embeddedIntents(intents) : intents
  const panelWidth = fullscreen ? '100vw' : width === undefined ? '100%' : width
  return (
    <div
      ref={panelRef}
      className={embedded ? `${css.panel} ${css.panelEmbedded}` : css.panel}
      style={{ width: panelWidth, '--dsh-sidebar-width': typeof panelWidth === 'number' ? `${panelWidth}px` : panelWidth } as CSSProperties}
      data-sidebar-right-session={sessionId}
      data-sidebar-right-occurrence-host={variant}
      data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
      data-sidebar-right-open={expanded || undefined}
      data-sidebar-right-opening={opening || undefined}
      onTransitionEnd={opening ? () => { setOpening(false) } : undefined}
      // Dockkit hides individual docked hosts; floating descendants remain accessible.
      aria-hidden={(!expanded && surface.layout.floats.length === 0) || undefined}
    >
      <div className={css.panelBody}>
        <DockLayout
          state={surface.layout}
          canSplit={!embedded && canSplit(surface.layout) && dockPaneIds(surface.layout).length < 2}
          hideSplitWhenBlocked={embedded}
          dockOnly={embedded}
          dropZones="horizontal"
          minPaneFraction={0.2}
          canAddTab={paneId => guideIn(surface.layout, paneId) === undefined}
          canCloseTab={tabId => canCloseTab(surface, tabId)}
          intents={effectiveIntents}
          labels={dockLabels(t, panel.shortcuts.find(entry => entry.id === 'pane.split'), panel.shortcuts.find(entry => entry.id === 'page.close'))}
          renderTab={bodiesFor(panel)}
          renderTabTitle={titlesFor(panel)}
          active={active}
          keepMounted={tab => types.find(type => type.kind === tab.kind)?.keepMounted === true}
          getTabTriggerProps={panel.getTabTriggerProps} tabMenuOpen={panel.tabMenuOpen}
          chrome={<PanelChrome
            variant={variant} sessionId={sessionId} fullscreen={fullscreen} actions={actions} t={t}
            shortcuts={panel.shortcuts} toggleFullscreen={panel.toggleFullscreen}
          />}
          {...embedded ? {} : { onRoom: reportRoom }}
        />
      </div>
    </div>
  )
}

/**
 * The right column's occupant: it reports the panel's presentation to the frame
 * and renders the panel Factory in its `main` variant. It is also where the
 * frame learns the panel's presentation, because this is the seat that knows
 * it. `ctx.sidebarRight` names the effective Session itself; this seat reports
 * only what it renders with: the room its kit measured, the automatic
 * fullscreen rule of its frame width, and whether an embedded occurrence of the
 * same Session is currently drawing the panel instead.
 */
export function RightbarSeat({
  sessionId, width, viewportWidth, canShow, useStore, actions, renderFactorySlot, syncPresentation, reportAutoFullscreen,
  useDrawnElsewhere, active, retainTab,
}: RightbarSeatProps): ReactNode {
  const surface = useStore(state => state.bySession[sessionId])
  const shown = active && surface !== undefined && surface.layout.expanded
  const autoFullscreen = viewportWidth < 768
  const fullscreen = autoFullscreen || surface?.layout.mode === 'fullscreen'
  const track = shown && !autoFullscreen
  const drawnElsewhere = useDrawnElsewhere(sessionId, count => (count ?? 0) > 0)

  useEffect(() => {
    if (active && surface === undefined) actions.open(sessionId)
  }, [actions, sessionId, surface, active])

  useLayoutEffect(() => {
    if (shown && !fullscreen && !canShow) actions.setExpanded(sessionId, false)
  }, [actions, sessionId, shown, fullscreen, canShow])

  // Read only when the fullscreen command runs, after this commit has settled.
  useLayoutEffect(() => { reportAutoFullscreen(autoFullscreen) }, [reportAutoFullscreen, autoFullscreen])

  // The open/close slide needs no pulse of its own: the shell's window drag
  // watcher (ui-web) measures the marked rows every frame the surface moves and
  // sets the recall mark itself (electron#32341).

  // Fullscreen leaves the previous column report in force until its own slide
  // completes. Normal presentation and zero-duration transitions report before paint.
  useLayoutEffect(() => {
    if (!active) return
    let disposed = false
    const reportWhenCovered = (): void => {
      if (disposed) return
      // The Factory renders this occurrence unconditionally, so its panel
      // element is attached before this effect runs; a session with no surface
      // yet has nothing to measure and reports the closed state. The Session id
      // is matched as data, never interpolated into a selector.
      const panelElement = [...document.querySelectorAll<HTMLElement>(
        '[data-sidebar-right-session][data-sidebar-right-occurrence-host="main"]',
      )].find(element => element.dataset.sidebarRightSession === sessionId)
      const entering = shown && fullscreen && panelElement !== undefined
        ? panelElement.getAnimations({ subtree: true }).filter(animation =>
          'transitionProperty' in animation && animation.transitionProperty === 'transform'
          && animation.playState !== 'finished' && animation.playState !== 'idle')
        : []
      if (entering.length === 0) {
        syncPresentation({ shown, track, fullscreen })
        return
      }
      // Cancellation can replace the transition or remove it for reduced motion.
      void Promise.allSettled(entering.map(animation => animation.finished)).then(reportWhenCovered)
    }
    reportWhenCovered()
    return () => { disposed = true }
  }, [sessionId, shown, track, fullscreen, syncPresentation, active])
  // Leaving is part of that report: a seat that unmounts with its session must
  // hand the track back rather than leave one sized for a surface nobody draws.
  useLayoutEffect(() => active
    ? () => { syncPresentation({ shown: false, track: false, fullscreen: false }) }
    : undefined, [syncPresentation, active])

  // The Tab domain is not synced here: the controller adopted this session's
  // store as the runtime minted it and reconciles on the store's own commits,
  // on screen or not.

  if (surface === undefined || drawnElsewhere) return null
  return <>{renderFactorySlot('sidebar.right.panel', { variant: 'main', fullscreen, active, width, retainTab })}</>
}
