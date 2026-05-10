# AISecretary · 一键安装包

**AISecretary 是一个 macOS 上的 "碎片承接器"。**

用户在任何地方写下的东西——**微信、Notion、Slack、备忘录**——只需要选中并右键存入，系统就会自动将其按天整理成 AI 能直接读懂的 Markdown 文件夹。

我们坚持**不做总结、不做标签、不做分析**。 它只负责承接你最原始的灵感和上下文（Context）。当你需要 AI 协助时，只需把文件夹拖过去，剩下的交给 AI。

## 它做什么

```
你在任何 App 选中文字 → 右键/快捷键 → 自动追加到今天的 .md
你截图               → (可选)自动入库 → 图片 + 引用追加到今天的 .md
你想喂给 AI          → 把 ~/AISecretary 文件夹拖给 Claude / ChatGPT
```

它不做什么:不做 AI 总结、不做自动打标签、不做云同步、不做账号系统。

## 安装

```bash
# 1. 下载这两个脚本到本地 (任意位置)
# 2. 给执行权限
chmod +x install_aisecretary.sh uninstall_aisecretary.sh

# 3. 运行安装
./install_aisecretary.sh
```

安装过程会问你一个问题: **是否启用桌面截图自动入库**。

- 选 `y`: 以后所有桌面上以 `Screen` 或 `截屏` 开头的 PNG 都会自动移到数据文件夹并写入当天的 .md
- 选 `n`: 只装右键菜单和脚本,以后想启用再跑一次安装脚本即可

## 安装后必做的一步:绑定快捷键

安装脚本不会自动绑快捷键(macOS 限制),需要你手动一次:

1. 打开 **系统设置 → 键盘 → 键盘快捷键 → 服务**
2. 在 `文本` 分类下找到 **"存入 AI 秘书"**
3. 点击右侧空白,按下你想要的组合键(推荐 `⌃⌥⌘S`)

绑完之后,你在任何 App 里选中文字按这个快捷键,内容就静默入库了。

## 安装后会得到什么

```
~/AISecretary/
├── 2026-05-10.md           ← 今天的记录
├── 2026-05-09.md           ← 昨天的记录
├── assets/                 ← 所有图片
├── README.md               ← 给 AI 看的说明
└── .scripts/
    ├── append_text.sh      ← 追加文本
    ├── append_image.sh     ← 追加图片
    ├── copy_today.sh       ← 复制今天到剪贴板
    └── copy_week.sh        ← 复制本周到剪贴板
```

加上系统层面的:
- 一个右键菜单项 `存入 AI 秘书`
- 一个截图监听服务(如果你启用了)

## 喂给 AI 的三种姿势

### 姿势 1: 拖文件夹(最强,适合 Claude)
直接把 `~/AISecretary` 整个文件夹拖到 Claude 对话框。Claude 会先读 `README.md` 了解结构,然后回答你"总结这周"、"找出反复出现的主题"之类的问题。

### 姿势 2: 复制粘贴(最快,适合 ChatGPT)
```bash
~/AISecretary/.scripts/copy_today.sh
# 然后切到 ChatGPT,⌘V 粘贴
```

### 姿势 3: Obsidian(最佳本地体验)
下载 Obsidian → "Open folder as vault" → 选 `~/AISecretary`
立刻获得全文搜索、双向链接、图谱视图。注意:你不是用 Obsidian 来写,而是来看。

## 卸载

```bash
./uninstall_aisecretary.sh
```

默认保留你的数据,会问你是否一并删除。

## 核心文件清单

| 文件 | 作用 |
|---|---|
| `install_aisecretary.sh` | 一键安装 |
| `uninstall_aisecretary.sh` | 一键卸载 |
| `~/AISecretary/.scripts/append_text.sh` | 追加文本(核心) |
| `~/AISecretary/.scripts/append_image.sh` | 追加图片 |
| `~/AISecretary/.scripts/copy_today.sh` | 复制今天到剪贴板 |
| `~/AISecretary/.scripts/copy_week.sh` | 复制本周到剪贴板 |
| `~/Library/Services/存入 AI 秘书.workflow` | 右键菜单 |
| `~/Library/LaunchAgents/com.aisecretary.screenshot.plist` | 截图监听 |

每个文件都是纯文本/纯 plist,你随时可以打开看、改、删除。没有任何二进制黑盒。
