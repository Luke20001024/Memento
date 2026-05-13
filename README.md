# AISecretary · 一键安装包

**AISecretary 是一个 macOS 上的 "碎片承接器"。**

用户在任何地方写下的东西——**微信、Notion、Slack、备忘录、飞书**——只需要选中并按快捷键存入,系统就会自动将其按天整理成 AI 能直接读懂的 Markdown 文件夹。

我们坚持**不做总结、不做标签自动化、不做云同步、不做账号系统**。它只负责承接你最原始的灵感和上下文 (Context)。当你需要 AI 协助时,只需把文件夹拖过去,剩下的交给 AI。

## 它做什么

```
你在任何 App 选中文字 → 快捷键 → 自动追加到今天的 .md
你想加个标签         → 快捷键 → 弹三选一 → 自动追加并打 #TODO/#下次再读/#灵感
你想加个备注         → 快捷键 → 弹输入框 → 正文 + 备注一起存入
你想存截图           → 快捷键 → 系统选区截图 → OCR 文字 + 原图都入库
你想喂给 AI          → 把 ~/AISecretary 文件夹拖给 Claude / ChatGPT
```

它不做什么:不做 AI 总结、不做自动打标签、不做云同步、不做账号系统。

## 4 种存入服务

| 服务名 | 触发条件 | 行为 |
|---|---|---|
| 存入 AI 秘书 | 选中文字 + 快捷键 | 直接存入,heading 自动带来源 App |
| 存入 AI 秘书 (选标签) | 选中文字 + 快捷键 | 弹三选一菜单,写成 `#TODO` / `#下次再读` / `#灵感` |
| 存入 AI 秘书 (加备注) | 选中文字 + 快捷键 | 弹输入框写备注,正文 + `> 备注:` 一起存入 |
| 存入 AI 秘书 (截图) | 直接快捷键 (无需选中) | 调起系统选区截图 → OCR 文字 + 原图都存入 |

推荐快捷键:`⌃1` / `⌃2` / `⌃3` / `⌃4` (在 **系统设置 → 键盘 → 键盘快捷键 → 服务** 里手动绑定;macOS 不允许脚本代劳)

## Markdown 存储格式

每条记录的 heading 把所有元信息塑在一行,AI 解析时按 ` · ` 分割即可:

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

固定 3 个标签:`#TODO` / `#下次再读` / `#灵感`

所有文件统一 **UTF-8** 编码,`append_text.sh` 内置 `GBK / GB18030 / Big5` 编码兜底,防止飞书等 App 递 GBK byte 时文件乱码。

## 安装

```bash
chmod +x install_aisecretary.sh uninstall_aisecretary.sh
./install_aisecretary.sh
```

> ⚠️ 当前打包的 `install_aisecretary.sh` 只装单个 "直接存入" 服务 + 可选截图监听 LaunchAgent。要拿到上面 4 个独立服务、新 heading 格式、编码兜底,需要在装完后再手动改造一次。后续可考虑把这些升级合并回安装脚本。

## 安装后必做的一步:绑定快捷键

安装脚本不会自动绑快捷键 (macOS 限制),需要手动:

1. 打开 **系统设置 → 键盘 → 键盘快捷键 → 服务**
2. 在 **文本** 分类下找到 `存入 AI 秘书` / `存入 AI 秘书 (选标签)` / `存入 AI 秘书 (加备注)`
3. 在 **常规** 分类下找到 `存入 AI 秘书 (截图)`
4. 分别点右侧空白,按下你想要的组合键

绑完之后,选中文字按对应快捷键就静默入库;截图那个无需选中文字,直接按就会调出截图选区。

## 安装后会得到什么

数据目录:

```
~/AISecretary/
├── 2026-05-13.md          ← 今天的记录
├── 2026-05-12.md
├── assets/                ← 所有截图/图片 (YYYY-MM-DD-HHMMSS.png)
├── README.md              ← 给 AI 看的目录说明
└── .scripts/
    ├── append_text.sh         ← 追加文本 (内置 TAG/NOTE/编码兜底)
    ├── append_image.sh        ← 追加图片
    ├── capture_screenshot.sh  ← 截图 + OCR + 存原图
    ├── ocr_image              ← Vision OCR 二进制
    ├── ocr_image.swift        ← OCR 源码
    ├── copy_today.sh          ← 复制今天到剪贴板
    ├── copy_week.sh           ← 复制本周到剪贴板
    └── stats.sh               ← 统计数据
```

系统级:

```
~/Library/Services/
├── 存入 AI 秘书.workflow
├── 存入 AI 秘书 (选标签).workflow
├── 存入 AI 秘书 (加备注).workflow
└── 存入 AI 秘书 (截图).workflow
```

## 喂给 AI 的三种姿势

### 姿势 1: 拖文件夹 (最强,适合 Claude)
直接把 `~/AISecretary` 整个文件夹拖到 Claude 对话框。Claude 会先读 `README.md` 了解结构,然后回答你 "总结这周"、"找出反复出现的主题"、"提取所有 #TODO" 之类的问题。

### 姿势 2: 复制粘贴 (最快,适合 ChatGPT)
```bash
~/AISecretary/.scripts/copy_today.sh
# 然后切到 ChatGPT,⌘V 粘贴
```

### 姿势 3: Obsidian (最佳本地体验)
下载 Obsidian → "Open folder as vault" → 选 `~/AISecretary`,立刻获得全文搜索、双向链接、图谱视图。注意:你不是用 Obsidian 来写,而是来看。

## 卸载

```bash
./uninstall_aisecretary.sh
```

默认保留你的数据,会问你是否一并删除。

## 核心文件清单

| 文件 | 作用 |
|---|---|
| `install_aisecretary.sh` | 一键安装 (注:目前只装基础版,需后续手动升级到 4 服务) |
| `uninstall_aisecretary.sh` | 一键卸载 |
| `~/AISecretary/.scripts/append_text.sh` | 追加文本 (核心,含编码兜底) |
| `~/AISecretary/.scripts/append_image.sh` | 追加图片 |
| `~/AISecretary/.scripts/capture_screenshot.sh` | 截图 + OCR + 存原图 |
| `~/AISecretary/.scripts/copy_today.sh` | 复制今天到剪贴板 |
| `~/AISecretary/.scripts/copy_week.sh` | 复制本周到剪贴板 |
| `~/Library/Services/存入 AI 秘书*.workflow` | 4 个右键菜单服务 |

每个文件都是纯文本/纯 plist,你随时可以打开看、改、删除。没有任何二进制黑盒 (除了编译过的 OCR 二进制 `ocr_image`,源码也在 `.scripts/ocr_image.swift`)。
