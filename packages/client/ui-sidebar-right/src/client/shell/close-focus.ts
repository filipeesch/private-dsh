/** Focus continuity after page operations replace docked or floating pane elements. */
import { flushSync } from 'react-dom'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightOccurrenceHost } from '../occurrences.ts'
import { visibleSidebarPane } from '../focus.ts'

/**
 * Focus the page selected by an open or split after its DOM has committed.
 * @param document - product document owning the input focus.
 * @param sessionId - Session whose page is opening.
 * @param open - synchronous operation returning its selected pane, or undefined when unchanged.
 * @param host - occurrence host to keep focus inside; omitted searches every occurrence.
 */
export function openWithPaneFocus(
  document: Document, sessionId: SessionId, open: () => PaneId | undefined, host?: SidebarRightOccurrenceHost,
): void {
  let paneId: PaneId | undefined
  flushSync(() => { paneId = open() })
  if (paneId !== undefined) visibleSidebarPane(document, sessionId, paneId, host)?.focus({ preventScroll: true })
}

/**
 * Commit a focused page's removal before focusing a surviving visible pane.
 * @param document - product document owning the input focus.
 * @param sessionId - Session whose page is closing.
 * @param paneId - pane whose page is closing; preferred if it survives.
 * @param close - synchronous cleanup and layout removal; errors preserve focus.
 * @param host - occurrence host to keep focus inside; omitted searches every occurrence.
 */
export function closeWithPaneFocus(
  document: Document, sessionId: SessionId, paneId: PaneId, close: () => void, host?: SidebarRightOccurrenceHost,
): void {
  const before = document.activeElement
  const owner = before?.closest<HTMLElement>('[data-sidebar-right-session]')
  const source = before?.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const retain = owner?.dataset.sidebarRightSession === sessionId
    && (host === undefined || (owner.dataset.sidebarRightOccurrenceHost ?? 'main') === host)
    && (source?.dataset.dockkitPane ?? source?.dataset.dockkitFloat) === paneId
  flushSync(close)
  if (!retain || (document.activeElement !== document.body && document.activeElement !== before)) return
  visibleSidebarPane(document, sessionId, paneId, host)?.focus({ preventScroll: true })
}
