/**
 * Where a Session's panel is drawn, and which occurrence the Sidebar's
 * navigation acts on.
 *
 * The frame's right column is the fallback host: its Session comes from the
 * on-screen derivation the plugin publishes. A host surface that mounts an
 * embedded occurrence reports itself here while it is mounted and expanded, so
 * opens issued from inside it land in it and the main occurrence stops drawing
 * the same bodies; releasing that report restores the previous target.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A surface that can draw one Session's panel. */
export type SidebarRightOccurrenceHost = 'main' | 'embedded'

/** One reported navigation target: the Session to act on and the occurrence drawing it. */
export interface SidebarRightOccurrenceTarget {
  readonly sessionId: SessionId
  readonly host: SidebarRightOccurrenceHost
}

/**
 * Target stack and drawing ledger for panel occurrences.
 *
 * The stack is last-in-first-out: the most recently entered embedded occurrence
 * wins, and releasing it restores whatever was current before. The drawing
 * ledger counts embedded occurrences per Session so the frame occurrence can
 * leave the bodies to them.
 */
export class SidebarRightOccurrences {
  private readonly stack: SidebarRightOccurrenceTarget[] = []
  private readonly drawing = new Map<SessionId, SnapshotStore<number>>()

  /**
   * Enter one embedded occurrence while it is mounted and expanded.
   * @param sessionId - the Session whose panel it draws.
   * @returns idempotent release restoring the previous target and count.
   */
  enterEmbedded(sessionId: SessionId): () => void {
    const entry: SidebarRightOccurrenceTarget = { sessionId, host: 'embedded' }
    this.stack.push(entry)
    const source = this.drawingSource(sessionId)
    source.set(source.getSnapshot() + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const index = this.stack.lastIndexOf(entry)
      if (index !== -1) this.stack.splice(index, 1)
      source.set(source.getSnapshot() - 1)
    }
  }

  /**
   * The target the Sidebar's navigation should act on.
   * @returns the most recently entered embedded occurrence, or undefined when the main derivation decides.
   */
  current(): SidebarRightOccurrenceTarget | undefined {
    return this.stack[this.stack.length - 1]
  }

  /**
   * How many embedded occurrences are drawing one Session's panel.
   * @param sessionId - the Session whose occurrences are counted.
   * @returns an observable count, stable per Session.
   */
  drawingSource(sessionId: SessionId): SnapshotStore<number> {
    let source = this.drawing.get(sessionId)
    if (source === undefined) {
      source = createSnapshotStore(0)
      this.drawing.set(sessionId, source)
    }
    return source
  }

  /**
   * Forget every ledger entry of a Session whose scope ended.
   * @param sessionId - the removed Session.
   */
  forget(sessionId: SessionId): void {
    this.drawing.delete(sessionId)
  }
}
