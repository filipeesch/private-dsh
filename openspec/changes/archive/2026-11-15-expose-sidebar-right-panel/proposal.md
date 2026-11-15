# Proposal

## Why

A host that already embeds the Conversation window in a surface of its own (the DSH Kanban drawer) cannot show the native right Sidebar beside that conversation. No plugin can draw it today: the tab slots are declared by another package and a plugin may only render slots it declares; the only rendering occurrence is bound to the frame's right column and the selected Conversation; and the navigation service requires an on-screen Session, so a file link inside the embedded conversation throws. The embedded conversation's expand button writes state that nothing draws, and files, document previews, terminals and the browser cannot be hosted beside the drawer's Session.

## What Changes

- Add a public Component Factory `sidebar.right.panel` (session scope) with occurrence input `{ variant: 'main' | 'embedded', fullscreen?, active?, retainTab? }`. The existing `rightbar.session` seat renders the `main` variant; the tab slots move to the Factory definition so exactly one entry declares them, and every tab type keeps registering through the same keys.
- The Factory owns the panel chrome and the tab bodies. The frame adapter keeps track, width, room reporting and the automatic fullscreen rule.
- Define the embedded occurrence: sized by its container, no frame track, no frame fullscreen report (`tabInfo.sidebar.fullscreen` stays `false`), its own `data-sidebar-right-session`, occurrence-host and dockkit markup. Docking-only chrome: tabs, add control and collapse; no split control, no fullscreen control, no float layer, and a drag released outside does nothing. Already-committed splits render; floats are not drawn.
- Share one store per Session: same layout, same tabs, same history and the same `dsh.sidebar-right.v1.<sessionId>` persistence in both occurrences. Whichever occurrence mints a Session's store adopts it — the panel or the conversation header's expand button — so Tab-domain synchronization, `openTabs`, terminal retention and Sessions the main sidebar never selected work.
- Target navigation at the embedded occurrence: while mounted and expanded it reports its Session as the Sidebar's navigation target, through a last-in-first-out layer over the main derivation that unmounting restores. File links, tool line references, files and terminal shortcuts and assistant Markdown HTTP(S) links opened from it land in it; writes stop throwing.
- Add a per-Session face on `ctx.sidebarRight`: `forSession(sessionId)` exposes `expanded` (observable), `openTabs`, `setExpanded` and `toggleExpanded` for a named Session. Reads answer before any occurrence mounts — collapsed and empty — and `setExpanded` records the intent and applies it when the Session's store is adopted instead of throwing.
- Report the capability: `ctx.sidebarRight.capabilities.embeddedPanel` is `true`. A host that finds no such capability keeps today's behavior.
- Keep two occurrences of one Session coherent: the main occurrence stops drawing that Session's panel body while an embedded occurrence is mounted and expanded; the embedded occurrence retains `keepMounted` bodies through a lease that owns no Session reference; a float open requested from the embedded occurrence settles in the docked area, and split or float requests with the embedded occurrence as the target are denied.
- Closing the last docked non-guide tab keeps today's collapse. Because the store is shared, that collapse is what the main occurrence shows for the Session as well.
- Leave the main occurrence unchanged: layout, persistence, shortcuts, float and fullscreen, and background Sessions behave as they do today.

## Capabilities

### New Capabilities

- `sidebar-right-panel`: the right Sidebar's public panel Factory and its embedded occurrence — variant inputs, page chrome, shared per-Session state and persistence, navigation targeting, the per-Session face, capability presence, focus and target capture across two occurrences, and the embedded chrome and retention rules.

### Modified Capabilities

None. No existing capability's requirements change; the new capability covers the panel Factory and the embedded occurrence.

## Impact

- `@deepseek-ai/dsh-client-ui-sidebar-right`: new Factory registrations and occurrence adapter, navigation target layer, per-Session face, occurrence-host markup; the tab-slot declarations move from the `rightbar.session` registration to the Factory definition.
- The generated client slot catalog is regenerated because a declared-by owner and the composition hierarchy change.
- `@deepseek-ai/dsh-client-ui-dockkit` gains one optional rendering prop so an occurrence can draw the docked tree without the floating hosts while keeping `keepMounted` retention. Nothing changes in `dsh-client-ui-slots`, `dsh-client-ui-renderer`, `dsh-client-ui-layout`, the layout store, or the persistence format.
- External consumers: the DSH Kanban plugin detects `ctx.sidebarRight.capabilities.embeddedPanel` and renders the Factory inside its drawer's Session area; without the capability it keeps its current behavior.
- Documentation: `docs/subsystems/sidebar-right.md`, the Slots reference hierarchy, the package README, and an implemented Agent Note.
- Out of scope: the Kanban drawer UI itself, floating panes, pane splits and fullscreen inside an embedded occurrence, cross-device layout synchronization, a general layout snapshot API, new tab types, and any guarantee for the `subagentchat` tab inside an embedded occurrence.
