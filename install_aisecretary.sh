#!/bin/bash
# ============================================================
# AISecretary 一键安装脚本
# 作用: 在 macOS 上搭建一个"碎片承接器",把你各处的灵感
#      自动整理成 AI 友好的 Markdown 文件夹
#
# 安装后你将拥有:
#   1. 一个 ~/AISecretary 文件夹 (你的数据)
#   2. 两个 Shell 脚本 (追加文本/图片)
#   3. 一个右键菜单项 "存入 AI 秘书" (需手动绑定快捷键)
#   4. 一个截图自动入库的后台服务 (可选)
#
# 使用前提: macOS 10.14 或更新版本
# 使用风险: 会在你的家目录创建文件夹和后台服务,
#         如要完全卸载请运行 uninstall_aisecretary.sh
# ============================================================

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       AISecretary 安装程序             ║${NC}"
echo -e "${BLUE}║       碎片承接器 · 本地 Markdown       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# 检查 macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo -e "${RED}✗ 此脚本仅支持 macOS${NC}"
  exit 1
fi

# 默认目录
SECRETARY_DIR="$HOME/AISecretary"
SCRIPT_DIR="$SECRETARY_DIR/.scripts"

# 确认
if [ -d "$SECRETARY_DIR" ]; then
  echo -e "${YELLOW}⚠ 发现已存在的 ~/AISecretary 文件夹${NC}"
  read -p "继续会保留你的数据,但会覆盖脚本。继续吗? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
fi

# ============================================================
# Step 1: 建立文件夹结构
# ============================================================
echo -e "${BLUE}[1/5] 创建文件夹...${NC}"
mkdir -p "$SECRETARY_DIR/assets"
mkdir -p "$SCRIPT_DIR"

# ============================================================
# Step 2: 写 README (给 AI 看的说明)
# ============================================================
echo -e "${BLUE}[2/5] 创建 README (给 AI 看的说明)...${NC}"
cat > "$SECRETARY_DIR/README.md" << 'EOF'
# 我的碎片记录库

这是一个"承接器"——我在各种 App 里写下的零散想法,会按天整理在这里。

## 文件结构

- 每个 .md 文件是一天的记录,文件名格式: `YYYY-MM-DD.md`
- 每条记录用 `## HH:MM · 周X` 开头
- 用 `---` 分隔每条记录
- 图片统一放在 `assets/` 文件夹

## 给 AI 的说明

如果你正在阅读这个文件夹来帮我处理内容,请注意:

1. **跨日期检索**: 按文件名 (YYYY-MM-DD) 定位,文件名就是日期
2. **每条记录独立**: 不要假设上下文连续——它们是不同时刻的不同想法
3. **来源标记**: 末尾的 `— App名` 表示这条记录是从哪个应用捕获的
4. **总结请求**: 如果我让你"总结今天",读最新日期的文件;"本周"则读过去 7 天

## 我的常见诉求

- 把今天的碎片归类成几个主题
- 找出最近一周反复出现的关键词
- 把某天的想法整理成一篇文章草稿
- 提取所有待办事项 (通常我会写"todo:" 开头)

EOF

# ============================================================
# Step 3: 写文本追加脚本
# ============================================================
echo -e "${BLUE}[3/5] 创建核心脚本...${NC}"
cat > "$SCRIPT_DIR/append_text.sh" << 'BASH_EOF'
#!/bin/bash
# 追加文本到今天的 Markdown
# 用法: append_text.sh "内容"
# 环境变量: SOURCE_APP (来源 App 名,可选)

CONTENT="$1"
[ -z "$CONTENT" ] && exit 0

DIR="$HOME/AISecretary"
TODAY=$(date +%Y-%m-%d)
FILE="$DIR/$TODAY.md"
TIME=$(date +%H:%M)
WEEKDAY=$(date +%u)
WEEKDAYS=("一" "二" "三" "四" "五" "六" "日")
WD="周${WEEKDAYS[$((WEEKDAY-1))]}"

# 如果文件不存在,加 frontmatter
if [ ! -f "$FILE" ]; then
  {
    echo "---"
    echo "date: $TODAY"
    echo "---"
  } > "$FILE"
fi

