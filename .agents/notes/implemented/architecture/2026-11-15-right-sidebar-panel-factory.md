# Agent Note: Right Sidebar panel Factory

Status: implemented

English | [中文](2026-11-15-right-sidebar-panel-factory.zh.md)

## Problem

A host that renders an embedded Conversation could not render the right Sidebar beside it. Three facts blocked it. The tab extension seats were declared by the frame seat, so any other component that rendered them failed the ownership check; the only occurrence the plugin drew belonged to the frame's right column and required the Conversation to occupy the main column; and the navigation service acted only on the on-screen Session, so a file link inside an embedded conversation threw for lack of a mounted surface. The embedded conversation's expand button wrote an expansion into a session store that nothing drew.

## Decision

The right Sidebar is exposed as the public Component Factory `sidebar.right.panel`, session scoped, with the occurrence input `{ variant: 'main' | 'embedded', fullscreen?, active?, width?, retainTab? }`. The frame's `rightbar.session` seat keeps computing track, width, presentation, and the automatic fullscreen rule, then renders the Factory in the `main` variant and passes those facts. A host renders `renderFactorySlot('sidebar.right.panel', { variant: 'embedded' })` inside the Session area it holds; the occurrence takes the Session from that render position, fills and measures its container, and owns its own chrome.

The Factory declares `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` for its registered definition, and the frame seat declares neither. Consumers register through `ctx.slots.inject` and re-run per declaration epoch, so moving the declaration to the Factory changed no tab type and no shipped type's registration path.

Both occurrences declare the same store handle. The slot runtime resolves one instance per handle and Session, so layout, open tabs, history, and the `dsh.sidebar-right.v1.<sessionId>` entry are one state, and whichever occurrence mints the store adopts it, including the conversation header's expand button with no panel mounted.

A new occurrence ledger gives the embedded occurrence two roles while it is mounted and expanded. It is the navigation target, through a last-in-first-out layer over the on-screen derivation, so opens issued from inside it land in it and releasing it restores the previous target. It also suppresses the frame occurrence's panel body for that Session, so each open tab has one mounted body; the presentation the frame seat reports stays exactly what it reports without an embedded occurrence.

The per-Session face `ctx.sidebarRight.forSession(sessionId)` answers before any occurrence mounts: `expanded` reads false, `openTabs()` reads empty, and a write records the intent that the panel occurrence applies in a layout effect once the Session's store exists. No store instance is minted outside a registration, which keeps the runtime's scope release authoritative. `ctx.sidebarRight.capabilities.embeddedPanel` lets a host detect the surface and keep its own behavior when it is absent.

An embedded occurrence draws docking chrome only: tabs, add control, and collapse; committed splits render, while split and float affordances are absent and a drag released outside changes nothing. Floating panes keep their records and stay drawn by the frame occurrence. Closing the last docked non-guide tab keeps the existing collapse, which the shared store makes visible in the frame occurrence as well. Focus and target capture carry the occurrence host, so two occurrences of one Session do not answer for each other.

The docking kit gained one optional rendering prop, `dockOnly`, so an occurrence can render the docked tree while retaining `keepMounted` bodies without mounting floating hosts. The alternative was a second renderer or a forged layout state.

The [docking infrastructure note](../feature/2026-09-04-right-sidebar-docking-infrastructure.md) owns the layout engine, the frame column, and the per-session state this composition renders.

## Alternatives considered

Duplicating the panel markup for the embedded variant was rejected: two places for focus markers, chrome, and locale would drift, and the ownership rule would still require the Factory. A per-occurrence store from the Factory's exclusive store factory was rejected because that axis refuses persistence and would diverge the two occurrences of one Session. Suppressing the frame body for any mounted embedded occurrence, collapsed or not, was rejected because it would blank the frame column for a Session the user is looking at with no visible panel anywhere. Projecting a floats-free layout state for rendering was rejected as synthetic state the kit's invariants do not know about. A dedicated optional service for capability detection was rejected in favor of one readonly field, and adding a `factory()` lookup to the SlotRegistry was rejected as a framework surface added for one product question. A new locale string to refuse split and fullscreen shortcuts inside a host surface was left out; those commands are silent no-ops there.

## Consequences

The frame occurrence keeps its presentation, persistence, shortcuts, float and fullscreen behavior, and background Sessions. The merged surface is concentrated in the sidebar package's slot contract, plugin registration, frame seat, controller, focus helpers, and one additive prop in the docking kit; the generated client slot catalog records the new declaration owner.

An embedded occurrence cannot show a floating pane, so an open that requests a floating host settles in the docked area, and keyboard split and fullscreen commands with focus inside it do nothing. Because the store is shared, expanding or collapsing in a host surface is what the frame column shows for that Session when it returns. The `subagentchat` tab renders inside an embedded occurrence through the ordinary keyed seat but carries no dedicated guarantee.
