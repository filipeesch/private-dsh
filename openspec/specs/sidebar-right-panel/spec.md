# sidebar-right-panel Specification

## Purpose

Gives any plugin a supported way to render the native right Sidebar panel — its tabs, panes, layout and tab bodies — in a surface of its own, so a host can offer files, document previews, terminals and the browser beside a conversation it embeds while the frame's column keeps behaving as it does today.

## Requirements

### Requirement: The right Sidebar panel can be hosted outside the frame column

The client SHALL expose one reusable panel composition for a Session, selected by an occurrence variant: `main` for the frame's right column and `embedded` for a surface a host owns. A host SHALL obtain the embedded occurrence by rendering that composition around the Session area it already provides and supplying the variant alone. The host SHALL NOT register tab components, declare the tab seats, or read panel internals.

#### Scenario: A host renders the panel beside a conversation it embeds

- **WHEN** a host renders an embedded occurrence around a retained Session while a different Session is selected in the main column
- **THEN** the occurrence shows that Session's tabs and its active tab body
- **AND** the frame's right column keeps its own Session, state, and presentation

#### Scenario: The main column renders through the same composition

- **WHEN** the application shows a Session in the main column
- **THEN** the frame's right column renders the same panel composition in the `main` variant it renders today

#### Scenario: A host does not have to reimplement the panel

- **WHEN** a plugin renders the embedded occurrence in a surface of its own
- **THEN** it supplies the variant and the Session area and nothing else
- **AND** it registers no tab body, no tab title, and no panel control

### Requirement: One entry declares the tab extension seats

The tab body, tab title, guide and tab menu seats SHALL be declared by the panel composition exactly once, independently of the occurrence variant. Every tab type SHALL keep contributing through the same seats, and a contribution registered once SHALL render in every mounted occurrence.

#### Scenario: A tab type registered once reaches both occurrences

- **WHEN** a plugin registers one tab type and both a main and an embedded occurrence are mounted for the same Session
- **THEN** that type's body renders in the main column and in the embedded occurrence
- **AND** the plugin registers it only once

#### Scenario: A second declarer fails at load

- **WHEN** another registration attempts to declare those tab seats while the panel composition declares them
- **THEN** load fails with an error naming the current declarer

#### Scenario: The guide's own seats keep working

- **WHEN** a plugin registers a guide replacement, a guide entry, or a tab menu item
- **THEN** that contribution renders in every mounted occurrence of the panel

### Requirement: An occurrence binds the Session of its render position

The panel SHALL take its Session from the render position and SHALL NOT accept an independent Session identity. A host SHALL address another Session by providing that Session's area around the occurrence. Rendering an occurrence without a Session area SHALL fail as a wiring error rather than render a Session the host did not provide.

#### Scenario: Each occurrence shows its own Session area

- **WHEN** a host renders an embedded occurrence inside Session B's area while Session A is selected in the main column
- **THEN** the embedded occurrence shows Session B's tabs and layout
- **AND** selecting another Session elsewhere does not rebind it

#### Scenario: An occurrence without a Session area fails loudly

- **WHEN** no Session area surrounds an embedded occurrence
- **THEN** rendering reports an error instead of showing another Session's panel

### Requirement: Occurrences of one Session share one panel state

Every mounted occurrence of one Session SHALL read and write the same panel state: the same layout, the same open tabs, the same history, and the same persisted layout under `dsh.sidebar-right.v1.<sessionId>`. Opening the same resource from either occurrence SHALL reveal the same tab, a terminal tab SHALL remain one terminal process, and whichever occurrence first materializes the state SHALL adopt it — including a conversation header's expand button with no panel mounted — so tab synchronization and open-tab metadata cover a Session the main column never selected.

#### Scenario: Opening in either occurrence reveals the same tab

- **WHEN** a file is opened from a link in the main conversation and, later, the same file is opened from a link inside the embedded conversation
- **THEN** the second open reveals the tab the first opened
- **AND** both occurrences show the same active tab

#### Scenario: A terminal is one process

- **WHEN** a terminal tab is open in an embedded occurrence and the same Session's main occurrence draws the same tab
- **THEN** both draw the same terminal process

#### Scenario: An embedded-only Session is still adopted

- **WHEN** a Session's panel state is first materialized by an embedded occurrence, or only by the conversation header's expand button
- **THEN** that Session's open tabs are reported to the Sidebar service
- **AND** tab lifetime, cleanup handlers, and terminal retention work for it

### Requirement: The frame occurrence keeps its current behavior

The `main` occurrence SHALL keep today's behavior: it SHALL report its track and fullscreen presentation to the frame, apply the automatic fullscreen rule for the frame width it renders at, report its room rule for splits, honor the same shortcuts, keep background Sessions with retained bodies, and persist the layout in the current format.