# 追加内容
{
  echo ""
  echo "## $TIME · $WD"
  echo ""
  echo "$CONTENT"
  if [ -n "$SOURCE_APP" ]; then
    echo ""
    echo "— $SOURCE_APP"
  fi
  echo ""
  echo "---"
} >> "$FILE"

# 屏幕通知
osascript -e "display notification \"已存入 $TODAY.md\" with title \"AISecretary\"" 2>/dev/null || true
BASH_EOF
chmod +x "$SCRIPT_DIR/append_text.sh"

# ============================================================
# Step 4: 写图片追加脚本
# ============================================================
cat > "$SCRIPT_DIR/append_image.sh" << 'BASH_EOF'
#!/bin/bash
# 追加图片到今天的 Markdown
# 用法: append_image.sh /path/to/image.png

SRC="$1"
[ ! -f "$SRC" ] && exit 0

DIR="$HOME/AISecretary"
TODAY=$(date +%Y-%m-%d)
FILE="$DIR/$TODAY.md"
TIME=$(date +%H:%M)
TIMESTAMP=$(date +%H%M%S)
EXT="${SRC##*.}"
BASENAME="${TODAY}-${TIMESTAMP}.${EXT}"
DEST="$DIR/assets/$BASENAME"

cp "$SRC" "$DEST"

if [ ! -f "$FILE" ]; then
  {
    echo "---"
    echo "date: $TODAY"
    echo "---"
  } > "$FILE"
fi

{
  echo ""
  echo "## $TIME"
  echo ""
  echo "![](./assets/$BASENAME)"
  echo ""
  echo "---"
} >> "$FILE"

osascript -e "display notification \"图片已存入\" with title \"AISecretary\"" 2>/dev/null || true
BASH_EOF
chmod +x "$SCRIPT_DIR/append_image.sh"

# ============================================================
# Step 5: 写一个辅助脚本——快速查看/复制今天
# ============================================================
cat > "$SCRIPT_DIR/copy_today.sh" << 'BASH_EOF'
#!/bin/bash
# 把今天的 Markdown 复制到剪贴板,方便粘贴给 AI
TODAY=$(date +%Y-%m-%d)
FILE="$HOME/AISecretary/$TODAY.md"

if [ ! -f "$FILE" ]; then
  osascript -e "display notification \"今天还没有任何记录\" with title \"AISecretary\""
  exit 0
fi

pbcopy < "$FILE"
LINES=$(wc -l < "$FILE" | tr -d ' ')
osascript -e "display notification \"今天的 $LINES 行已复制到剪贴板\" with title \"AISecretary\""
BASH_EOF
chmod +x "$SCRIPT_DIR/copy_today.sh"

cat > "$SCRIPT_DIR/copy_week.sh" << 'BASH_EOF'
#!/bin/bash
# 把过去 7 天的 Markdown 拼起来复制到剪贴板
DIR="$HOME/AISecretary"
TMP=$(mktemp)

for i in 6 5 4 3 2 1 0; do
  DATE=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y-%m-%d)
  FILE="$DIR/$DATE.md"
  if [ -f "$FILE" ]; then
    echo "" >> "$TMP"
    echo "# === $DATE ===" >> "$TMP"
    echo "" >> "$TMP"
    cat "$FILE" >> "$TMP"
  fi
done

if [ ! -s "$TMP" ]; then
  osascript -e "display notification \"过去 7 天没有任何记录\" with title \"AISecretary\""
  rm "$TMP"
  exit 0
fi

pbcopy < "$TMP"
rm "$TMP"
osascript -e "display notification \"本周记录已复制到剪贴板\" with title \"AISecretary\""
BASH_EOF
chmod +x "$SCRIPT_DIR/copy_week.sh"

# ============================================================
# Step 6: 安装 Quick Action (右键菜单)
# ============================================================
echo -e "${BLUE}[4/5] 安装右键菜单 (Quick Action)...${NC}"

SERVICES_DIR="$HOME/Library/Services"
mkdir -p "$SERVICES_DIR"

WORKFLOW_DIR="$SERVICES_DIR/存入 AI 秘书.workflow"
mkdir -p "$WORKFLOW_DIR/Contents"

