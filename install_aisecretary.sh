#!/bin/bash
# ============================================================
# AISecretary 安装脚本 (v2 · 4 服务版)
# ============================================================
# 安装内容:
#   - 数据目录 ~/AISecretary/ 及其子结构
#   - 8 个核心脚本到 ~/AISecretary/.scripts/ (含编码兜底、TAG/NOTE 支持)
#   - 4 个 macOS 服务 (Quick Actions / Services):
#       1. 存入 AI 秘书           (选中文字 → 直接存入)
#       2. 存入 AI 秘书 (选标签)   (选中文字 → 选标签 → 存入)
#       3. 存入 AI 秘书 (加备注)   (选中文字 → 输入备注 → 存入)
#       4. 存入 AI 秘书 (截图)     (调系统截图 → OCR → 存入)
# 不再安装截图监听 LaunchAgent (由 "截图" 服务替代)
# ============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       AISecretary 安装程序 v2          ║${NC}"
echo -e "${BLUE}║       4 服务 · AI 友好格式             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

SECRETARY_DIR="$HOME/AISecretary"
SCRIPT_DIR="$SECRETARY_DIR/.scripts"
SERVICES_DIR="$HOME/Library/Services"
INSTALLER_DIR=$(cd "$(dirname "$0")" && pwd)

if [ -d "$SECRETARY_DIR" ]; then
  echo -e "${YELLOW}⚠ 发现已存在的 ~/AISecretary 文件夹${NC}"
  read -p "继续会保留你的 md 数据,但会覆盖脚本和服务。继续吗? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
fi

# ============================================================
# Step 1: 文件夹
# ============================================================
echo -e "${BLUE}[1/6] 创建文件夹...${NC}"
mkdir -p "$SECRETARY_DIR/assets"
mkdir -p "$SCRIPT_DIR"
mkdir -p "$SERVICES_DIR"

# ============================================================
# Step 2: 写 ~/AISecretary/README.md (给 AI 看的目录说明)
# ============================================================
echo -e "${BLUE}[2/6] 创建 README (给 AI 看的说明)...${NC}"
cat > "$SECRETARY_DIR/README.md" << 'README_EOF'
# 我的碎片记录库

这是一个"承接器"——我在各种 App 里写下的零散想法,会按天整理在这里。所有文件统一 UTF-8 编码。

## 文件结构

- 每天一个 `.md` 文件,文件名: `YYYY-MM-DD.md`
- 每条记录用 `---` 分隔
- 图片/截图统一放在 `assets/`,文件名: `YYYY-MM-DD-HHMMSS.png`

## 条目格式

每条记录的 heading 把所有元信息塑在一行:

`## HH:MM · 周X [· 来源App] [· #标签]`

举例:

- `## 11:30 · 周三` — 直接存入,无来源无标签
- `## 11:30 · 周三 · WeChat` — 从微信存入
- `## 15:57 · 周日 · Feishu · #灵感` — 飞书来源,标记为灵感
- `## 11:30 · 周三 · 截图·OCR` — 截图条目,OCR 文字作为正文
- `## 11:30 · 周三 · 截图` — 纯截图,正文是图片引用

heading 下方是正文。可选的备注用 blockquote:

`> 备注: ...`

截图条目正文之后,会附原图引用:

`> ![原截图](./assets/2026-05-13-150000.png)`

## 标签体系

只用 3 个固定标签:

- `#TODO` — 待办事项
- `#下次再读` — 暂存,稍后再看
- `#灵感` — 想法/创意

## 给 AI 的说明

阅读这个文件夹帮我处理内容时:

1. **跨日期检索**: 按文件名 (YYYY-MM-DD) 定位
2. **每条记录独立**: 不要假设上下文连续——它们是不同时刻的不同想法
3. **元信息在 heading**: 按 ` · ` 分割 `## HH:MM · 周X · 来源 · #标签`,即可拿到全部 metadata
4. **标签筛选**: 比如"列出所有 TODO" → 找含 `#TODO` 的 heading 块
5. **截图条目**: heading 含 `截图·OCR` 的,正文就是图中文字
6. **总结请求**: "今天" → 最新日期的文件;"本周" → 过去 7 天