#### Scenario: Presentation reports as today

- **WHEN** the frame is wide and the user expands the panel
- **THEN** the frame opens its right column track for the panel as it does today

#### Scenario: Background Sessions are unchanged

- **WHEN** a background Session holds retained tab bodies
- **THEN** its panel stays mounted out of view and requests no track, as today

#### Scenario: Persistence is unchanged

- **WHEN** the application reloads
- **THEN** each Session's layout is restored from `dsh.sidebar-right.v1.<sessionId>` before tab bodies render

### Requirement: An embedded occurrence owns its own presentation

The embedded occurrence SHALL size itself to the container its host provides, SHALL NOT request a frame track, and SHALL NOT report frame fullscreen. Its tab bodies SHALL always read `fullscreen: false`.

#### Scenario: No frame track is requested

- **WHEN** an embedded occurrence mounts expanded while a main panel fills the frame
- **THEN** the frame's right column stays closed and the frame's layout is unchanged

#### Scenario: The panel follows its container

- **WHEN** the host narrows or widens the container around the embedded occurrence
- **THEN** the panel fits that container without changing the frame's column width or presentation

#### Scenario: Tab information reports not fullscreen

- **WHEN** a tab body in an embedded occurrence reads its tab information
- **THEN** `sidebar.expanded` reflects the shared layout and `sidebar.fullscreen` is `false`

### Requirement: An embedded occurrence presents docking chrome only

The embedded occurrence SHALL keep tabs, the add control, and collapse, and SHALL NOT present a split control, a fullscreen control, or a floating-panel affordance. It SHALL render the splits already committed in the shared layout, SHALL NOT draw floating panes, and a tab dragged outside it SHALL NOT create a floating pane.

#### Scenario: No split or fullscreen control is drawn

- **WHEN** the embedded occurrence renders its chrome
- **THEN** it shows tabs, the add control, and collapse
- **AND** it draws no split control and no fullscreen control

#### Scenario: A committed split renders in the host surface

- **WHEN** the Session's layout already holds a split created in the main occurrence
- **THEN** the embedded occurrence draws both panes of that split

#### Scenario: Dragging a tab out creates no floating pane

- **WHEN** the user drags a tab clear of the embedded occurrence
- **THEN** the layout is unchanged and no floating pane is created

#### Scenario: Floats stay in the main occurrence

- **WHEN** the Session holds a floating pane created in the main occurrence
- **THEN** the embedded occurrence does not draw it
- **AND** the floating pane keeps its record and remains drawn by the main occurrence

### Requirement: The embedded occurrence is a navigation target while mounted and expanded

While an embedded occurrence is mounted and expanded it SHALL report its Session as the Sidebar's navigation target through a last-in-first-out layer over the main on-screen derivation. Unmounting or collapsing it SHALL restore the previous target. Opens issued from inside it — resource links, tool line references, page shortcuts, and assistant Markdown links configured to open in the Sidebar — SHALL land in it, and writes SHALL NOT fail for lack of an on-screen surface.

#### Scenario: A file link inside the embedded conversation opens the embedded panel

- **WHEN** the user activates a file link in the embedded conversation while a main panel fills the frame
- **THEN** the file opens as a tab in the embedded occurrence
- **AND** the open does not report a missing Session surface

#### Scenario: The previous target is restored

- **WHEN** the embedded occurrence unmounts or collapses while a Session is on screen
- **THEN** subsequent opens target the on-screen Session again

#### Scenario: The most recent embedded occurrence wins

- **WHEN** two embedded occurrences are mounted and expanded for the same Session
- **THEN** the most recently expanded one is the navigation target
- **AND** unmounting it restores the other

### Requirement: A per-Session face answers without a mounted occurrence

`ctx.sidebarRight` SHALL expose a per-Session face that reads one named Session's expanded state and open tabs and writes its expanded state, independently of the on-screen Session. Reads SHALL answer before any occurrence mounts: collapsed, and no open tabs. A write for a Session whose panel state does not exist yet SHALL NOT fail: it records the intent, and the Session's panel applies it when that state is materialized.

#### Scenario: Reads answer before any occurrence mounts

- **WHEN** a host reads the face for a Session no occurrence has mounted
- **THEN** it reads collapsed and an empty tab list
- **AND** no panel is created by the read

#### Scenario: A write before the panel exists opens it when the panel mounts

- **WHEN** a host sets a Session's expanded state and only then mounts the embedded occurrence
- **THEN** the embedded occurrence renders expanded

#### Scenario: The face is scoped to the named Session

- **WHEN** a host writes the expanded state for Session B while Session A is on screen
- **THEN** Session A's expanded state and layout are unchanged

