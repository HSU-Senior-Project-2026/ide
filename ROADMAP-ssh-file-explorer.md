# SSH File Explorer — Roadmap

## Goal
Replace the local-only (localStorage) file tree with a **live SSH file explorer** that browses the student's home directory on `csci.hsutx.edu` once they are logged in. No files should be displayed if the student is not logged in. Files and folders render in the sidebar just like VS Code, with `..` navigation, lazy loading, and permission guards.

---

## Current State

| Layer | What exists | Where |
|-------|------------|-------|
| **Server** | `POST /ssh-ls` — lists a directory, `POST /ssh-read` — reads a file, `POST /ssh-write` — writes a file | `js/ssh-bridge.js` |
| **Frontend** | `FileManager` — renders a tree from an in-memory `tree[]`, supports open/create/rename/delete, persists to `localStorage` | `js/file_explorer.js` |
| **Auth** | SSH sign-in via `csci.js`, session held in `sshSession` variable on the server | `js/csci.js`, `js/ssh-bridge.js` |

The `/ssh-ls` endpoint already exists but is never called by the file explorer. The sidebar currently only knows about files the user created locally.

---

## Architecture

```
  Browser (file_explorer.js)          Express Server (ssh-bridge.js)         CSCI SSH
  ─────────────────────────           ──────────────────────────────         ────────
  User clicks folder                                                         
    │                                                                        
    ├─► POST /ssh-ls {path}  ──────►  sshExec(`ls -1aF ...`)  ──────────►  ls -1aF /path
    │                                                                        │
    │◄── { entries[] }  ◄──────────  parse output  ◄─────────────────────────┘
    │                                                                        
    ├─► render entries in sidebar                                            
    │                                                                        
  User clicks file                                                           
    │                                                                        
    ├─► POST /ssh-read {path}  ────►  sshExec(`cat ...`)  ──────────────►  cat /path/file
    │                                                                        │
    │◄── { content }  ◄────────────  return content  ◄───────────────────────┘
    │                                                                        
    ├─► open in Monaco editor tab                                            
```

---

## Steps

### Step 1 — Server: Permission & Path Safety

**File:** `js/ssh-bridge.js`

- Add a **path validation** helper that:
  - Resolves `..` segments and normalizes the path
  - Determines the user's home directory on first sign-in (run `echo $HOME` via SSH, cache the result)
  - Blocks any path that resolves **above** the user's home directory (return 403)
- Update `/ssh-ls`:
  - **Keep** `..` entries in the output (currently filtered out) — the frontend needs them for navigation
  - Add an `isHome` boolean to the response so the frontend knows when to hide `..`
  - Call the path validation helper before executing
- Add a `/ssh-stat` endpoint (or extend `/ssh-ls`) that returns **permissions** for each entry:
  - Run `ls -laF` instead of `ls -1aF`, parse the permission string (e.g. `drwxr-x---`)
  - Include a `readable` and `writable` boolean per entry based on the permission bits and the current user
- Update `/ssh-read` and `/ssh-write` to call the path validation helper

### Step 2 — Frontend: Dual-Mode FileManager

**File:** `js/file_explorer.js`

The FileManager currently operates on an in-memory `tree[]`. We need two modes:

| Mode | When | Data source |
|------|------|-------------|
| **Local** | Not signed in | `localStorage` (current behavior, untouched) |
| **SSH** | Signed in | Live SSH calls to `/ssh-ls`, `/ssh-read`, `/ssh-write` |

- Add a `mode` property: `"local"` or `"ssh"`
- Add a `currentPath` property (SSH mode only): tracks the directory being viewed (starts at `~`)
- Switch mode to `"ssh"` on sign-in, back to `"local"` on sign-out
- In SSH mode:
  - `loadWorkspace()` calls `POST /ssh-ls { path: currentPath }` and converts the response into the `tree[]` format
  - Folders are **not** pre-expanded — they lazy-load children on click via another `/ssh-ls` call
  - `..` appears as the first entry when not at the home directory

### Step 3 — Frontend: Render SSH Tree

**File:** `js/file_explorer.js`

- Update `render()` to handle SSH entries:
  - Show a `..` row at the top (styled distinctly, e.g. dimmed) when `currentPath !== homeDir`
  - Clicking `..` sets `currentPath` to the parent and re-fetches
  - Folders show a loading spinner while fetching children
  - **Permission indicators**: files/folders the user cannot read get a lock icon and are non-clickable; files the user cannot write get a subtle read-only badge
- Update `openFile()` for SSH mode:
  - Calls `POST /ssh-read { path }` to fetch content
  - Opens content in a Monaco tab (same as today)
  - Marks the tab as read-only if the file is not writable

### Step 4 — Frontend: Save-Back to Server

**File:** `js/file_explorer.js`, `js/ide.js`

- In SSH mode, saving a file (`Cmd/Ctrl+S` or autosave) calls `POST /ssh-write { path, content }` instead of writing to localStorage
- Show a brief status indicator ("Saved to server" / "Save failed") in the status bar
- Only allow save if the file was writable (check the permission flag from Step 1)

### Step 5 — Frontend: Create / Rename / Delete on Server

**File:** `js/file_explorer.js`, `js/ssh-bridge.js`

- Add server endpoints:
  - `POST /ssh-mkdir { path }` — create a directory
  - `POST /ssh-mv { from, to }` — rename/move a file or folder
  - `POST /ssh-rm { path }` — delete a file or empty folder
- Wire the sidebar buttons (New File, New Folder, Rename, Delete) to these endpoints in SSH mode
- All endpoints call the path validation helper from Step 1
- Delete should **not** allow recursive folder deletion (too dangerous) — only empty folders or single files

### Step 6 — Refresh & Error Handling

**File:** `js/file_explorer.js`

- The **Refresh** button in the sidebar header re-fetches `currentPath` from the server
- Handle SSH disconnects gracefully:
  - If any `/ssh-*` call returns `"Not signed in"`, switch back to local mode and show a notification
  - Show inline error messages in the sidebar if a directory fails to load (e.g. "Permission denied")
- Handle large directories: if `/ssh-ls` returns > 500 entries, show a warning and truncate

---

## Permission Model

```
Home directory:  /home/jaguayev
                     │
                     ├── hw1/           ← owned by student, full access
                     ├── hw2/           ← owned by student, full access  
                     ├── .bashrc        ← owned by student, full access
                     ├── .judge0-settings.json  ← our settings file
                     │
Parent dirs:     /home/              ← readable but not writable
                 /                   ← BLOCKED (above home, never reached)
```

**Rules:**
1. The user can **never navigate above their home directory** — server enforces this
2. Files/folders owned by others or without read permission show a lock icon and cannot be opened
3. Files without write permission can be opened read-only (badge on tab)
4. The server validates every path against the home directory before executing any command

---

## Files Changed

| File | Changes |
|------|---------|
| `js/ssh-bridge.js` | Path validation, `..` in `/ssh-ls`, permissions in response, new endpoints (`/ssh-mkdir`, `/ssh-mv`, `/ssh-rm`) |
| `js/file_explorer.js` | Dual-mode (local/SSH), lazy folder loading, `..` navigation, permission rendering, server save/create/rename/delete |
| `js/csci.js` | Trigger mode switch on sign-in/sign-out |
| `js/ide.js` | SSH-mode save handler, read-only tab support |
| `css/ide.css` | Lock icon styles, loading spinner, `..` row styling, read-only badge |

---

## Out of Scope (for now)

- Drag-and-drop file reordering
- File upload from local disk to SSH server
- Multi-file selection
- Search across SSH files
- Symlink handling (treated as regular files/folders)
