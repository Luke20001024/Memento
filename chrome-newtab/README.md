# Memento · Chrome 新标签页 Dashboard

把 Chrome 的新标签页换成 Memento 的回顾面板:开新标签 = 看今天的未完成 #TODO、一键复制 markdown 给 AI。

## 它做什么

- **强提醒**:未完成 `#TODO` 大字常驻,Chrome 标签 favicon 显示数字徽章
- **一键喂任何 AI**:大按钮一点,今天的 markdown 进剪贴板,⌘V 粘给 Claude / ChatGPT / Gemini / Kimi / 豆包……
- **轻量回顾**:今日条目列表 / 90 天热力图 / 标签筛选
- **Prompt 双轴 A × B**:选一个时间段 + 一个风格,复制时自动把 prompt 拼在 md 前面,粘到 AI 一次成事(见下方"模式")

## 模式 (Prompt 双轴)

CTA 上方读起来是一句话:**复制 [ 今天 ▼ ] 的 [ 精简 ▼ ] → AI**。两个下拉正交,任意组合,3 × 6 = 18 种。选择存在本地 (localStorage),下次开新标签自动恢复。

**A · 时间段**(决定喂几天 md):

| id | 名字 | 范围 |
|---|---|---|
| today | 今天 | 当天 md |
| week | 本周 | 过去 7 天拼合 |
| month | 本月 | 过去 30 天拼合 |

**B · 风格**(决定怎么整理):

| # | 名字 | 用在 |
|---|---|---|
| — | 不附 | 只复制纯 md,自己组织 |
| 1 | 精简 | 30 秒扫一眼 |
| 2 | 全面 | 日终整理 / 周报;**多天范围下自动加「跨天观察」节**(吃掉了原"复盘") |
| 3 | 发散思考 | 灵感多 / 想被推一把 |
| 4 | 教练 / 盲点 | 感觉在原地打转 |
| 5 | 情绪温度计 | 有非工作的独白记录 |
| 6 | 转 HTML 笔记 | 把材料整理成可归档的单文件 HTML |

风格文本一律「时间段中性」,材料开头会注明 `【时间范围:X】`,prompt 自己读。

还有一个**记忆卡片模式**不在下拉里——那是个彩蛋,你需要自己找到入口(提示:跟产品核心隐喻最贴),它也吃 A 时间段。

**闭环**:风格 6 输出一份自包含的 HTML 学习笔记(小报风,内置 CSS + TOC),把它存下来 → 拖进右侧「归档」抽屉 → 点击在沙箱页里完整渲染(交互脚本可跑)。markdown 收集碎片 → AI 整理成 HTML → 归档库沉淀 + 复阅。

prompt 全文在 [prompts.js](prompts.js),要改、要加、要删,直接编辑那个文件即可。

## 安装

> ⚠️ 前置条件:已经跑过主目录的 `install_aisecretary.sh`,`~/AISecretary/` 存在并有 `.md` 文件。

1. Chrome 地址栏访问 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**,选 `~/AISecretary/.chrome-newtab/`(装机脚本已经把本目录拷到那里)
4. 开一个新标签 → 看到 Memento dashboard
5. 点 **「授权数据目录」** → 系统弹窗里选 `~/AISecretary` → 允许

授权信息存在浏览器本地 (IndexedDB),之后开新标签自动恢复,不需要每次重选。

## 隐私 / 安全

- 扩展**不发任何网络请求**,无远程依赖
- 文件夹访问通过 Chrome 原生 File System Access API,授权范围**仅限你选定的目录**
- Markdown 渲染是内置的极简实现,不引入 marked.js / 任何第三方库
- 整个扩展是纯静态 HTML / CSS / JS,源码就在本目录,随时可读

## 卸载

`chrome://extensions` → 找到 "Memento" → 移除。新标签会自动恢复成 Chrome 默认。

## 命名说明

产品名是 **Memento**;内部技术目录(`~/AISecretary/`、`.chrome-newtab/`)和脚本(`install_aisecretary.sh`)沿用旧名 `AISecretary`,改名要迁移数据,得不偿失。
