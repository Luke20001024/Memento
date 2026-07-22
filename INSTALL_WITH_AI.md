# Memento · AI 安装指南

这份文件写给协助用户安装 Memento 的 AI / Agent。目标不是把所有增强能力一次装满，而是先让用户在一台新的 Mac 上完成第一条本地记录，再按需启用 Chrome、Obsidian 和 Codex。

## 完成标准

基础安装完成必须同时满足：

1. 一条测试记录已经写入 `~/AISecretary/YYYY-MM-DD.md`。
2. 原始记录不依赖 Obsidian 或 Codex，也能继续保存和打开。
3. 如果用户选择启用 Chrome Dashboard，新标签页能够读取 `~/AISecretary`。
4. Agent 明确报告哪些能力已启用、哪些能力因系统、软件或权限条件而降级。

不要把“安装脚本执行结束”当作完成。

## 权限与安全边界

- 在运行安装器、覆盖已有 Memento 执行组件、请求系统权限或卸载前，先向用户说明影响。
- 如果 `~/AISecretary` 已存在，不得删除、移动或重建它。安装器会保留 Markdown、资产和 Review；由用户确认是否升级。
- 不替用户点击文件夹、相机、麦克风、位置、Chrome 开发者模式或 macOS 快捷键授权。
- 不强制安装 Obsidian、Codex、Homebrew 或其他 AI 客户端。
- 不上传 `~/AISecretary` 中的原始记录。只有用户明确启用 Daily Review 时，目标日文本才可以交给配置好的模型。
- 任何一步失败时保留已经写入的本地事实，不通过删除用户目录“重试”。

## 能力与依赖

| 能力 | 必需条件 | 缺失时的行为 |
|---|---|---|
| 文字记录、备注、标签 | macOS、`python3`、`plutil` | 缺少 `python3` 时先引导安装 Apple Command Line Tools |
| 截图原图 | 基础安装 | OCR 不可用时仍保存原始截图 |
| 截图 OCR、每日第一帧 | `swiftc`、`codesign` | 跳过增强能力，基础记录继续可用 |
| 语音记录 | macOS 26+、`swiftc`、`codesign` | 不创建语音 Service |
| Chrome Dashboard | Google Chrome、用户手工加载扩展并授权目录 | 本地 Markdown 记录继续可用 |
| Obsidian 回看 | Obsidian，可选 | 可用 Finder、文本编辑器或 Chrome 回看 |
| Codex Daily Review | 用户配置的 Codex 与自动任务，可选 | 不生成 AI 总结；原始记录与 Dashboard 继续可用 |

## 1. 确认发布版本一致

安装前读取：

- 仓库根目录 `README.md` 中的“当前版本”。
- `chrome-newtab/manifest.json` 中的 `version`。
- GitHub Latest Release 的 Tag 和 ZIP 文件名内目录。

四者版本必须一致。若不一致，停止并向用户说明，不要把旧 Release 和新版 README 混合安装。

## 2. 环境检查

只运行只读检查：

```bash
sw_vers
uname -m
command -v python3
command -v plutil
command -v swiftc || true
test -d /Applications/Google\ Chrome.app && echo "Chrome: installed" || true
test -d /Applications/Obsidian.app && echo "Obsidian: installed (optional)" || true
command -v codex || true
test -d "$HOME/AISecretary" && echo "Existing Memento data found" || true
```

如果缺少 `python3`，基础安装会停止。先向用户说明 Apple Command Line Tools 的用途，再由用户确认运行：

```bash
xcode-select --install
```

安装完成后重新检查 `python3` 和 `plutil`。Obsidian 与 Codex 缺失不阻塞基础安装。

## 3. 下载并校验 Release

优先使用 GitHub Latest Release，不从陌生镜像下载：

- ZIP：<https://github.com/Luke20001024/Memento/releases/latest/download/Memento-macOS.zip>
- SHA-256：<https://github.com/Luke20001024/Memento/releases/latest/download/Memento-macOS.zip.sha256>

下载到同一目录后校验：

```bash
cd "$HOME/Downloads"
shasum -a 256 -c Memento-macOS.zip.sha256
```

只有输出 `Memento-macOS.zip: OK` 才继续。

## 4. 执行基础安装

