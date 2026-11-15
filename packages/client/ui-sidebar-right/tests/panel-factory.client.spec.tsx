// @vitest-environment jsdom
/** Both panel occurrences through the production slot renderer, over one Session store. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { SlotTestRuntime, type SlotView } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { SidebarRightTabInjected, SidebarRightTabInfo } from '../src/client/contract/slots.ts'
import { tabInfoFactory } from '../src/client/tab-info.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'
import { embeddedIntents } from '../src/client/shell/SidebarRight.tsx'
import { OTHER, SESSION, bootPanelRuntime } from './panel-runtime.client.ts'

declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A host surface standing in for the embedder: it renders the embedded occurrence in its own box. */
    'sidebar-right.test.host': { kind: 'single'; scope: 'session'; owner: { readonly embedded: boolean } }
  }
  interface SlotFactoryMap {
    /** A second definition that tries to claim the tab seats the panel Factory already owns. */
    'sidebar-right.test.duplicate': {
      scope: 'session'
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session'; inject: SidebarRightTabInjected }
      }
    }
  }
}

type StoreInstance = ReturnType<ReturnType<typeof createSidebarRightStore>['create']>

const runtimes: SlotTestRuntime[] = []

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(Element.prototype, 'getAnimations')
  }
})

/** A host surface of its own, like a drawer: it owns the box and renders the embedded occurrence. */
function EmbeddedHost({ embedded, renderFactorySlot }: PropsRuntime<'sidebar-right.test.host'> & PropsRenderFactories) {
  return (
    <div data-embedded-host="" style={{ width: 360, height: 480 }}>
      {embedded ? renderFactorySlot('sidebar.right.panel', { variant: 'embedded' }) : null}
    </div>
  )
}

async function mountPanel(keepMounted = false) {
  const { runtime, frame } = await bootPanelRuntime()
  runtimes.push(runtime)
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'sidebar-right.test.host': { kind: 'single', scope: 'session' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  const main = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'mainView' })
  const other = runtime.sessions.retainFor(runtime.ctx, OTHER, { source: 'mainView' })
  await runtime.mount({ inject: [...inject], apply })
  await act(async () => { runtime.slots.register({ name: 'sidebar-right.test.host' }, EmbeddedHost) })
  const bodies = new Map<string, SidebarRightTabInfo>()
  const mounts = new Map<string, number>()
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    const info = props.useTabInfo()
    bodies.set(info.tab.id, info)
    if (!mounts.has(info.tab.id)) mounts.set(info.tab.id, mounts.size + 1)
    return <span data-tab-body={info.tab.id} data-instance={mounts.get(info.tab.id)} data-kind={info.tab.kind} />
  }
  function Title({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
    return <span data-tab-title={useTabInfo().tab.id} />
  }
  await act(async () => {
    runtime.ctx.sidebarRightTabs.register({
      id: 'test/text', kind: 'text', priority: 'builtin', patterns: ['dsh-resource://file/**'],
      title: address => address.slice(address.lastIndexOf('/') + 1), keepMounted,
    })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/text' }, Body)
    runtime.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'test/text' }, Title)
  })
  const mainView: SlotView<'rightbar'> = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
  const hostView = (embedded: boolean, session = other): SlotView<'sidebar-right.test.host'> =>
    runtime.renderSlot('sidebar-right.test.host', { embedded }, { session })
  const controller = runtime.ctx.sidebarRight
  const instanceOf = (id: SessionId) => runtime.storeOf('rightbar.session', id === SESSION ? main : other) as StoreInstance
  const surfaceOf = (id: SessionId) => instanceOf(id).getSnapshot().bySession[id]
  const open = (id: SessionId, name: string): void => {
    act(() => { controller.openResourceIn(id, `dsh-resource://file/session/${id}/${name}`) })
  }
  return { runtime, frame, controller, mainView, hostView, bodies, mounts, main, other, instanceOf, surfaceOf, open, Body }
}

