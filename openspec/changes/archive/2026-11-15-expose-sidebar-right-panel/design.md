# Design

## Context

The right Sidebar owns one session-scoped slot store whose state partitions layouts by Session (`packages/client/ui-sidebar-right/src/client/stores.ts`), a root-scoped `rightbar` seat that mounts a `rightbar.session` subtree per retained Session (`shell/RightbarRoot.tsx`), and the `rightbar.session` seat that both declares the tab extension seats and draws the panel (`src/client/index.ts`, `shell/SidebarRight.tsx`). Presentation flows outward through `syncPresentation` into `ctx.layout`, and the navigation service answers from the on-screen Session only (`service.ts`: `mounted`, `screen()`, `require()`). `ctx.sidebarRight.mounted` is cleared when a main panel occupies the frame.

Three constraints shape the approach:

- Slot ownership: `renderSlot` is authorized per declaring registration, so a host can only draw the tab seats from inside an occurrence of the entry that declares them.
- Upstream compatibility: this repository is a private distribution that merges the upstream harness, so the change stays additive where possible and concentrates edits in as few files as the requirement allows. The `conversation.window` Factory (`openspec/specs/conversation-window/spec.md`) is the precedent for the same move.
- One store per Session: persistence key `dsh.sidebar-right.v1.<sessionId>` and the Tab domain already assume one layout per Session, so two occurrences must share one store instance rather than synchronize two.

The docking kit separates the docked tree (`DockSurface` → `PaneTree`) from the retained tab layout (`DockLayout` → `TabLayout`). Only `TabLayout` implements `keepMounted` retention, and it mounts a host for every record in `state.tabs`, floating panes included.

## Goals / Non-Goals

**Goals:**

- One public panel Factory that a foreign host can render with a variant input, with the existing seat rendering the `main` variant through it.
- An embedded occurrence that owns its presentation, its chrome, and its navigation targeting without changing the frame's column behavior.
- Shared per-Session state, persistence, adoption and retention across two occurrences.
- A detectable capability and a per-Session face that answer before any occurrence mounts.
- A small, reviewable diff against upstream: additive APIs and new modules; existing behavior preserved.

**Non-Goals:**

- The Kanban drawer UI, its rail width, its split, or its narrow-layout decisions.
- Floating panes, pane splits and fullscreen inside an embedded occurrence.
- Cross-device layout synchronization, a general layout snapshot API, or new tab types.
- Any guarantee for the `subagentchat` tab inside an embedded occurrence (it renders through the ordinary keyed seat, without dedicated coverage).
- Refactors parked outside this change: splitting the controller service, splitting the injected face, centralizing the `data-sidebar-right-*` attribute literals, and stale prose cleanup.

## Decisions

### D1. The Factory is the panel; the existing seat becomes the frame adapter

`SlotFactoryMap['sidebar.right.panel']` declares `scope: 'session'`, input `{ variant: 'main' | 'embedded', fullscreen?: boolean, active?: boolean, width?: number, retainTab?: RetainTab }`, the `sidebarRight` locale namespace, the same store handle, the panel inject face, and the tab-seat `children`. `width` stays a frame fact: the collapsed column keeps its size while the panel slides out of it, which a percentage width cannot express.

The new `shell/PanelFactory.tsx` renders the panel: it reads the store and the injected face, builds the panel props, chooses the docking surface by variant, measures its container, enters the navigation-target layer while expanded, applies a pending expansion intent, and supplies the retention lease. The existing `SidebarPanel` stays in `shell/SidebarRight.tsx` behind an `export` plus a `variant` prop; `RightbarSeat` keeps the presentation effects (shown/track/fullscreen/canShow, room reporting, auto-fullscreen reporting) and renders `renderFactorySlot('sidebar.right.panel', { variant: 'main', fullscreen, active, retainTab })`.

Alternatives considered: duplicating the panel markup in a new embedded component (rejected — two places for focus attributes, chrome and locale, guaranteed drift); keeping the panel rendering outside the Factory (impossible — the Factory declares the tab seats, so only its occurrences may render them).

### D2. Tab-seat declarations move to the Factory in the same registration effect

`sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` move from the `rightbar.session` registration to the `registerFactory` call, together with the inject members the tab bodies consume (`tabTypes`, `tabNavigation`, `occurrence`, `closeTab`, `openTab`, `splitPane`, `flash`, `shortcuts`, `contextMenuTarget`). Registering the Factory and registering the `rightbar` seat stay in one `ctx.effect`, so no window exists where two registrations declare the same seats and the load-time duplicate-declaration check never fires.

