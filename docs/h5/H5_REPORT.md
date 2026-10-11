# H5 移动端适配报告

视口：iPhone 13 390×844、Android 360×780、iPad 竖屏 768×1024（Playwright 触屏模拟）。
复测脚本：`server/scripts/h5-audit.mts`（对现网 5173 截图 + 指标，`TAG=before|after`）；指标见 `before-metrics.json` / `after-metrics.json`。

## 发现的问题（before）
- 书库：书卡在手机上被挤成 3 列（46px / 140px / 140px），书名竖排断字；原因是末尾「新书」卡 `span-3` 撑出隐式 3 列。导出/故事包/删除按钮 24–30px 高。
- 工作室：桌面三栏在 ≤860px 被堆成三行（目录 36vh + 正文 + 助手 42vh），正文可视区只剩约 1/4 屏；目录、正文、助手互相遮挡。
- 选区气泡：贴在选区上方，和 iOS 长按原生菜单及手指位置冲突，会盖住目录区；按钮约 28px 高。
- 流式状态和「停止」只在助手面板里，正文区看不到。
- 工具抽屉：left/right 12px 的浮层，没有全屏，底部被截。
- 输入框字号 12–15px（iOS 聚焦会自动放大页面）：模型页 input 12px、composer textarea 13px、select 13px、导入冲突 select 13px。
- 点按区：顶栏「书库」面包屑 26×20、改名/删除 text-link 26×20、技能开关 32×18、各种 btn.small 30px 高。
- 模型页：场景路由矩阵行（route-name / select / input）在 360px 横向超出。
- viewport meta 没有 `viewport-fit=cover`，刘海和底部手势条没有安全区留白。

## 修复（after，只在 ≤860px 生效，桌面不变）
- viewport：`viewport-fit=cover, interactive-widget=resizes-content`，加 theme-color；高度用 `100dvh`，键盘弹出时内容跟着收缩。
- 工作室改成单栏，底部「目录 / 正文 / 助手」面板栏（56px + 安全区）；目录做成左侧滑出抽屉，选章后自动收起；助手是底部 sheet（约 80dvh），有遮罩，点遮罩关闭。
- 正在流式写或改选区时，正文页底部浮一条状态栏，带「停止」按钮（≥40px）；助手页签上有呼吸点提示。
- 工具抽屉全屏，内容区可以滚动。
- 选区气泡固定在面板栏上方、全宽，按钮 42px 高、15px 字；改写/续写/润色/缩短/加强对白/对助手说 都在。
- 所有 input/textarea/select 字号 ≥16px；按钮、tree-item、chip、text-link 最小高度 40px；技能开关扩大点按热区。
- 书库书卡单列；模型页路由矩阵改为纵向堆叠。
- 顶栏紧凑：工作室里隐藏字标，面包屑截断，安全区内边距。

## after 截图（390×844）
- `after-library.png`、`after-studio-editor.png`、`after-assistant.png`、`after-selection-bubble.png`、`after-tools.png`、`after-skills.png`、`after-models.png`

对照：同名 `before-*.png`。
