# AISecretary

> A "fragment catcher" for macOS — capture raw context from anywhere, hand it to AI when needed.

![Platform](https://img.shields.io/badge/platform-macOS-blue)
![Shell](https://img.shields.io/badge/shell-bash-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

Whatever you write anywhere — WeChat, Notion, Slack, Apple Notes — just select, right-click, and save. AISecretary automatically organizes it by day into a Markdown folder that any AI can natively read.

We deliberately **don't** summarize, tag, or analyze. AISecretary's only job is to catch your rawest inspirations and context. When you need AI assistance, just drag the folder into your AI of choice and let it do the rest.

---

## ✨ What It Does

| Action | Result |
|---|---|
| Select text in any app → right-click / hotkey | Content is silently appended to today's `.md` |
| Take a screenshot (optional) | Image is auto-saved and referenced in today's `.md` |
| Drag `~/AISecretary` into Claude / ChatGPT | The AI reads your context and answers your questions |

### What it doesn't do

- ❌ No AI summaries
- ❌ No auto-tagging
- ❌ No cloud syncing
- ❌ No account system

Your data lives in plain Markdown files on your disk. That's it.

---

## 📦 Installation

```bash
# 1. Download the two scripts to your local machine (anywhere you like)

# 2. Grant execution permissions
chmod +x install_aisecretary.sh uninstall_aisecretary.sh

# 3. Run the installer
./install_aisecretary.sh
```

During installation, you'll be asked one question: **Do you want to enable auto-saving for desktop screenshots?**

- **Yes** — All future PNGs on your desktop starting with `Screen` (or `截屏`) will automatically move to the data folder and be referenced in today's `.md`.
- **No** — Only the right-click menu and scripts are installed. You can re-run the installer later to enable screenshots.

---

## ⚠️ Required Post-Install Step: Bind a Shortcut

The installer can't bind hotkeys automatically (macOS restriction), so do this once manually:

1. Open **System Settings → Keyboard → Keyboard Shortcuts → Services**
2. Under the **Text** category, find **"Save to AI Secretary"**
3. Click the empty space on the right and press your desired key combination (`⌃⌥⌘S` is recommended)

Once bound, selecting text in any app and pressing the shortcut will silently save the content to your vault.

---

## 📁 What You Get After Installation

```
~/AISecretary/
├── 2026-05-10.md         ← Today's log
├── 2026-05-09.md         ← Yesterday's log
├── assets/               ← All images
├── README.md             ← Instructions for the AI
└── .scripts/
    ├── append_text.sh    ← Appends text (core)
    ├── append_image.sh   ← Appends images
    ├── copy_today.sh     ← Copies today to clipboard
    └── copy_week.sh      ← Copies this week to clipboard
```

Plus system-level additions:

- A right-click menu item: **"Save to AI Secretary"**
- A screenshot listener service (if you enabled it)

---

## 🤖 Three Ways to Feed It to AI

### Method 1 — Drag the folder (most powerful, best for Claude)

Drag the entire `~/AISecretary` folder directly into the Claude chat box. Claude reads `README.md` first to understand the structure, then you can ask things like:

- *"Summarize this week."*
- *"Find recurring themes across the last month."*
- *"What did I think about X on Tuesday?"*

### Method 2 — Copy & paste (fastest, best for ChatGPT)

```bash
~/AISecretary/.scripts/copy_today.sh
# Then switch to ChatGPT and press ⌘V
```

### Method 3 — Obsidian (best local experience)

Download [Obsidian](https://obsidian.md) → **Open folder as vault** → select `~/AISecretary`. You instantly get full-text search, backlinks, and graph view.

> **Note:** Use Obsidian for *viewing*, not for writing. Write everywhere else — let AISecretary catch it.

---

## 🗑 Uninstallation

```bash
./uninstall_aisecretary.sh
```

Your data is kept by default; the script will ask whether you want to delete it as well.

---

## 📋 Core Files

| File | Purpose |
|---|---|
| `install_aisecretary.sh` | One-click install |
| `uninstall_aisecretary.sh` | One-click uninstall |
| `~/AISecretary/.scripts/append_text.sh` | Append text (core) |
| `~/AISecretary/.scripts/append_image.sh` | Append image |
| `~/AISecretary/.scripts/copy_today.sh` | Copy today's log to clipboard |
| `~/AISecretary/.scripts/copy_week.sh` | Copy this week's logs to clipboard |
| `~/Library/Services/Save to AI Secretary.workflow` | Right-click service menu |
| `~/Library/LaunchAgents/com.aisecretary.screenshot.plist` | Screenshot auto-save service |

---

## 💡 Philosophy

Most "second brain" tools fail because they ask you to *organize* before you've finished *thinking*. AISecretary inverts this: capture everything raw, organize nothing, and let AI do the synthesis on demand.

The folder is the product. The Markdown is the API. The AI is the interface.

---

## 📄 License

MIT
