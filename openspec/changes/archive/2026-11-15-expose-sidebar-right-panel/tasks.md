# Tasks

## 1. Docking kit: docked-only rendering

- [x] 1.1 Add `dockOnly?: boolean` to the dock layout props and skip the host of any record whose pane is floating, keeping docked hosts, `keepMounted` retention and focus handling untouched; verify a kit spec renders one docked and one floating record with `dockOnly` and asserts no `[data-dockkit-float]` host while the retained docked body stays mounted.

## 2. Factory declaration and slot ownership

- [x] 2.1 Declare `SlotFactoryMap['sidebar.right.panel']` with session scope, `SidebarRightPanelInputProps` (`variant`, `fullscreen?`, `active?`, `retainTab?`), the tab-seat `children`, the `sidebarRight` locale, the panel inject type and the store handle type, and export the panel prop aliases; verify `pnpm run typecheck` passes for the package.
- [x] 2.2 Move the `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` declarations and the inject members the tab bodies consume from the `rightbar.session` registration into one `ctx.slots.registerFactory` call, in the same effect as the `rightbar` seat registration; verify the apply spec asserts the Factory is the sole declarer and that the guide, document-preview, files, terminal and schedule registrations still resolve.
- [x] 2.3 Create `shell/PanelFactory.tsx` that builds the panel props from the store, the inject face and the occurrence input, and render the existing `SidebarPanel` from it (exported, with a `variant` prop); verify a renderer spec mounts both variants against a registered tab type and asserts the body renders in each with one registration.

## 3. Frame adapter

- [x] 3.1 Make `RightbarSeat` render `renderFactorySlot('sidebar.right.panel', { variant: 'main', fullscreen, active, retainTab })` while keeping every presentation effect (shown/track/fullscreen/canShow, room reporting, auto-fullscreen); verify the existing seat spec passes unchanged in behavior.
- [x] 3.2 Confirm main-variant parity for layout, persistence, shortcuts, float/fullscreen and background Sessions; verify the existing stores, persistence, service, focus and session-views specs pass and add an assertion that the embedded variant issues no right-column call.

## 4. Shared store, adoption and retention

- [x] 4.1 Declare the same store handle on the Factory registration; verify a spec shows both occurrences reading one instance and one layout after an action in either.
- [x] 4.2 Cover adoption for a Session first materialized by the embedded occurrence and by the conversation header's expand button alone; verify the Tab domain keeps occurrence records and `openTabs` reports the tabs for that Session.
- [x] 4.3 Implement the optional `retainTab` input with a counted local lease for the embedded occurrence; verify a `keepMounted` body survives a tab switch and a hide in the embedded occurrence without calling `sessions.retain`.

## 5. Navigation targeting

- [x] 5.1 Add `occurrences.ts` with the navigation-target layer (Session + occurrence host, LIFO) and the drawing registry; verify unit specs for push/pop ordering, restoring the previous target, and drawing counts per Session.
- [x] 5.2 Resolve `screen()`, `require()` and `isTargetCurrent()` through the target layer with the on-screen derivation as fallback; verify service specs that `openResource`, `openTab`, `close` and `toggleExpanded` act on the embedded occurrence and stop throwing, and that unmounting restores the main target.
- [x] 5.3 Deny `split()` and `float()` and coerce `destination: 'float'` to the docked host while the embedded occurrence is the effective target; verify service specs for all three paths.
- [x] 5.4 Make the main occurrence stop drawing the panel body while an embedded occurrence is mounted and expanded, leaving the presentation report unchanged; verify a client spec with two occurrences shows one body per tab and restores the main body on unmount.

## 6. Per-Session face and capability

- [x] 6.1 Add `session-faces.ts` and `ctx.sidebarRight.forSession(sessionId)` returning `{ expanded, openTabs, setExpanded, toggleExpanded }`, with a pending-expansion intent applied in a layout effect by the panel occurrence when the store is adopted; verify specs for reads before any mount, a write before the panel exists opening it on mount, and scoping to the named Session.
- [x] 6.2 Add the readonly `capabilities` field exposing `embeddedPanel: true`; verify a service spec asserts the field and a typecheck that `ISidebarRight` carries it.

## 7. Embedded presentation, chrome and focus

- [x] 7.1 Measure the occurrence's container and make the embedded branch never call `openRightbar`/`closeRightbar`, never report fullscreen, and pass `fullscreen: false` to tab bodies; verify a spec asserting no frame calls and `tabInfo.sidebar.fullscreen === false`.
- [x] 7.2 Gate the embedded chrome — hide the split control, omit the fullscreen control, render `DockLayout` with `dockOnly`, keep tabs/add/collapse — and overlay the intent set with no-op float/split intents; verify a react spec that the embedded panel renders tabs, add and collapse, exposes no split or fullscreen control, and leaves the layout unchanged after a drag out.
- [x] 7.3 Emit `data-sidebar-right-occurrence-host` on the panel root, carry `occurrenceHost` on the captured target, and filter `visibleSidebarPane` plus the focus-continuity helpers by host; verify focus specs with two occurrences of one Session sharing pane identifiers.

## 8. Shipped tab types in the embedded occurrence

- [x] 8.1 Prove the embedded panel renders tab bodies for the shipped types: document preview (text, image, PDF, office), files, terminal, browser and guide; verify a react spec against the production slot renderer mounts each body in the embedded occurrence.
- [x] 8.2 Prove that assistant Markdown HTTP(S) links and the files and terminal commands act on the embedded occurrence when it is the target; verify spec coverage through the shortcut resolution path and the link-opening path.

## 9. Last docked tab semantics

- [x] 9.1 Assert that closing the last docked non-guide tab in the embedded occurrence closes it and collapses the shared column, that the main occurrence then renders the collapsed column, that the guide cannot be closed while it is the only docked tab, and that an existing floating record is neither removed nor altered.

## 10. Documentation and generated artifacts

- [x] 10.1 Update `docs/subsystems/sidebar-right.md` with the panel Factory, position and ownership across two occurrences, the per-Session face and capability, and remove the read-face and capability-discovery entries from the "Not built" list; update the Chinese counterpart; verify `pnpm run test:docs`.
- [x] 10.2 Update the package README with the Factory contract, the embedded rules, `forSession`, `capabilities`, the shared-store cross-effects and the silent split/fullscreen shortcuts inside a host; update the Chinese counterpart; verify `pnpm run doc-sync`.
- [x] 10.3 Add the `docs/subsystems/slots.md` hierarchy entry for the panel Factory and its child seats, with the Chinese counterpart; verify the page's doc gates.
- [x] 10.4 Add the implemented Agent Note triplet under `.agents/notes/implemented/architecture/` recording the decisions, the alternatives and the upstream merge cost, with its `.zh.md` and `.i18n.yaml`; verify `pnpm run test:docs` accepts the note.
- [x] 10.5 Regenerate the client slot catalog for the new declared-by owner and hierarchy; verify the regeneration is clean (`pnpm run gen-client-catalog` then no further diff).

## 11. Verification ladder

- [x] 11.1 Run `pnpm run test:gui` and report the result.
- [x] 11.2 Run `pnpm run build:artifacts` followed by `pnpm run build:check`.
- [x] 11.3 Run `DSH_SNAPSHOT=replay pnpm run test:web` because the assembled client output changes.
- [x] 11.4 Write the pull request description through the `dsh-pr-description` skill, listing the touched files and the upstream merge cost.