# Info.plist
cat > "$WORKFLOW_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSServices</key>
    <array>
        <dict>
            <key>NSMenuItem</key>
            <dict>
                <key>default</key>
                <string>存入 AI 秘书</string>
            </dict>
            <key>NSMessage</key>
            <string>runWorkflowAsService</string>
            <key>NSRequiredContext</key>
            <dict>
                <key>NSApplicationIdentifier</key>
                <string>com.apple.finder</string>
            </dict>
            <key>NSSendTypes</key>
            <array>
                <string>NSStringPboardType</string>
                <string>public.plain-text</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF

# document.wflow (Automator 工作流文件)
cat > "$WORKFLOW_DIR/Contents/document.wflow" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>512</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>CONTENT=\$(cat)
export SOURCE_APP=\$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2&gt;/dev/null)
"\$HOME/AISecretary/.scripts/append_text.sh" "\$CONTENT"</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>0</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>$(uuidgen)</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>$(uuidgen)</string>
				<key>UUID</key>
				<string>$(uuidgen)</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>conversionLabel</key>
				<integer>0</integer>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:316.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceApplicationBundleID</key>
		<string></string>
		<key>serviceApplicationPath</key>
		<string></string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.text</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
EOF

# ============================================================
# Step 7: 截图自动入库 (可选)
# ============================================================
echo -e "${BLUE}[5/5] 配置截图自动入库 (可选)...${NC}"
echo ""
read -p "是否启用桌面截图自动入库? (会监听 ~/Desktop 上以 'Screen' 开头的 PNG 文件) [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.aisecretary.screenshot.plist"
  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aisecretary.screenshot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>sleep 1; for f in "$HOME/Desktop"/Screen*.png "$HOME/Desktop"/截屏*.png; do [ -f "\$f" ] && "$SCRIPT_DIR/append_image.sh" "\$f" && rm "\$f"; done</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>$HOME/Desktop</string>
    </array>
</dict>
</plist>
EOF

  # 卸载旧的 (如果存在), 加载新的
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo -e "${GREEN}✓ 截图监听已启用${NC}"
  SCREENSHOT_ENABLED=true
else
  echo "已跳过截图监听 (你以后可以重新运行此脚本启用)"
  SCREENSHOT_ENABLED=false
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         ✓ 安装完成!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}你的数据文件夹:${NC} ~/AISecretary"
echo -e "${BLUE}核心脚本:${NC}     ~/AISecretary/.scripts/"
echo ""
echo -e "${YELLOW}━━━ 接下来你需要做两件事 ━━━${NC}"
echo ""
echo -e "${YELLOW}1. 给右键菜单绑个全局快捷键 (强烈推荐):${NC}"
echo "   打开: 系统设置 → 键盘 → 键盘快捷键 → 服务"
echo "   找到: '存入 AI 秘书' (在 '文本' 分类下)"
echo "   推荐快捷键: ⌃⌥⌘S"
echo ""
echo -e "${YELLOW}2. 测试一下:${NC}"
echo "   去任何 App,选中一段文字,右键 → 服务 → '存入 AI 秘书'"
echo "   或者直接在终端运行:"
echo "   ~/AISecretary/.scripts/append_text.sh \"hello AISecretary\""
echo ""
echo -e "${BLUE}━━━ 常用命令 ━━━${NC}"
echo ""
echo "  查看今天的记录:    open ~/AISecretary/\$(date +%Y-%m-%d).md"
echo "  打开数据文件夹:    open ~/AISecretary"
echo "  复制今天到剪贴板:  ~/AISecretary/.scripts/copy_today.sh"
echo "  复制本周到剪贴板:  ~/AISecretary/.scripts/copy_week.sh"
echo ""
echo -e "${BLUE}━━━ 喂给 AI 的方式 ━━━${NC}"
echo ""
echo "  方式 1 (推荐): 把整个 ~/AISecretary 文件夹拖给 Claude/ChatGPT"
echo "  方式 2:        运行 copy_today.sh,然后 ⌘V 粘贴到 AI 对话框"
echo "  方式 3:        用 Obsidian 打开此文件夹,享受全文搜索和图谱"
echo ""
echo -e "${YELLOW}如需卸载: 运行 uninstall_aisecretary.sh${NC}"
echo ""