it('renders the frame and the embedded occurrence of one Session from one store', async () => {
  const h = await mountPanel()
  h.open(SESSION, 'a.txt')
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-tab-body]')).not.toBeNull() })
  const tabId = Object.keys(h.surfaceOf(SESSION)!.layout.tabs)[0]!
  // The embedded occurrence of the same Session expands: the frame stops drawing that body.
  act(() => { h.controller.forSession(SESSION).setExpanded(true) })
  const host = h.hostView(true, h.main)
  await waitFor(() => { expect(host.container.querySelector('[data-sidebar-right-open]')).not.toBeNull() })
  expect(host.container.querySelector('[data-sidebar-right-occurrence-host="embedded"]')).not.toBeNull()
  await waitFor(() => { expect(document.querySelectorAll('[data-tab-body]').length).toBe(1) })
  expect(h.mainView.container.querySelector('[data-tab-body]')).toBeNull()
  // The shared layout reaches the embedded body, whose fullscreen is always false.
  act(() => { h.instanceOf(SESSION).actions.setMode(SESSION, 'fullscreen') })
  await waitFor(() => { expect(h.bodies.get(tabId)?.sidebar.fullscreen).toBe(false) })
  // Unmounting the embedded occurrence hands the body back to the frame occurrence.
  act(() => { host.update({ embedded: false }) })
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-tab-body]')).not.toBeNull() })
  expect(document.querySelectorAll('[data-tab-body]').length).toBe(1)
})

it('draws no split, fullscreen or floating affordance in an embedded occurrence', async () => {
  const h = await mountPanel()
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-dockkit-strip]')).not.toBeNull() })
  expect(host.container.querySelector('[data-sidebar-right-toggle]')).not.toBeNull()
  expect(host.container.querySelector('[data-dockkit-split-button]')).toBeNull()
  expect(host.container.querySelector('[data-sidebar-right-mode]')).toBeNull()
  expect(host.container.querySelector('[data-dockkit-float]')).toBeNull()
  h.open(OTHER, 'b.txt')
  await waitFor(() => { expect(host.container.querySelector('[data-tab-body]')).not.toBeNull() })
  const openTabs = h.controller.forSession(OTHER).openTabs()
  expect(openTabs.length).toBeGreaterThan(0)
  expect(openTabs.every(tab => tab.sessionId === OTHER)).toBe(true)
  // The layout keeps no floating pane when an embedded occurrence is the target.
  act(() => { h.controller.float(Object.keys(h.surfaceOf(OTHER)!.layout.tabs)[0]! as TabId) })
  expect(h.surfaceOf(OTHER)!.layout.floats).toEqual([])
  act(() => { h.controller.split() })
  expect(Object.values(h.surfaceOf(OTHER)!.layout.nodes).filter(node => node.kind === 'split')).toEqual([])
})

it('keeps the embedded occurrence out of the Session reference bookkeeping', async () => {
  const h = await mountPanel()
  const retained = vi.spyOn(h.runtime.sessions, 'retain')
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  h.hostView(true)
  await waitFor(() => { expect(h.controller.forSession(OTHER).openTabs().length).toBeGreaterThan(0) })
  expect(retained).not.toHaveBeenCalled()
})

it('mounts the embedded occurrence without asking the frame for a track', async () => {
  const h = await mountPanel()
  const opened = h.frame.openRightbar.mock.calls.length
  const closed = h.frame.closeRightbar.mock.calls.length
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  h.hostView(true)
  await waitFor(() => { expect(h.controller.forSession(OTHER).openTabs().length).toBeGreaterThan(0) })
  expect(h.frame.openRightbar.mock.calls.length).toBe(opened)
  expect(h.frame.closeRightbar.mock.calls.length).toBe(closed)
})

