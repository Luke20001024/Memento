# AISecretary Dashboard · Chrome 新标签页

把 Chrome 的新标签页接管成 AISecretary 的回顾面板。一开新标签就看到今天未完成的 #TODO、一键复制今天的 markdown 给 AI。

## 它做什么

- **强提醒**:未完成 `#TODO` 数量大字常驻,Chrome 标签图标显示数字徽章
- **一键喂 AI**:大按钮一点,今天的 markdown 进剪贴板,⌘V 粘给 Claude/ChatGPT
- **轻量回顾**:今日条目列表 / 90 天热力 / 标签筛选

## 安装

> ⚠️ 前置条件:你已经装好 AISecretary 主程序 (`~/AISecretary/` 存在并有 `.md` 文件)。

1. 打开 Chrome,地址栏访问 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**,选择本 `chrome-newtab/` 目录
4. 开一个新标签,看到 dashboard
5. 点 **「📁 授权 ~/AISecretary 文件夹」** → 系统弹窗里选你的 `~/AISecretary` 文件夹 → 允许

授权信息存在浏览器本地 (IndexedDB),之后开新标签自动恢复,不需要每次重新选。

## 隐私 / 安全

- 扩展**不发任何网络请求**,无远程依赖
- 文件夹访问通过 Chrome 原生 File System Access API,授权范围**仅限你选定的目录**
- `marked.min.js` (markdown 渲染) 本地内置,无 CDN
- 整个扩展是纯静态 HTML/CSS/JS,源码就在本目录,随时可读

## 卸载

`chrome://extensions` → 找到 "AISecretary Dashboard" → 移除。

新标签会自动恢复成 Chrome 默认。

## 开发状态

- [x] Commit 1 · 骨架 + 装机说明
- [x] Commit 2 · 文件夹授权 + markdown parser
- [x] Commit 3 · TODO 强提醒 + 一键复制 + entry 列表
- [x] Commit 4 · 统计栏 + 90 天热力图 + favicon 数字徽章

MVP 完成。后续如需扩展可以做: 搜索、历史日期跳转、md 写回 (TODO 真闭环)、自定义标签等。
