# Memento · Chrome 新标签页 Dashboard

把 Chrome 的新标签页换成 Memento 的回顾面板:开新标签 = 看今天的未完成 #TODO、一键复制 markdown 给 AI。

## 它做什么

- **强提醒**:未完成 `#TODO` 大字常驻,Chrome 标签 favicon 显示数字徽章
- **一键喂任何 AI**:大按钮一点,今天的 markdown 进剪贴板,⌘V 粘给 Claude / ChatGPT / Gemini / Kimi / 豆包……
- **轻量回顾**:今日条目列表 / 90 天热力图 / 标签筛选
- **6 种 prompt 模式**:下拉选一个,复制时自动把 prompt 拼在 md 前面,粘到 AI 一次成事(见下方"模式")

## 模式 (Prompt 模板)

CTA 上方的下拉里有 6 个模式,选中后按钮文字会同步变化。选择存在本地 (localStorage),下次开新标签自动恢复。

| # | 名字 | 用在 | 输入 |
|---|---|---|---|
| 1 | 精简 | 30 秒扫一眼今天 | 今天 md |
| 2 | 全面 | 日终整理,写周报 | 今天 md |
| 3 | 发散思考 | 灵感多 / 想被推一把 | 今天 md |
| 5 | 教练 / 盲点 | 感觉在原地打转 | 今天 md |
| 6 | 跨天复盘 | 周日晚 / 月末 | **过去 7 天** md 拼合 |
| 7 | 情绪温度计 | 有非工作的独白记录 | 今天 md |

第 4 号 — **Memento · 记忆卡片模式** — 不在下拉里。这是个彩蛋,你需要自己找到入口。提示:它跟产品的核心隐喻最贴。

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