## 我的常见诉求

- 把今天的碎片归类成几个主题
- 找出最近一周反复出现的关键词
- 把某天的想法整理成一篇文章草稿
- 提取所有 `#TODO` 项
- 列出所有 `#下次再读` 的内容,准备开始读
README_EOF

# ============================================================
# Step 3: 核心脚本
# ============================================================
echo -e "${BLUE}[3/6] 创建核心脚本...${NC}"

cat > "$SCRIPT_DIR/append_text.sh" << 'BASH_EOF'
#!/bin/bash
# 追加文本到今天的 Markdown (AI 友好格式 · 元信息全塑到 heading)
# 用法: append_text.sh "内容"
# 环境变量:
#   SOURCE_APP — 来源 App 名 (可选)
#   TAG        — 标签名,heading 里显示为 #TAG (可选)
#   NOTE       — 备注文本,放在内容下方的引用块 (可选)
#
# 输出示例:
#   ## 15:57 · 周日 · Feishu · #灵感
#
#   正文内容
#
#   > 备注: 在路上想到的
#
#   ---

CONTENT="$1"
[ -z "$CONTENT" ] && exit 0

# 编码兜底: 某些 App (如飞书) 会以 GBK/GB18030 编码递给 Service,
# 若不转换就写入,文件会混编码,Trae/Obsidian 等编辑器按 UTF-8 读会乱码。
if ! printf '%s' "$CONTENT" | iconv -f utf-8 -t utf-8 >/dev/null 2>&1; then
  for ENC in gbk gb18030 big5; do
    CONVERTED=$(printf '%s' "$CONTENT" | iconv -f "$ENC" -t utf-8 2>/dev/null) && {
      CONTENT="$CONVERTED"
      break
    }
  done
fi

DIR="$HOME/AISecretary"
TODAY=$(date +%Y-%m-%d)
FILE="$DIR/$TODAY.md"
TIME=$(date +%H:%M)
WEEKDAY=$(date +%u)
WEEKDAYS=("一" "二" "三" "四" "五" "六" "日")
WD="周${WEEKDAYS[$((WEEKDAY-1))]}"

if [ ! -f "$FILE" ]; then
  {
    echo "---"
    echo "date: $TODAY"
    echo "---"
  } > "$FILE"
fi

# 组装 heading: ## 时间 · 周X [· 来源] [· #标签]
HEADING="## $TIME · $WD"
[ -n "$SOURCE_APP" ] && HEADING="$HEADING · $SOURCE_APP"
[ -n "$TAG" ]        && HEADING="$HEADING · #$TAG"

{
  echo ""
  echo "$HEADING"
  echo ""
  echo "$CONTENT"
  if [ -n "$NOTE" ]; then
    echo ""
    echo "> 备注: $NOTE"
  fi
  echo ""
  echo "---"
} >> "$FILE"

NOTIFY_MSG="已存入 $TODAY.md"
[ -n "$TAG" ] && NOTIFY_MSG="已存入 [#$TAG]"
osascript -e "display notification \"$NOTIFY_MSG\" with title \"AISecretary\"" 2>/dev/null || true
BASH_EOF
chmod +x "$SCRIPT_DIR/append_text.sh"

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

cat > "$SCRIPT_DIR/capture_screenshot.sh" << 'BASH_EOF'
#!/bin/bash
# 截图 → OCR → 存入今天的 Markdown (AI 友好格式 · 元信息全塑到 heading)
# 行为:
#   - 弹出 macOS 系统选区截图
#   - OCR 提取文字 (Vision 框架,支持中英文)
#   - OCR 文字 > 20 字符时,写为正文 + 原图引用
#   - OCR 文字过短或失败时,只写图片
TMP="/tmp/aisecretary_$(date +%s).png"
screencapture -i "$TMP"
[ ! -f "$TMP" ] && exit 0

TODAY=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%H%M%S)
BASENAME="${TODAY}-${TIMESTAMP}.png"
DEST="$HOME/AISecretary/assets/$BASENAME"
cp "$TMP" "$DEST"
rm "$TMP"

