/** The local keepMounted lease of an occurrence that owns no Session reference. */
import { expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createLocalRetention } from '../src/client/shell/PanelFactory.tsx'

const TAB = 'tab1' as TabId

it('counts holds, releases on abort, and tolerates a repeated release', () => {
  const lease = createLocalRetention()
  const controller = new AbortController()
  const first = lease(TAB, controller.signal)
  const second = lease(TAB, controller.signal)
  first()
  controller.abort()
  expect(() => { second() }).not.toThrow()
})

it('returns a no-op lease for an already aborted lifetime', () => {
  const lease = createLocalRetention()
  const controller = new AbortController()
  controller.abort()
  const release = lease(TAB, controller.signal)
  expect(() => { release(); release() }).not.toThrow()
})
