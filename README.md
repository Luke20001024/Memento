# Memento

> macOS 上不开新窗口的**意图收集器**

> *"Memory is not a record. It's interpretation."*  
> ——《Memento》(2000)

无限的窗口,无限的念头。"切去 App 记一笔"的成本,常常已经超过念头本身。

> 你既然在记 TODO,就说明你不想现在做。不该再为这"不想"多付一次切窗口的成本。

Memento 让**记录**、**回顾**、**总结**都不离开你已经在的窗口:

| 你想做的事 | 传统方式 | Memento |
|---|---|---|
| **记文字** | 切笔记 App → 新建 → 选 tag → 粘正文 → 切回去 | 选中 + 一个快捷键(可补 tag / 备注) |
| **记画面** | 截图工具 + OCR 工具 + 手动整理 | 一个快捷键:**OCR + 原图一起入档** |
| **回顾** | 主动打开笔记 App → 找今天 | Chrome 新标签 = dashboard,本来就要开 |
| **整理 / 总结** | 平台锁死的 AI Notes、订阅制 | 一键复制 → **粘到你喜欢的任何 AI**:Claude / ChatGPT / Gemini / Kimi / 豆包… |

落档的是纯 markdown,**无专有格式、无账号、无平台锁定**。Memento 只负责**愿意收集你破碎的意图**——深度整理交给你信任的任何 AI。

每次开新标签,Chrome 显示**今日未完成 TODO + 90 天热力 + 一键复制按钮**;tab favicon 上的红色数字是未完成 TODO 数,放着不管也瞄得到。

不做总结、不做云、不做账号、不抢注意力。**只做一台极简的个人意图收集器。**

---

## 4 种摘录方式

| 服务名 | 触发 | 行为 |
|---|---|---|
| 存入 AI 秘书 | 选中文字 + 快捷键 | 直接落档,heading 自动带来源 App |
| 存入 AI 秘书 (选标签) | 选中文字 + 快捷键 | 弹三选一 → `#TODO` / `#下次再读` / `#灵感` |
| 存入 AI 秘书 (加备注) | 选中文字 + 快捷键 | 弹输入框写备注,正文 + `> 备注:` 一起存 |
| 存入 AI 秘书 (截图) | 直接快捷键 (无需选中) | 系统选区截图 → Vision OCR → 文字 + 原图都入库 |

推荐快捷键:`⌃1` / `⌃2` / `⌃3` / `⌃4`(macOS 不允许脚本代绑,需要在 **系统设置 → 键盘 → 快捷键 → 服务** 里手动绑一次)。

## 落档格式

每条记录的 heading 把所有元信息塞在一行,AI 用 ` · ` 一刀切就拿到全部 metadata:

`## HH:MM · 周X [· 来源App] [· #标签]`

示例:

```markdown
## 15:57 · 周日 · Feishu · #灵感

给你提供一些用户视角:
你说如果是虚构人物的话,能不能用 AI 提取人物描写...

> 备注: 在路上想到的

---

## 16:00 · 周日 · 截图·OCR

(截图里 OCR 提取的文字作为正文)

> ![原截图](./assets/2026-05-13-160000.png)

---
```

固定 3 个标签:`#TODO` / `#下次再读` / `#灵感`。所有文件统一 **UTF-8**,`append_text.sh` 内置 GBK / GB18030 / Big5 编码兜底(防止飞书递 GBK 时乱码)。

## 安装

```bash
chmod +x install_aisecretary.sh uninstall_aisecretary.sh
./install_aisecretary.sh
```

v2 装机脚本一次性铺好 4 个服务、新 heading 格式、编码兜底、Swift Vision OCR(需 Xcode Command Line Tools),并把 Chrome dashboard 资源复制到 `~/AISecretary/.chrome-newtab/`。

## 安装后必做:绑快捷键

1. 系统设置 → 键盘 → 键盘快捷键 → 服务
2. 在 **文本** 分类下找 `存入 AI 秘书` / `(选标签)` / `(加备注)`
3. 在 **常规** 分类下找 `存入 AI 秘书 (截图)`
4. 各自点空白处按下你的组合键

## 安装后的目录结构

```
~/AISecretary/                ← Memento 数据目录
├── 2026-05-13.md             ← 今天的记录
├── 2026-05-12.md
├── assets/                   ← 截图/图片 (YYYY-MM-DD-HHMMSS.png)
├── README.md                 ← 给 AI 看的目录说明
├── .scripts/
│   ├── append_text.sh
│   ├── append_image.sh
│   ├── capture_screenshot.sh
│   ├── ocr_image             ← Vision OCR 二进制
│   ├── ocr_image.swift
│   ├── copy_today.sh
│   ├── copy_week.sh
│   └── stats.sh
└── .chrome-newtab/           ← Chrome dashboard 资源

~/Library/Services/
├── 存入 AI 秘书.workflow
├── 存入 AI 秘书 (选标签).workflow
├── 存入 AI 秘书 (加备注).workflow
└── 存入 AI 秘书 (截图).workflow
```

## 喂给任何 AI 的三种姿势