it('applies an expansion recorded before the embedded panel existed', async () => {
  const h = await mountPanel()
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  expect(h.controller.forSession(OTHER).expanded.getSnapshot()).toBe(true)
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-sidebar-right-open]')).not.toBeNull() })
  expect(h.controller.forSession(OTHER).openTabs().length).toBeGreaterThan(0)
})

it('renders every shipped tab type in an embedded occurrence', async () => {
  const h = await mountPanel()
  await act(async () => {
    for (const [id, kind] of [
      ['@deepseek-ai/dsh-client-ui-sidebar-files', 'files'],
      ['@deepseek-ai/dsh-client-ui-sidebar-terminal', 'terminal'],
      ['@deepseek-ai/dsh-client-ui-sidebar-browser', 'browser'],
    ] as const) {
      h.runtime.ctx.sidebarRightTabs.register({ id, kind, multiple: kind !== 'files', title: () => kind })
      h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: id }, h.Body)
    }
  })
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-sidebar-right-open]')).not.toBeNull() })
  const activeKind = async (kind: string): Promise<void> => {
    await waitFor(() => {
      const body = host.container.querySelector('[data-tab-body]')
      expect(body).not.toBeNull()
      expect(body!.getAttribute('data-kind')).toBe(kind)
    })
  }
  for (const kind of ['files', 'terminal', 'browser'] as const) {
    act(() => { h.controller.openTab(kind) })
    await activeKind(kind)
  }
  // The text type claims the file address the resource model offers.
  h.open(OTHER, 'image.png')
  await activeKind('text')
})

it('shares one store instance between the frame seat, the panel and the header button', async () => {
  const h = await mountPanel()
  const seatStore = h.runtime.storeOf('rightbar.session', h.main)
  const headerStore = h.runtime.storeOf('conversation.session.header.corner', h.main)
  expect(headerStore).toBe(seatStore)
  const factory = h.runtime.factoryOf('sidebar.right.panel')
  expect(factory.name).toBe('sidebar.right.panel')
  expect(factory.scope).toBe('session')
  expect(factory.children === undefined ? [] : Object.keys(factory.children)).toEqual([
    'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
  ])
})

it.each([false, true])('keeps a visited body mounted in the embedded occurrence (keepMounted: %s)', async (keepMounted) => {
  const h = await mountPanel(keepMounted)
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-sidebar-right-open]')).not.toBeNull() })
  h.open(OTHER, 'first.txt')
  const firstTab = await waitFor(() => {
    const found = Object.values(h.surfaceOf(OTHER)!.layout.tabs).find(tab => tab.title === 'first.txt')
    expect(found).toBeDefined()
    return found!
  })
  await waitFor(() => { expect(host.container.querySelector('[data-tab-body="' + firstTab.id + '"]')).not.toBeNull() })
  const firstBody = host.container.querySelector(`[data-tab-body="${firstTab.id}"]`)
  h.open(OTHER, 'second.txt')
  const secondTab = await waitFor(() => {
    const found = Object.values(h.surfaceOf(OTHER)!.layout.tabs).find(tab => tab.title === 'second.txt')
    expect(found).toBeDefined()
    return found!
  })
  await waitFor(() => { expect(host.container.querySelector('[data-tab-body="' + secondTab.id + '"]')).not.toBeNull() })
  // A retained body stays mounted while hidden; a type without retention drops it.
  const whileHidden = host.container.querySelector('[data-tab-body="' + firstTab.id + '"]')
  if (keepMounted) expect(whileHidden).toBe(firstBody)
  else expect(whileHidden).toBeNull()
  act(() => { h.instanceOf(OTHER).actions.focusTab(OTHER, firstTab.id) })
  const revisited = await waitFor(() => {
    const body = host.container.querySelector('[data-tab-body="' + firstTab.id + '"]')
    expect(body).not.toBeNull()
    return body
  })
  if (keepMounted) expect(revisited).toBe(firstBody)
  else expect(revisited).not.toBe(firstBody)
})
it('measures the host box once the occurrence has a surface', async () => {
  const h = await mountPanel()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 321, height: 480, top: 0, left: 0, right: 321, bottom: 480, x: 0, y: 0, toJSON: () => ({}),
  })
  const observed: Element[] = []
  class Observer {
    constructor(private readonly callback: () => void) {}
    observe(element: Element): void { observed.push(element); this.callback() }
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-sidebar-right-open]')).not.toBeNull() })
  await waitFor(() => {
    expect(host.container.querySelector<HTMLElement>('[data-sidebar-right-session]')?.style.width).toBe('321px')
  })
  expect(observed.length).toBeGreaterThan(0)
})

