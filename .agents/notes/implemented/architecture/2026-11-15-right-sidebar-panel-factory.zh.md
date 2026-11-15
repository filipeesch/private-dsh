# Agent Note: 右侧 Sidebar 面板 Factory

Status: implemented

[English](2026-11-15-right-sidebar-panel-factory.md) | 中文

## Problem

渲染内嵌 Conversation 的宿主无法在它旁边渲染右侧 Sidebar。三件事实挡住了它。tab 扩展席位由 frame 席位声明，因此任何其他渲染它们的组件都过不了所有权检查；插件绘制的唯一出现属于 frame 的右列，并要求 Conversation 占据主列；导航服务只作用于屏幕上的会话，所以内嵌会话里的文件链接会因没有已挂载的会话面而抛错。内嵌会话的展开按钮把展开状态写进一个没人绘制的会话 store。

## Decision

右侧 Sidebar 作为公开的 Component Factory `sidebar.right.panel` 暴露，会话作用域，出现输入为 `{ variant: 'main' | 'embedded', fullscreen?, active?, width?, retainTab? }`。frame 的 `rightbar.session` 席位继续计算轨道、宽度、呈现与自动全屏规则，然后以 `main` 变体渲染 Factory 并传入这些事实。宿主在它持有的 Session 区域里渲染 `renderFactorySlot('sidebar.right.panel', { variant: 'embedded' })`；该出现从渲染位置取得 Session，填满并测量自己的容器，拥有自己的 chrome。

Factory 在其已注册定义内声明 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`，frame 席位两者都不声明。消费方通过 `ctx.slots.inject` 注册并按声明 epoch 重跑，因此把声明移进 Factory 没有改动任何 tab 类型，也没有改动任何内置类型的注册路径。

两种出现声明同一个 store handle。slot 运行时按 handle 与会话解析出同一份实例，因此布局、已开 tab、历史与 `dsh.sidebar-right.v1.<sessionId>` 条目是同一份状态；哪个出现先铸造 store 就由它接管，包括面板尚未挂载时的会话 header 展开按钮。

新的出现台账在内嵌出现挂载且展开期间给它两个角色。它是导航目标，经一个后进先出的层叠在屏上推导之上，因此从它内部发起的打开落在它里面，释放它则恢复此前的目标。它还抑制 frame 出现对该会话面板正文的绘制，使每个打开的 tab 只有一个已挂载正文；frame 席位上报的呈现与没有内嵌出现时完全一致。

按会话的接口 `ctx.sidebarRight.forSession(sessionId)` 在任何出现挂载之前就能作答：`expanded` 读到 false，`openTabs()` 读到空，写入记录一份意图，由面板出现在该会话 store 存在后的 layout effect 中应用。没有任何 store 实例在注册之外被铸造，运行时的作用域释放因此仍是唯一权威。`ctx.sidebarRight.capabilities.embeddedPanel` 让宿主探测这个面，并在它缺席时保持自己的行为。

内嵌出现只绘制停靠 chrome：tab 条、添加控件与折叠；已提交的分栏照常渲染，分栏与浮出控件缺席，在它之外释放的拖拽不改变任何东西。浮窗保留记录，继续由 frame 出现绘制。关闭最后一个停靠的非 guide tab 沿用既有收起行为，共享 store 让它在 frame 出现里同样可见。焦点与目标捕获携带出现宿主，因此同一会话的两次出现不会互相应答。

停靠套件新增一个可选的渲染 prop `dockOnly`，使某个出现能只渲染停靠树、保留 `keepMounted` 正文，而不挂载浮窗宿主。另一条路是第二个渲染器或伪造布局状态。

[停靠基础设施笔记](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)拥有这套组合所渲染的布局引擎、框架列与每会话状态。

## Alternatives considered

为内嵌变体复制面板标记被否决：焦点标记、chrome 与文案会出现在两处并逐渐漂移，而所有权规则仍要求 Factory。用 Factory 的独占 store factory 做按出现的 store 被否决，因为那条轴拒绝持久化，并会让同一会话的两次出现分叉。对任何已挂载的内嵌出现（无论是否展开）都抑制 frame 正文被否决，因为它会为正在查看的会话空出 frame 列，而任何地方都看不到面板。为渲染投影一份去掉浮窗的布局状态被否决，因为套件不变量不认识这种合成状态。为能力探测新增专门的可选服务被否决，改为一个只读字段；给 SlotRegistry 增加 `factory()` 查询被否决，因为那是为一个产品问题新增框架面。为宿主面内的分栏与全屏快捷键新增拒绝文案被略去；这些命令在那里是静默空操作。

## Consequences

frame 出现保持它的呈现、持久化、快捷键、浮出与全屏行为以及后台会话。合并后的面集中在 sidebar 包的 slot 契约、插件注册、frame 席位、控制器、焦点辅助，以及停靠套件里一个加法式 prop；生成的 client slot catalog 记录新的声明所有者。

内嵌出现无法显示浮窗，因此请求浮窗宿主的打开改为落在停靠区，而在它内部聚焦时的分栏与全屏键盘命令什么都不做。因为 store 是共享的，宿主面里的展开或收起就是该会话回到主列时 frame 列显示的状态。`subagentchat` tab 经普通 keyed 席位在内嵌出现里渲染，但不带专门保证。
