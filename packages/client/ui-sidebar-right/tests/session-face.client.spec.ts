// @vitest-environment jsdom
/** The per-Session face, embedded navigation targets, and the denial rules of an embedded context. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { guideDefinition } from '../src/client/tabs/guide/definition.ts'

const A = 's-a' as SessionId
const B = 's-b' as SessionId
const t = ((key: string) => key) as Parameters<typeof guideDefinition>[0]
const releases: Array<() => void> = []

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  localStorage.clear()
})

function harness() {
  const tabs = new SidebarRightTabRegistry(new Context())
  tabs.register(guideDefinition(t))
  tabs.register({
    id: 'test/text', kind: 'text', patterns: ['dsh-resource://file/**'], priority: 'fallback',
    title: address => address.slice(address.lastIndexOf('/') + 1),
  })
  const opens: Array<{ sessionId: SessionId; host: string }> = []
  const { controller, adopt, show, measure, enterEmbedded, drawingSource, faces } = createSidebarRightController(
    tabs, vi.fn(), {
      autoFullscreen: () => false,
      openWithFocus: (sessionId, host, open) => { opens.push({ sessionId, host }); open() },
      closeWithFocus: (_sessionId, _host, _paneId, close) => { close() },
    },
  )
  const stores = new Map<SessionId, ReturnType<ReturnType<typeof createSidebarRightStore>['create']>>()
  const mount = (sessionId: SessionId) => {
    const existing = stores.get(sessionId)
    if (existing !== undefined) return existing
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'guide' })).create(sessionId)
    instance.clearPersisted()
    stores.set(sessionId, instance)
    releases.push(adopt(sessionId, instance))
    return instance
  }
  const layoutOf = (sessionId: SessionId) => stores.get(sessionId)!.getSnapshot().bySession[sessionId]!.layout
  const titles = (sessionId: SessionId) => Object.values(layoutOf(sessionId).tabs).map(tab => tab.title)
  return {
    controller, tabs, opens, mount, layoutOf, titles, measure, enterEmbedded, drawingSource, faces,
    show: (sessionId: SessionId | undefined) => {
      show(sessionId)
      if (sessionId !== undefined) measure(sessionId, () => true)
    },
  }
}

describe('per-Session face', () => {
  it('reports the embedded-panel capability', () => {
    expect(harness().controller.capabilities.embeddedPanel).toBe(true)
  })

  it('answers reads before any occurrence mounts', () => {
    const face = harness().controller.forSession(A)
    expect(face.sessionId).toBe(A)
    expect(face.expanded.getSnapshot()).toBe(false)
    expect(face.openTabs()).toEqual([])
  })

  it('records an expansion for a Session whose panel does not exist yet', () => {
    const h = harness()
    const face = h.controller.forSession(A)
    face.setExpanded(true)
    expect(face.expanded.getSnapshot()).toBe(true)
    // The panel occurrence takes the intent once and applies it to the store it mints.
    expect(h.faces.takePending(A)).toBe(true)
    expect(h.faces.takePending(A)).toBeUndefined()
    const instance = h.mount(A)
    expect(instance.getSnapshot().bySession[A]).toBeUndefined()
    instance.actions.setExpanded(A, true)
    expect(face.expanded.getSnapshot()).toBe(true)
    face.toggleExpanded()
    expect(face.expanded.getSnapshot()).toBe(false)
  })

  it('writes only the named Session', () => {
    const h = harness()
    h.mount(A).actions.open(A)
    h.show(A)
    h.controller.forSession(B).setExpanded(true)
    expect(h.layoutOf(A).expanded).toBe(false)
    expect(h.controller.forSession(B).expanded.getSnapshot()).toBe(true)
  })

  it('follows store commits made by any surface', () => {
    const h = harness()
    const instance = h.mount(A)
    h.show(A)
    instance.actions.setExpanded(A, true)
    expect(h.controller.forSession(A).expanded.getSnapshot()).toBe(true)
    instance.actions.setExpanded(A, false)
    expect(h.controller.forSession(A).expanded.getSnapshot()).toBe(false)
  })
})

describe('embedded navigation targets', () => {
  it('acts on the embedded Session while it is reported and restores the on-screen one', () => {
    const h = harness()
    h.mount(A)
    h.mount(B)
    h.show(A)
    h.mount(A).actions.setExpanded(A, true)
    h.controller.openResource('dsh-resource://file/session/s-a/a.txt')
    expect(h.titles(A)).toContain('a.txt')
    h.mount(B).actions.setExpanded(B, true)
    const leave = h.enterEmbedded(B)
    h.controller.openResource('dsh-resource://file/session/s-b/b.txt')
    expect(h.titles(B)).toContain('b.txt')
    expect(h.titles(A)).not.toContain('b.txt')
    // The on-screen derivation is untouched by the report.
    expect(h.controller.mounted.getSnapshot()).toBe(A)
    leave()
    h.controller.openResource('dsh-resource://file/session/s-a/c.txt')
    expect(h.titles(A)).toContain('c.txt')
    expect(h.titles(B)).not.toContain('c.txt')
  })

  it('nests two reported occurrences and restores the most recent release', () => {
    const h = harness()
    for (const id of [A, B]) {
      h.mount(id)
      h.mount(id).actions.setExpanded(id, true)
    }
    h.show(A)
    const leaveB = h.enterEmbedded(B)
    h.controller.openTab('guide', { revealIfOpened: false })
    expect(h.titles(B).filter(title => title === 'guide')).toHaveLength(1)
    const leaveC = h.enterEmbedded(A)
    h.controller.openResource('dsh-resource://file/session/s-a/from-embedded.txt')
    expect(h.titles(A)).toContain('from-embedded.txt')
    leaveC()
    h.controller.openResource('dsh-resource://file/session/s-b/after-restore.txt')
    expect(h.titles(B)).toContain('after-restore.txt')
    leaveB()
  })

  it('denies split and float and settles a floating destination in the docked column', () => {
    const h = harness()
    for (const id of [A, B]) {
      h.mount(id)
      h.mount(id).actions.setExpanded(id, true)
    }
    h.show(A)
    const leave = h.enterEmbedded(B)
    const tabId = Object.keys(h.layoutOf(B).tabs)[0]! as TabId
    expect(h.controller.split()).toBeUndefined()
    h.controller.float(tabId)
    expect(h.layoutOf(B).floats).toEqual([])
    h.controller.openResource('dsh-resource://file/session/s-b/floating.txt', { destination: 'float' })
    expect(h.layoutOf(B).floats).toEqual([])
    expect(h.titles(B)).toContain('floating.txt')
    leave()
    // The frame occurrence keeps its own abilities.
    expect(h.controller.split()).toBeDefined()
  })
})

describe('closing the last docked tab', () => {
  it('collapses the shared column and leaves an existing floating pane alone', () => {
    const h = harness()
    const instance = h.mount(A)
    h.show(A)
    instance.actions.setExpanded(A, true)
    const open = (name: string) => {
      instance.actions.openContent(A, { kind: 'text', contentId: `dsh-resource://file/session/s-a/${name}`, title: name }, () => {})
      return Object.values(h.layoutOf(A).tabs).find(tab => tab.title === name)!
    }
    const first = open('a.txt')
    const floating = open('b.txt')
    instance.actions.floatTab(A, floating.id)
    const guide = Object.values(h.layoutOf(A).tabs).find(tab => tab.kind === 'guide')!
    h.controller.closeIn(A, guide.id)
    expect(h.layoutOf(A).tabs[guide.id]).toBeUndefined()
    h.controller.closeIn(A, first.id)
    expect(h.layoutOf(A).tabs[first.id]).toBeUndefined()
    expect(h.layoutOf(A).expanded).toBe(false)
    // The floating record survives the collapse.
    expect(h.layoutOf(A).floats).toHaveLength(1)
    expect(h.layoutOf(A).tabs[floating.id]).toBeDefined()
  })
})
it('coerces a floating destination only for the Session the embedded occurrence draws', () => {
  const h = harness()
  for (const id of [A, B]) {
    h.mount(id)
    h.mount(id).actions.setExpanded(id, true)
  }
  h.show(A)
  const leave = h.enterEmbedded(B)
  // A tab action aimed at another Session still floats there.
  h.controller.openResourceIn(A, 'dsh-resource://file/session/s-a/other-session.txt', { destination: 'float' })
  expect(h.layoutOf(A).floats).toHaveLength(1)
  // The embedded occurrence's own Session settles in the docked area.
  h.controller.openResource('dsh-resource://file/session/s-b/b.txt', { destination: 'float' })
  expect(h.layoutOf(B).floats).toEqual([])
  expect(h.titles(B)).toContain('b.txt')
  leave()
})