it('reports a second definition that claims the tab seats', async () => {
  const h = await mountPanel()
  expect(() => h.runtime.slots.registerFactory({
    name: 'sidebar-right.test.duplicate',
    scope: 'session',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
    },
  }, () => null)).toThrow(/already declared/)
})

it('keeps the frame occurrence from replaying its entrance when the host releases the bodies', async () => {
  const h = await mountPanel()
  h.open(SESSION, 'a.txt')
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-tab-body]')).not.toBeNull() })
  act(() => { h.controller.forSession(SESSION).setExpanded(true) })
  const host = h.hostView(true, h.main)
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-tab-body]')).toBeNull() })
  act(() => { host.update({ embedded: false }) })
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-tab-body]')).not.toBeNull() })
  expect(h.mainView.container.querySelector('[data-sidebar-right-opening]')).toBeNull()
})

it('captures focus from the occurrence that owns the element', async () => {
  const h = await mountPanel()
  h.open(SESSION, 'a.txt')
  await waitFor(() => { expect(h.mainView.container.querySelector('[data-dockkit-tab]')).not.toBeNull() })
  act(() => { h.controller.forSession(OTHER).setExpanded(true) })
  const host = h.hostView(true)
  await waitFor(() => { expect(host.container.querySelector('[data-dockkit-tab]')).not.toBeNull() })
  h.open(OTHER, 'b.txt')
  await waitFor(() => { expect(host.container.querySelector('[data-tab-body]')).not.toBeNull() })
  const embeddedChip = host.container.querySelector<HTMLElement>('[data-dockkit-tab]')!
  embeddedChip.focus()
  expect(h.controller.focusedTarget()).toMatchObject({ sessionId: OTHER, occurrenceHost: 'embedded' })
  const mainChip = h.mainView.container.querySelector<HTMLElement>('[data-dockkit-tab]')!
  mainChip.focus()
  expect(h.controller.focusedTarget()).toBeUndefined()
  act(() => { host.update({ embedded: false }) })
  mainChip.focus()
  expect(h.controller.focusedTarget()).toMatchObject({ sessionId: SESSION, occurrenceHost: 'main' })
})

it('pins floating and splitting to no-ops in an embedded occurrence', () => {
  const calls: string[] = []
  const intents = embeddedIntents({
    focusTab: () => calls.push('focusTab'),
    focusPane: () => calls.push('focusPane'),
    splitPane: () => calls.push('splitPane'),
    addTab: () => calls.push('addTab'),
    closeTab: () => calls.push('closeTab'),
    duplicateTab: () => calls.push('duplicateTab'),
    floatTab: () => calls.push('floatTab'),
    unfloatPane: () => calls.push('unfloatPane'),
    placeTab: () => calls.push('placeTab'),
    dropTab: () => calls.push('dropTab'),
    moveFloat: () => calls.push('moveFloat'),
    resizeFloat: () => calls.push('resizeFloat'),
    resizeSplit: () => calls.push('resizeSplit'),
  })
  intents.floatTab('tab1' as TabId)
  intents.unfloatPane('pane1' as never)
  intents.splitPane('pane1' as never)
  intents.focusTab('tab1' as TabId)
  expect(calls).toEqual(['focusTab'])
})