**1. 拖文件夹**(最强,适合 Claude):把 `~/AISecretary` 整个文件夹拖到 Claude 对话框。它会先读 `README.md` 了解结构,再回答你 "总结这周"、"提取所有 #TODO" 之类的问题。

**2. 复制粘贴**(最快,适合 ChatGPT):
```bash
~/AISecretary/.scripts/copy_today.sh
# 然后切到 ChatGPT,⌘V
```

**3. Obsidian**(最佳本地体验):"Open folder as vault" 选 `~/AISecretary`,获得全文搜索、双向链接、图谱视图。注意:不是用来**写**,是用来**看**。

## Chrome 新标签页 Dashboard

装机脚本已经把资源复制到 `~/AISecretary/.chrome-newtab/`,只剩 Chrome 加载一下:

1. Chrome 访问 `chrome://extensions`
2. 右上角开 **开发者模式**
3. **加载已解压的扩展程序** → 选 `~/AISecretary/.chrome-newtab/`
4. 开新标签 → 点 **授权数据目录** → 选 `~/AISecretary`

扩展不联网,文件夹访问走 Chrome 原生 File System Access API,授权信息存在浏览器本地 IndexedDB。

### Prompt 模式 (6 + 1 彩蛋)

CTA 上方有一个下拉,可选 **不附 / 1 精简 / 2 全面 / 3 发散 / 5 教练 / 6 跨天复盘 / 7 情绪** 共 7 项。选了之后点"复制"按钮,prompt 会自动拼在今天的 md 前面进剪贴板,粘到任何 AI 一次成事。模式 **6** 自动改读过去 7 天的 md。

模式 **4** 不在下拉里——那是个彩蛋,藏在 dashboard 角落的一张小拍立得里,跟 Memento 的核心隐喻最贴。

prompt 全文在 [chrome-newtab/prompts.js](chrome-newtab/prompts.js),改/加/删那个文件即可。详见 [chrome-newtab/README.md](chrome-newtab/README.md)。

## 路线图

- [x] **一期 · 承接** — 4 服务 + Chrome dashboard,context 无成本落档
- [x] **二期 · 整理 (2.1 MVP)** — Chrome dashboard 加 prompt 下拉,6 个模式 + 1 个彩蛋
  - 精简 / 全面 / 发散 / 教练 / 跨天复盘 / 情绪 (下拉)
  - 记忆卡片(彩蛋,藏在 dashboard 角落)
  - 选择存在 localStorage,自动恢复
  - 模式 6 自动读过去 7 天 md 拼合
- [ ] **二期 · 2.2 外置** — prompts 从 `prompts.js` 搬到 `~/AISecretary/.prompts/{slug}.md`,装机脚本写默认 7 份,可改可加
  - **暂缓**,等真实使用数据。下面任一满足就开工:
    - 每周想改 prompt 文本 ≥ 2 次,觉得改 JS 摩擦太大
    - 想加自定义 prompt 的冲动出现过 ≥ 1 次
    - 有人(自己或别人)问"怎么改某个 prompt"
  - 观察方法:把感受用 `#灵感` 记进 Memento 本身,两周后看条目密度和具体内容
- [ ] **二期 · 2.3 自定义槽位** — "+"按钮 GUI 录入自定义 prompt(2.2 落地之后才考虑)
- [ ] **三期 · 闭环** — Chrome dashboard 勾选 TODO 时写回 md 文件(不只 localStorage)

## 卸载

```bash
./uninstall_aisecretary.sh
```

默认保留你的数据,会问你是否一并删除。Chrome 扩展需要去 `chrome://extensions` 手动移除(Chrome 不允许脚本卸载扩展)。

## 核心文件清单

| 文件 | 作用 |
|---|---|
| `install_aisecretary.sh` | 一键安装 (v2: 4 服务 + 编码兜底 + OCR + dashboard 资源) |
| `uninstall_aisecretary.sh` | 一键卸载 |
| `chrome-newtab/` | Chrome 新标签页 Dashboard 源码 |
| `~/AISecretary/.scripts/append_text.sh` | 追加文本 (核心,含编码兜底) |
| `~/AISecretary/.scripts/capture_screenshot.sh` | 截图 + OCR + 存原图 |
| `~/AISecretary/.scripts/copy_today.sh` | 复制今天到剪贴板 |
| `~/AISecretary/.scripts/copy_week.sh` | 复制本周到剪贴板 |
| `~/AISecretary/.scripts/stats.sh` | 数据统计 |
| `~/Library/Services/存入 AI 秘书*.workflow` | 4 个右键菜单服务 |

每个文件都是纯文本/纯 plist,你随时可以打开看、改、删。没有任何二进制黑盒(除了编译过的 OCR `ocr_image`,源码也在 `.scripts/ocr_image.swift`)。

---

> **关于命名**:产品名 "Memento" 是后改的;**内部技术目录、脚本、Workflow 名仍是旧名 `AISecretary`**(改名要迁移已有数据,得不偿失)。路径里看到的 `~/AISecretary/` 就是 Memento 的数据目录,`install_aisecretary.sh` 就是 Memento 的装机脚本。