以下示例中的版本目录应以当前 Release 为准：

```bash
cd "$HOME/Downloads"
unzip Memento-macOS.zip
cd Memento-v0.8.9
chmod +x install_aisecretary.sh uninstall_aisecretary.sh
./install_aisecretary.sh
```

如果安装器发现已有 `~/AISecretary`，向用户说明：继续会更新脚本、Service、Dashboard 和 Review 协议，但会保留原始 Markdown、资产、Review 与用户补充。只有用户确认后才输入 `y`。

安装末尾是否打开 `chrome://extensions` 由用户决定。Chrome 不存在或用户暂不启用时，不影响基础记录。

## 5. 完成第一条记录

优先让用户亲自验证一次真实入口：

1. 打开“系统设置 → 键盘 → 键盘快捷键 → 服务”。
2. 为“存入 AI 秘书”绑定一个快捷键，例如 `⌃1`。
3. 在任意支持 Services 的应用中选中一段测试文字并触发快捷键。
4. 检查当天文件：

```bash
TODAY=$(date +%Y-%m-%d)
test -f "$HOME/AISecretary/$TODAY.md"
tail -40 "$HOME/AISecretary/$TODAY.md"
```

第一次成功记录可能邀请拍摄“每日第一帧”。相机和位置权限由用户选择；跳过不会撤销刚刚保存的文字。

## 6. 可选：Chrome Dashboard

只有用户希望用新标签页回看时才启用：

1. Chrome 打开 `chrome://extensions`。
2. 用户打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `~/AISecretary/.chrome-newtab/`。
5. 打开新标签页，点击“授权数据目录”。
6. 用户选择 `~/AISecretary` 并允许读取。
7. 确认刚才的测试记录已经出现。

若公司策略禁止未打包扩展，报告限制并保留本地记录，不尝试绕过组织策略。

## 7. 可选：Obsidian

Obsidian 只是本地 Markdown 的搜索和编辑界面，不是 Memento 的存储依赖。

用户选择启用时：

1. 从 <https://obsidian.md/download> 安装 Obsidian。
2. 打开 Obsidian，选择“打开本地文件夹作为仓库”。
3. 选择 `~/AISecretary`。
4. 打开 `Memento.md` 或 `Memento.base`。

不安装 Obsidian 时，可以用 Finder、文本编辑器和 Chrome Dashboard 继续使用全部基础记录。

## 8. 可选：Codex Daily Review

不要因为仓库中存在 `.review/` 就声称 AI 总结已经启用。安装器只铺设协议，不会为新机器创建 08:00 与 21:00 的自动任务。

只有用户明确要求时，才根据 `daily-review/DAILY_REVIEW.md` 配置 Codex。配置后先对一个明确日期运行状态检查；仅当状态为 `needs_generation` 才调用模型。不得修改原始 `YYYY-MM-DD.md`。

没有 Codex 时，应报告：

> 基础记录和 Chrome Dashboard 已可用；AI Daily Review 尚未启用，不影响原始数据。

## 9. 最终验收报告

安装 Agent 应逐项汇报：

- 安装来源、Release 版本与 SHA-256 校验结果。
- `~/AISecretary` 是否为新建或已有目录。
- 测试记录的日期与文件路径，不回显用户真实内容。
- 文本、截图、OCR、每日第一帧、语音分别是否可用。
- Chrome Dashboard 是否启用并成功读取。
- Obsidian 是否跳过或启用。
- Codex Daily Review 是否跳过或启用。
- 用户仍需亲自完成的权限或快捷键步骤。

## 可直接交给 AI 的提示词

```text
请阅读 https://github.com/Luke20001024/Memento 以及仓库根目录的 INSTALL_WITH_AI.md，
帮助我在这台 Mac 上安装 GitHub Latest Release。严格按照指南先检查版本、SHA-256、系统和依赖；
先完成不依赖 Obsidian 与 Codex 的基础记录，再由我决定是否启用 Chrome Dashboard、Obsidian 和 Codex。
涉及安装开发工具、系统授权、覆盖已有组件或删除数据时必须先问我。
安装后让我亲自写入一条测试记录，并验证它已保存在 ~/AISecretary；
最后用清单说明已经可用的能力、降级能力和仍需我完成的步骤。
```