Consumers keep working unchanged because they wait on the declaration through `ctx.slots.inject(key, ...)`, which re-runs per `declarationEpoch`; the guide and every shipped tab type in this repository use that form.

### D3. One store handle declared by both registrations

The Factory declares `store: handle` — the same handle the `rightbar.session` and `conversation.session.header.corner` registrations already declare — so the runtime resolves one instance per (handle × Session) and both occurrences read and write the same layout, history and persistence. The wrapper `create` that restores persistence and reports adoption stays exactly where it is.

The alternative, `store: () => handle`, mints an exclusive per-occurrence store and is rejected twice over: the runtime refuses persistence on that axis, and two occurrences of one Session would diverge.

### D4. The main occurrence stops drawing a Session whose panel the embedded occurrence draws

A new `occurrences.ts` holds two small owners: a drawing registry (per Session, the embedded occurrences currently drawing) and the navigation-target layer from D5. The adapter reads the drawing registry for its Session and, while an embedded occurrence is mounted and expanded, renders no panel body. The presentation effects are untouched, so the frame report stays exactly what it is today when no embedded occurrence exists.

Alternatives considered: letting both occurrences draw (rejected — two xterm or iframe bodies for one tab, and a focus target for each); suppressing the main occurrence for any mounted embedded occurrence including a collapsed one (rejected — it would blank the main column for a Session the user is looking at, with no visible panel anywhere).

### D5. Navigation targeting is a last-in-first-out layer over the main derivation

`NavigationTargets` records, per push, a Session and its occurrence host. The embedded Factory pushes on mount while expanded and pops on collapse or unmount. `SidebarRightController.screen()`, `require()` and `isTargetCurrent()` resolve the effective target as the top of the layer, else `mounted` (the existing main derivation, driven by `show()`). No existing method changes its signature.

Alternatives considered: per-occurrence services (rejected — every consumer holds `ctx.sidebarRight`); passing an occurrence through every open call (rejected — every caller would change, including four shipped tab types).

### D6. The per-Session face merges stored state with a pending intent

`forSession(sessionId)` returns a stable face: an `expanded` observable, `openTabs()`, `setExpanded(boolean)` and `toggleExpanded()`. The observable reads the adopted store's `layout.expanded` when the Session has one, and a pending intent otherwise; open tabs come from the existing open-tab inventory. `setExpanded` writes through the store actions when adopted, and records the pending intent otherwise. The panel occurrence applies a pending intent in a layout effect after mount and clears it.

This keeps the store lifecycle rule intact: no production code mints a store instance outside a registration, so the runtime's scope release still owns every instance. Applying the intent in an effect rather than inside `create` avoids a state write during render.

Alternatives considered: calling the wrapped `handle.create(sessionId)` from the controller (rejected — an instance the runtime never releases, and a write during render); keeping the throw (rejected — the host must be able to open a rail for a Session whose panel does not exist yet).

### D7. Capability presence is a readonly field on the Sidebar service

`ISidebarRight.capabilities` is `{ readonly embeddedPanel: true }`. A host checks the field before rendering the occurrence and keeps its current behavior when the field is absent. No new service, no new module-graph edge, and no change to `SlotRegistry`.

Alternatives considered: a dedicated optional service (rejected — another provider for one boolean); a `factory()` lookup on `SlotRegistry` (rejected — a public surface added to the slot framework for one product question).

### D8. The embedded occurrence owns its presentation and its chrome

- Container measurement: a `ResizeObserver` on the panel root, falling back to a 100% box where the observer is unavailable, supplies the panel width once the occurrence has a surface to draw. An embedded occurrence reports no room rule, because it offers no split.
- No frame coupling: the embedded branch never calls `openRightbar`/`closeRightbar`, never reports fullscreen, and passes `fullscreen: false` into the tab hook context, so `tabInfo.sidebar.fullscreen` is `false`.
- Chrome: `canSplit: false` with `hideSplitWhenBlocked: true` hides the split control; the fullscreen control is not rendered; tabs, the add control and collapse remain.
- Intents: `intentsFor(...)` output is overlaid with no-op `floatTab`, `unfloatPane` and `splitPane`, so a drag released outside changes nothing.
- The embedded branch renders floating-free docking through D9.

### D9. The docking kit gains one additive rendering prop

`DockLayout`/`TabLayout` gain `dockOnly?: boolean`. With it, `TabLayout` skips the host for any record whose pane is floating, while the docked tree, retention and focus handling stay untouched. The embedded occurrence renders `DockLayout` with `dockOnly` and the same `keepMounted` predicate as the main occurrence.

