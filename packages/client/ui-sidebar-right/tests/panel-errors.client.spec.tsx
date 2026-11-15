// @vitest-environment jsdom
/** A panel occurrence rendered without a Session area is reported, never drawn for another Session. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { bootPanelRuntime } from './panel-runtime.client.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A root surface that renders the embedded occurrence without wrapping it in a Session area. */
    'sidebar-right.test.root-host': { kind: 'single'; scope: 'root'; owner: { readonly embedded: boolean } }
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('reports an embedded occurrence rendered without a Session area', async () => {
  const { runtime } = await bootPanelRuntime()
  try {
    await runtime.mount({ inject: [...inject], apply })
    await runtime.root.declare(
      { 'sidebar-right.test.root-host': { kind: 'single', scope: 'root' } },
      ({ renderSlot }) => <>{renderSlot('sidebar-right.test.root-host', { embedded: true })}</>,
    )
    function Host({ renderFactorySlot }: PropsRuntime<'sidebar-right.test.root-host'> & PropsRenderFactories) {
      return <>{renderFactorySlot('sidebar.right.panel', { variant: 'embedded' })}</>
    }
    await act(async () => { runtime.slots.register({ name: 'sidebar-right.test.root-host' }, Host) })
    // The framework refuses a strict session Factory with no binding, so the
    // occurrence fails loudly instead of drawing another Session's panel.
    expect(() => runtime.renderRoot()).toThrow(/without a scope binding/)
    expect(document.querySelector('[data-sidebar-right-session]')).toBeNull()
  } finally {
    await runtime.dispose()
  }
})