### Requirement: Capability presence is detectable and absence is inert

The client SHALL report the embedded-panel capability on the Sidebar service so a host can detect it at runtime. A host that does not find the capability SHALL keep its current behavior, and the panel's own behavior SHALL NOT depend on the capability being read.

#### Scenario: The capability is reported

- **WHEN** a host inspects the Sidebar service of this version
- **THEN** it finds the embedded-panel capability reported

#### Scenario: A host without the capability keeps its behavior

- **WHEN** a host finds no embedded-panel capability on the Sidebar service
- **THEN** it renders as it does today and mounts no embedded occurrence
- **AND** the frame's right column keeps working unchanged

### Requirement: Focus and target capture distinguish two occurrences of one Session

Each occurrence SHALL mark its subtree with the Session identity and with an occurrence-host identity. Capture from a focused element SHALL resolve to the occurrence that owns that element and SHALL reject a target whose Session and occurrence host do not match. Focus restoration after a page operation SHALL select a visible pane of the same occurrence.

#### Scenario: Focus inside the embedded subtree resolves to it

- **WHEN** the user focuses a control inside the embedded occurrence while the main occurrence shows the same Session with the same pane identifiers
- **THEN** the captured target belongs to the embedded occurrence

#### Scenario: A stale target from the other occurrence does not act

- **WHEN** a command holds a target captured in the main occurrence and the embedded occurrence has become the navigation target
- **THEN** the command treats the target as stale and changes nothing

#### Scenario: Focus restoration picks a visible pane

- **WHEN** a page operation replaces a pane's DOM inside the embedded occurrence
- **THEN** focus moves to a visible pane of the embedded occurrence
- **AND** it does not move to the main occurrence's copy, shown or hidden

### Requirement: Two occurrences do not draw the same bodies twice

While an embedded occurrence is mounted and expanded, the `main` occurrence SHALL NOT draw that Session's panel body, and the frame presentation it reports SHALL remain what it reports today. A `keepMounted` tab body in an embedded occurrence SHALL be retained by a lease that owns no Session reference.

#### Scenario: One body per tab

- **WHEN** both occurrences are mounted for one Session and the embedded one is expanded
- **THEN** each open tab's body is mounted once
- **AND** the main occurrence still reports the frame presentation it reports without an embedded occurrence

#### Scenario: The main body returns

- **WHEN** the embedded occurrence unmounts or collapses
- **THEN** the main occurrence draws that Session's panel body again

#### Scenario: Retained bodies need no Session reference

- **WHEN** a `keepMounted` tab body is visited in an embedded occurrence and the user switches tabs or hides the panel
- **THEN** the body stays retained without the embedded occurrence acquiring a Session reference

### Requirement: Float and split requests are denied in the embedded context

While the embedded occurrence is the navigation target, a resource open that requests a floating host SHALL settle in the docked area instead, and a split or float request SHALL leave the layout unchanged. Closing the last docked non-guide tab SHALL close it and collapse the column, and the guide SHALL remain unclosable while it is the only docked tab.

#### Scenario: A float destination settles in the dock

- **WHEN** an open issued from the embedded occurrence requests a floating host
- **THEN** the content opens as a docked tab in the embedded occurrence
- **AND** no floating pane is created

#### Scenario: Split and float requests change nothing

- **WHEN** a split or float operation is requested with the embedded occurrence as the target
- **THEN** the layout is unchanged

#### Scenario: Closing the last docked tab collapses the shared column

- **WHEN** the user closes the last docked non-guide tab in the embedded occurrence
- **THEN** the tab closes and the Session's column collapses
- **AND** the main occurrence shows that same collapsed column when the Session returns to the main column
- **AND** the guide cannot be closed while it is the only docked tab

### Requirement: Shipped tab types render unchanged in an embedded occurrence

Tab types shipped with the product SHALL render in an embedded occurrence without changing their registration or behavior: document preview for text, images, PDF and office documents, the files page and navigator, the terminal, the browser, and the guide. Page and resource shortcuts SHALL act on the navigation target in force.

#### Scenario: Every shipped type renders

- **WHEN** the embedded occurrence holds a text, image, PDF, office, files, terminal, browser, or guide tab
- **THEN** that tab's body renders in the embedded occurrence

#### Scenario: Files and terminal shortcuts act on the embedded occurrence

- **WHEN** focus is inside the embedded occurrence and the user invokes the files or terminal command
- **THEN** the files page or a terminal opens in the embedded occurrence

#### Scenario: Assistant Markdown links follow the target

- **WHEN** an assistant Markdown HTTP(S) link is configured to open in the Sidebar and the embedded occurrence is the navigation target
- **THEN** the link opens a browser tab in the embedded occurrence