Alternatives considered: `DockSurface` (rejected — `PaneTree`/`TabPanel` mount only the active body and implement no `keepMounted`, so the agreed retention would be lost); projecting a floats-free `LayoutState` in the factory (rejected — synthetic layout state the kit's invariants do not know about); CSS-hiding the float hosts (rejected — float bodies would stay mounted and invisible).

### D10. Focus and target capture carry an occurrence host

The panel root carries `data-sidebar-right-session` plus `data-sidebar-right-occurrence-host="main|embedded"`. `SidebarRightTarget` gains `occurrenceHost`; `sidebarTargetFromElement` reads the marker from the element's nearest owner, `isTargetCurrent` requires it to match the effective target's host, and `visibleSidebarPane` (with `openWithPaneFocus`/`closeWithPaneFocus`) filters by host so focus restoration never lands on the other occurrence's copy.

### D11. Float and split requests are denied while the embedded occurrence is the target

`openResource`/`openTab` with `destination: 'float'` settle as `'sidebar'` when the effective target is embedded; `split()` returns `undefined` and `float()` returns without recording when the effective target is embedded. This keeps content visible in the host that requested it and keeps the drawer from creating panes it cannot draw.

### D12. Retention is an optional input with a local lease

The Factory input `retainTab` is optional. The main adapter passes its View-backed lease; the embedded occurrence omits it and the Factory uses a counted local lease that owns no `SessionReference` — the embedding host already retains the Session. `keepMounted` bodies behave the same in both occurrences.

### D13. Closing the last docked tab keeps today's semantics

No store change: closing the last docked non-guide tab closes it and collapses the column, and the guide stays unclosable while it is the only docked tab. Because the store is shared, the collapse is what the main occurrence displays when the Session returns to the main column; the spec and README record that cross-effect and a test asserts it.

Alternatives considered: seeding the default page and staying expanded (rejected — it changes the main column's behavior, which this change must preserve, and requires editing the store).

### D14. No new locale copy in this change

Hiding the split control needs no new string: the kit's labels are only rendered for a visible control. With split and fullscreen hidden, their keyboard commands with focus inside the drawer resolve as no-ops, because D11 denies the operation. A dedicated refusal message would need a new `sidebarRight` key in eight dictionaries; it is left out to keep the diff minimal and is recorded in the package README as a known limitation.

### D15. Upstream merge cost is confined and recorded

Touched existing files: `contract/slots.ts` (Factory declaration and types), `src/client/index.ts` (registration move, face wiring, capability), `shell/SidebarRight.tsx` (`export` plus `variant` gating and the adapter body), `service.ts` (target resolution, `forSession`, capability, denial), `focus.ts` and `shell/close-focus.ts` (host marker), `ui-dockkit` `TabLayout.tsx` (one prop, one predicate). `shortcuts.ts` is untouched: the denial lives in the controller, so split and fullscreen commands resolve as no-ops in a host surface. New files: `shell/PanelFactory.tsx`, `occurrences.ts`, `session-faces.ts`. Generated: `slot-catalog.ts`. The pull request lists these files and the merge cost.

## Risks / Trade-offs

- Abrupt host unmount skips the collapse path — the drawing registry and the target layer are released in effect cleanup, and a test unmounts the occurrence while expanded.
- While an embedded occurrence is expanded, opens are aimed at it even if the main column is visible behind the host. The drawer overlays the application, and `isTargetCurrent` rejects a target whose host no longer matches; the README states the precedence.
- The shared store makes the drawer's collapse visible in the main column. Documented and asserted, not avoided.
- `dockOnly` is a new kit prop and therefore upstream surface; it is one boolean with one predicate and it is covered by a kit test.
- Container measurement in a test environment without `ResizeObserver` falls back to the 100% box; embedded specs stub the observer where width matters.
- Regenerating the client slot catalog produces a large mechanical diff; it is required because the declared-by owner and composition hierarchy change.
- The split/fullscreen shortcuts are silent no-ops inside the drawer (D14) — a known limitation, not a dead control.
- `subagentchat` renders through the ordinary keyed seat inside an embedded occurrence but carries no dedicated guarantee.

## Migration Plan

- No persistence migration: `dsh.sidebar-right.v1.<sessionId>` keeps its schema and keys.
- The seat declarations move inside one registration effect, so no composition ever declares the tab seats twice.
- Rollback is a revert: the Factory and the capability disappear, and hosts that check the capability fall back to today's behavior.
- Verification: focused sidebar specs plus the kit spec for `dockOnly`, `pnpm run test:gui`, regenerated client catalog, `pnpm run build:check` after `build:artifacts`, and the documentation gates for the updated pages and Agent Note.
