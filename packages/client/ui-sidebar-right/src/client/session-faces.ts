/**
 * Per-Session reads and writes for the right Sidebar, independent of which
 * Session the main column shows.
 *
 * A Session's panel state lives in that Session's store instance, which the
 * slot runtime mints when an occurrence mounts. A host that wants to open a
 * rail before any occurrence exists must still be able to ask whether the
 * column is expanded and to record that it wants it expanded; this face keeps
 * that intent beside the observable the host subscribes to, and the panel
 * occurrence applies it once the store exists.
 */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SurfaceActions } from './service.ts'
import type { SidebarRightOpenTab } from './tab-inventory.ts'

/** Reads and writes for one named Session's panel. */
export interface SidebarRightSessionFace {
  /** The Session this face speaks for. */
  readonly sessionId: SessionId
  /**
   * Whether this Session's column is expanded. Answers `false` before any
   * occurrence mounted, and follows the store afterwards.
   */
  readonly expanded: ObservableSnapshot<boolean>
  /**
   * The Session's open tabs as metadata.
   * @returns committed records, or an empty list before its panel exists.
   */
  openTabs(): readonly SidebarRightOpenTab[]
  /**
   * Expand or collapse this Session's column. A Session whose store does not
   * exist yet records the intent; the panel occurrence applies it when the
   * store is minted.
   * @param expanded - the wanted state.
   */
  setExpanded(expanded: boolean): void
  /** Flip this Session's expansion; see {@link setExpanded}. */
  toggleExpanded(): void
}

/** What the faces read besides their own state. */
interface SidebarRightSessionFaceDeps {
  /** One Session's open tab metadata. */
  openTabs(sessionId: SessionId): readonly SidebarRightOpenTab[]
  /** One Session's adopted store actions, when its store exists. */
  actionsFor(sessionId: SessionId): SurfaceActions | undefined
}

/** One face and the observable behind it. */
interface FaceEntry {
  readonly source: SnapshotStore<boolean>
  readonly face: SidebarRightSessionFace
}

/**
 * Faces keyed by Session, each with its own observable and pending intent.
 *
 * The controller syncs the observable from every store commit, so a write made
 * through the store's actions by any surface is visible here too.
 */
export class SidebarRightSessionFaces {
  private readonly entries = new Map<SessionId, FaceEntry>()
  private readonly pending = new Map<SessionId, boolean>()

  /** @param deps - open tab metadata and adopted store actions. */
  constructor(private readonly deps: SidebarRightSessionFaceDeps) {}

  /**
   * Read or create one Session's face.
   * @param sessionId - the Session to address.
   * @returns the stable face for that Session.
   */
  forSession(sessionId: SessionId): SidebarRightSessionFace {
    return this.entry(sessionId).face
  }

  /**
   * Publish the expanded state one Session's store committed.
   * @param sessionId - the Session whose store committed.
   * @param expanded - the committed expansion.
   */
  syncExpanded(sessionId: SessionId, expanded: boolean): void {
    this.entry(sessionId).source.set(expanded)
  }

  /**
   * Take the expansion a Session's panel must apply when it mounts.
   * @param sessionId - the Session whose panel is mounting.
   * @returns the recorded intent, or `undefined` when there is none.
   */
  takePending(sessionId: SessionId): boolean | undefined {
    const pending = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    return pending
  }

  /**
   * Drop one Session's face and intent.
   * @param sessionId - the Session whose scope ended.
   */
  forget(sessionId: SessionId): void {
    this.entries.delete(sessionId)
    this.pending.delete(sessionId)
  }

  private entry(sessionId: SessionId): FaceEntry {
    let entry = this.entries.get(sessionId)
    if (entry !== undefined) return entry
    const source = createSnapshotStore(false)
    const setExpanded = (expanded: boolean): void => {
      const actions = this.deps.actionsFor(sessionId)
      if (actions === undefined) {
        this.pending.set(sessionId, expanded)
        source.set(expanded)
        return
      }
      this.pending.delete(sessionId)
      actions.setExpanded(sessionId, expanded)
      source.set(expanded)
    }
    entry = {
      source,
      face: {
        sessionId,
        expanded: source,
        openTabs: () => this.deps.openTabs(sessionId),
        setExpanded,
        toggleExpanded: () => { setExpanded(!source.getSnapshot()) },
      },
    }
    this.entries.set(sessionId, entry)
    return entry
  }
}
