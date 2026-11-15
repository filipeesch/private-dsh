/** Shared runtime for the panel specs: production renderer, locale, shortcuts, menus, and two Sessions. */
import { vi } from 'vitest'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The Session the frame column shows in these specs. */
export const SESSION = 's-test' as SessionId
/** A second Session, used for the host surface. */
export const OTHER = 's-other' as SessionId

/**
 * Assemble the services and menus a panel occurrence needs.
 * @returns the runtime plus its frame recorder, resource pin, and shortcut catalog.
 */
export async function bootPanelRuntime() {
  const runtime = await SlotTestRuntime.create()
  const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo }
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  runtime.ctx.provide('layout', frame as never)
  runtime.ctx.provide('resources', { pin } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([])
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog } as never)
  runtime.slots.installLocale(locale)
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.sessions.add({ id: SESSION })
  await runtime.sessions.add({ id: OTHER })
  return { runtime, frame, pin, catalog }
}