DIR="$HOME/AISecretary"
FILE="$DIR/$TODAY.md"
TIME=$(date +%H:%M)
WEEKDAY=$(date +%u)
WEEKDAYS=("一" "二" "三" "四" "五" "六" "日")
WD="周${WEEKDAYS[$((WEEKDAY-1))]}"

if [ ! -f "$FILE" ]; then
    printf -- "---\ndate: %s\n---\n" "$TODAY" > "$FILE"
fi

OCR_TEXT=$("$HOME/AISecretary/.scripts/ocr_image" "$DEST" 2>/dev/null)

if [ ${#OCR_TEXT} -gt 20 ]; then
    {
        echo ""
        echo "## $TIME · $WD · 截图·OCR"
        echo ""
        echo "$OCR_TEXT"
        echo ""
        echo "> ![原截图](./assets/$BASENAME)"
        echo ""
        echo "---"
    } >> "$FILE"
    osascript -e "display notification \"文字已提取存入 $TODAY.md\" with title \"AISecretary\"" 2>/dev/null || true
else
    {
        echo ""
        echo "## $TIME · $WD · 截图"
        echo ""
        echo "![](./assets/$BASENAME)"
        echo ""
        echo "---"
    } >> "$FILE"
    osascript -e "display notification \"截图已存入\" with title \"AISecretary\"" 2>/dev/null || true
fi
BASH_EOF
chmod +x "$SCRIPT_DIR/capture_screenshot.sh"

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

cat > "$SCRIPT_DIR/stats.sh" << 'BASH_EOF'
#!/bin/bash
# AISecretary 自我对账
# 回答 README 里"我真的会持续用吗 / 攒了多少条"的问题

DIR="$HOME/AISecretary"

if [ ! -d "$DIR" ]; then
  echo "AISecretary 文件夹不存在: $DIR"
  exit 1
fi

PATTERN='[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md'

TOTAL_DAYS=$(find "$DIR" -maxdepth 1 -type f -name "$PATTERN" | wc -l | tr -d ' ')

if [ "$TOTAL_DAYS" -eq 0 ]; then
  echo "还没有任何记录"
  exit 0
fi

TOTAL_ENTRIES=$(find "$DIR" -maxdepth 1 -type f -name "$PATTERN" -exec grep -h "^## " {} + 2>/dev/null | wc -l | tr -d ' ')
FIRST=$(find "$DIR" -maxdepth 1 -type f -name "$PATTERN" | sort | head -1 | xargs basename | sed 's/\.md$//')
LAST=$(find "$DIR" -maxdepth 1 -type f -name "$PATTERN" | sort | tail -1 | xargs basename | sed 's/\.md$//')

# 最近 7 天活跃
ACTIVE_7=0
for i in 0 1 2 3 4 5 6; do
  d=$(date -v-${i}d +%Y-%m-%d 2>/dev/null)
  [ -f "$DIR/$d.md" ] && ACTIVE_7=$((ACTIVE_7+1))
done

echo ""
echo "━━━ AISecretary 对账 ━━━"
echo ""
echo "总条数:           $TOTAL_ENTRIES"
echo "有记录的天数:     $TOTAL_DAYS"
echo "跨度:             $FIRST → $LAST"
echo "最近 7 天活跃:    $ACTIVE_7 / 7"

if [ "$ACTIVE_7" -lt 2 ]; then
  echo ""
  echo "→ 最近一周几乎没用,是真的不需要,还是忘了?"
fi
echo ""
BASH_EOF
chmod +x "$SCRIPT_DIR/stats.sh"

cat > "$SCRIPT_DIR/ocr_image.swift" << 'SWIFT_EOF'
import Vision
import Foundation

guard CommandLine.arguments.count > 1 else { exit(1) }
let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(url: imageURL)
try? handler.perform([request])

let text = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")

print(text)
SWIFT_EOF

if command -v swiftc >/dev/null 2>&1; then
  swiftc -O "$SCRIPT_DIR/ocr_image.swift" -o "$SCRIPT_DIR/ocr_image" 2>/dev/null && {
    chmod +x "$SCRIPT_DIR/ocr_image"
    echo -e "${GREEN}  ✓ OCR 二进制已编译${NC}"
  } || echo -e "${YELLOW}  ⚠ OCR 编译失败 (截图存入仍可用,只是没 OCR 文字)${NC}"
else
  echo -e "${YELLOW}  ⚠ 未找到 swiftc,跳过 OCR 编译${NC}"
  echo -e "${YELLOW}    安装 Xcode Command Line Tools 后,重跑本脚本即可获得 OCR${NC}"
fi

# ============================================================
# Step 4: 安装 4 个 Workflow
# ============================================================
echo -e "${BLUE}[4/6] 安装 4 个右键菜单服务...${NC}"

write_workflow() {
  local NAME="$1"
  local INPUT_TYPE="$2"
  local CMD_STRING="$3"
  local WF_DIR="$SERVICES_DIR/$NAME.workflow/Contents"
  mkdir -p "$WF_DIR"

  # Info.plist: 选中文字触发的 service 需 NSSendTypes; 无输入的不需要
  if [ "$INPUT_TYPE" = "text" ]; then
    cat > "$WF_DIR/Info.plist" << INFO_EOF
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
                <string>$NAME</string>
            </dict>
            <key>NSMessage</key>
            <string>runWorkflowAsService</string>
            <key>NSSendTypes</key>
            <array>
                <string>NSStringPboardType</string>
                <string>public.plain-text</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
INFO_EOF
  else
    cat > "$WF_DIR/Info.plist" << INFO_EOF
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
                <string>$NAME</string>
            </dict>
            <key>NSMessage</key>
            <string>runWorkflowAsService</string>
        </dict>
    </array>
</dict>
</plist>
INFO_EOF
  fi

  # COMMAND_STRING 需要 XML 转义 (& < >)
  local CMD_ESC
  CMD_ESC=$(printf '%s' "$CMD_STRING" | python3 -c 'import sys, html; sys.stdout.write(html.escape(sys.stdin.read()))')
  local INPUT_ID="com.apple.Automator.$INPUT_TYPE"

  cat > "$WF_DIR/document.wflow" << WFLOW_EOF
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
					<string>$CMD_ESC</string>
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
				<string>96F7841E-ADE8-4A09-9B67-038E1F11DB06</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>9FCFE354-D7F1-414E-B3B4-3DBAD39E897E</string>
				<key>UUID</key>
				<string>C1DD8E96-6D6B-4162-BDFA-6D13A77F6405</string>
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
		<string>$INPUT_ID</string>
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
WFLOW_EOF
  echo -e "${GREEN}  ✓ $NAME${NC}"
}

# 把 4 个 COMMAND_STRING 用单引号 HEREDOC 读进变量(避免转义噩梦)
CMD_DIRECT=$(cat << 'CMD_EOF'
CONTENT=$(cat)
export SOURCE_APP=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
"$HOME/AISecretary/.scripts/append_text.sh" "$CONTENT"
CMD_EOF
)

CMD_TAG=$(cat << 'CMD_EOF'
CONTENT=$(cat)
export SOURCE_APP=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
TAG=$(osascript -e 'set c to choose from list {"TODO","下次再读","灵感"} with prompt "选一个标签" default items {"TODO"}' -e 'if c is false then return ""' -e 'return item 1 of c' 2>/dev/null)
[ -z "$TAG" ] && exit 0
export TAG
"$HOME/AISecretary/.scripts/append_text.sh" "$CONTENT"
CMD_EOF
)

CMD_NOTE=$(cat << 'CMD_EOF'
CONTENT=$(cat)
export SOURCE_APP=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
NOTE=$(osascript -e 'set d to display dialog "备注 (可留空):" default answer "" buttons {"取消","存入"} default button "存入"' -e 'if button returned of d is "取消" then return "__CANCEL__"' -e 'return text returned of d' 2>/dev/null) || exit 0
[ "$NOTE" = "__CANCEL__" ] && exit 0
export NOTE
"$HOME/AISecretary/.scripts/append_text.sh" "$CONTENT"
CMD_EOF
)

CMD_SHOT=$(cat << 'CMD_EOF'
"$HOME/AISecretary/.scripts/capture_screenshot.sh"
CMD_EOF
)

write_workflow "存入 AI 秘书"           "text"    "$CMD_DIRECT"
write_workflow "存入 AI 秘书 (选标签)"  "text"    "$CMD_TAG"
write_workflow "存入 AI 秘书 (加备注)"  "text"    "$CMD_NOTE"
write_workflow "存入 AI 秘书 (截图)"    "nothing" "$CMD_SHOT"

# ============================================================
# Step 5: 刷新 Services 注册
# ============================================================
echo -e "${BLUE}[5/6] 刷新 Services 注册...${NC}"
/System/Library/CoreServices/pbs -update 2>/dev/null || true
killall cfprefsd 2>/dev/null || true

# ============================================================
# Step 6: 安装 Chrome 新标签页 Dashboard (可选)
# ============================================================
echo -e "${BLUE}[6/6] 安装 Chrome 新标签页 Dashboard...${NC}"
NEWTAB_SRC="$INSTALLER_DIR/chrome-newtab"
NEWTAB_DEST="$SECRETARY_DIR/.chrome-newtab"
HAS_NEWTAB=0

if [ -d "$NEWTAB_SRC" ]; then
  rm -rf "$NEWTAB_DEST"
  cp -R "$NEWTAB_SRC" "$NEWTAB_DEST"
  echo -e "${GREEN}  ✓ 已复制到 $NEWTAB_DEST${NC}"
  HAS_NEWTAB=1
else
  echo -e "${YELLOW}  ⚠ 安装包内未找到 chrome-newtab/,跳过 dashboard 安装${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         ✓ 安装完成!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}数据目录:${NC} ~/AISecretary"
echo -e "${BLUE}脚本目录:${NC} ~/AISecretary/.scripts"
echo -e "${BLUE}已装服务:${NC}"
echo "  - 存入 AI 秘书           (选中文字 → 直接存入)"
echo "  - 存入 AI 秘书 (选标签)   (选中文字 → 三选一标签 → 存入)"
echo "  - 存入 AI 秘书 (加备注)   (选中文字 → 输入备注 → 存入)"
echo "  - 存入 AI 秘书 (截图)     (调系统截图 → OCR → 存入)"
echo ""
echo -e "${YELLOW}━━━ 必做的一步: 绑快捷键 ━━━${NC}"
echo "  打开: 系统设置 → 键盘 → 键盘快捷键 → 服务"
echo "  在「文本」分类下:  存入 AI 秘书 / (选标签) / (加备注)"
echo "  在「常规」分类下:  存入 AI 秘书 (截图)"
echo "  推荐组合: ⌃1 / ⌃2 / ⌃3 / ⌃4 (或 ⌃⌥⌘1~4 减少冲突)"
echo ""
echo -e "${BLUE}━━━ 测试 ━━━${NC}"
echo "  ~/AISecretary/.scripts/append_text.sh \"hello AISecretary\""
echo ""
echo -e "${BLUE}━━━ 喂给 AI ━━━${NC}"
echo "  方式 1 (推荐): 把整个 ~/AISecretary 文件夹拖给 Claude/ChatGPT"
echo "  方式 2:        ~/AISecretary/.scripts/copy_today.sh 后 ⌘V 粘贴"
echo "  方式 3:        Obsidian 'Open folder as vault' 选 ~/AISecretary"
echo ""

if [ "$HAS_NEWTAB" = "1" ]; then
  echo -e "${YELLOW}━━━ 可选: 启用 Chrome 新标签页 Dashboard ━━━${NC}"
  echo "  让 Chrome 新标签变成 AISecretary 看板,标签图标显示 TODO 数字徽章。"
  echo ""
  echo "  1. Chrome 地址栏访问 chrome://extensions"
  echo "  2. 右上角打开 [开发者模式]"
  echo "  3. [加载已解压的扩展程序],选择目录:"
  echo -e "       ${BLUE}$NEWTAB_DEST${NC}"
  echo "  4. 开新标签 → 点 [授权 ~/AISecretary 文件夹]"
  echo ""
  read -p "现在帮你打开 chrome://extensions 吗? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null \
      || echo -e "${YELLOW}  ⚠ Chrome 没装或打开失败,请手动访问 chrome://extensions${NC}"
  fi
  echo ""
fi

echo -e "${YELLOW}如需卸载: ./uninstall_aisecretary.sh${NC}"
echo ""
