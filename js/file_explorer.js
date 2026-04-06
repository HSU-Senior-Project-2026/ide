export const FileManager = {
    tree: [],
    activeFileId: null,

    activeFolderId: null,

    // Dual-mode: "local" (localStorage) or "ssh" (live SSH calls)
    mode: "local",
    // SSH mode: the absolute path currently being viewed
    currentPath: null,
    // SSH mode: whether currentPath is the user's home directory
    isHome: true,
    // SSH mode: true while an /ssh-ls request is in flight
    loading: false,

    init(callbacks) {
        this.callbacks = callbacks || {};
        this.loadWorkspace();
        this.render();
        this.setupListeners();
    },

    // Switch to SSH mode — called from csci.js on successful sign-in
    async enterSSHMode() {
        this.mode = "ssh";
        this.currentPath = "~";
        this.tree = [];
        this.activeFileId = null;
        this.activeFolderId = null;
        await this.loadWorkspace();
        this.render();
    },

    // Switch back to local mode — called from csci.js on sign-out
    exitSSHMode() {
        this.mode = "local";
        this.currentPath = null;
        this.isHome = true;
        this.loading = false;
        this.loadWorkspace();
        this.render();
    },

    async loadWorkspace() {
        if (this.mode === "ssh") {
            await this.loadSSHDirectory(this.currentPath || "~");
            return;
        }

        // Local mode: load from localStorage
        const data = localStorage.getItem("judge0.workspace");
        if (data) {
            try {
                this.tree = JSON.parse(data);
            } catch(e) {
                this.tree = this.getDefaultTree();
            }
        } else {
            this.tree = this.getDefaultTree();
        }

        if (!this.tree || this.tree.length === 0) {
            this.tree = this.getDefaultTree();
        }

        // Find first file to set as active initially if none selected
        if (!this.activeFileId && this.tree.length > 0) {
            const firstFile = this.tree.find(n => n.type === "file");
            if (firstFile) this.activeFileId = firstFile.id;
        }
    },

    // Fetch a directory listing from the SSH server and populate the tree
    async loadSSHDirectory(dirPath) {
        this.loading = true;
        this.sshError = null;
        this.render();

        try {
            const resp = await fetch("/ssh-ls", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: dirPath })
            });
            const data = await resp.json();

            if (!data.success) {
                if (this.handleSSHDisconnect(data.error)) return;

                console.error("[SSH-LS]", data.error);
                this.sshError = data.error;
                this.tree = [];
                this.loading = false;
                this.render();
                return;
            }

            this.currentPath = data.path;
            this.isHome = data.isHome;

            let entries = data.entries;

            // Warn and truncate large directories
            const MAX_ENTRIES = 500;
            if (entries.length > MAX_ENTRIES) {
                this.sshError = `Directory has ${entries.length} entries — showing first ${MAX_ENTRIES}`;
                entries = entries.slice(0, MAX_ENTRIES);
            }

            // Convert entries into the tree format the renderer expects
            this.tree = entries.map(entry => ({
                id: this.generateId(),
                name: entry.name,
                type: entry.type === "directory" ? "folder" : "file",
                // SSH-specific metadata
                sshPath: entry.name === ".."
                    ? this.parentPath(data.path)
                    : data.path + "/" + entry.name,
                readable: entry.readable,
                writable: entry.writable,
                // Folders start collapsed; children load lazily on click
                ...(entry.type === "directory" && entry.name !== ".." ? { isOpen: false, children: null } : {})
            }));
        } catch (err) {
            console.error("[SSH-LS FETCH]", err);
            this.sshError = "Connection error — could not load directory";
            this.tree = [];
        }

        this.loading = false;
        this.render();
    },

    // Check if an error indicates the SSH session is gone; if so, switch back to local mode.
    // Returns true if a disconnect was detected (caller should stop processing).
    handleSSHDisconnect(errorMsg) {
        const disconnectPhrases = ["No active SSH session", "Not signed in"];
        if (disconnectPhrases.some(p => errorMsg && errorMsg.includes(p))) {
            this.exitSSHMode();
            this.showSaveStatus("SSH session lost — switched to local mode", "error");
            return true;
        }
        return false;
    },

    // Compute the parent path (go up one directory)
    parentPath(p) {
        const parts = p.split("/");
        parts.pop();
        return parts.join("/") || "/";
    },

    saveWorkspace() {
        if (this.mode === "ssh") return; // SSH mode doesn't use localStorage
        localStorage.setItem("judge0.workspace", JSON.stringify(this.tree));
    },

    getDefaultTree() {
        return [{
            id: this.generateId(),
            name: "Main.java",
            type: "file",
            content: "public class Main {\n    public static void main(String[] args) {\n        System.out.println(\"Hello, World!\");\n    }\n}\n"
        }];
    },

    generateId() {
        return 'file-' + Math.random().toString(36).substr(2, 9);
    },

    createFile(name) {
        const newNode = {
            id: this.generateId(),
            name: name,
            type: "file",
            content: ""
        };
        
        let targetList = this.tree;
        if (this.activeFolderId) {
            const folder = this.findFile(this.activeFolderId, this.tree);
            if (folder && folder.type === "folder") {
                if (!folder.children) folder.children = [];
                targetList = folder.children;
                folder.isOpen = true; // Make sure the folder opens when a file is created inside it
            }
        }
        
        targetList.push(newNode);
        this.saveWorkspace();
        this.openFile(newNode.id);
    },

    async createAndRenameFile() {
        if (this.mode === "ssh") {
            await this.sshCreateFile();
            return;
        }

        let baseName = "untitled";
        let counter = "";
        let name = baseName;

        let checkExists = (n, nodes) => nodes.some(f => f.name === n || (f.children && checkExists(n, f.children)));

        while (checkExists(name, this.tree)) {
            counter = (counter === "") ? 1 : counter + 1;
            name = `${baseName} ${counter}`;
        }

        const newId = this.generateId();
        const newNode = {
            id: newId,
            name: name,
            type: "file",
            content: ""
        };

        let targetList = this.tree;
        if (this.activeFolderId) {
            const folder = this.findFile(this.activeFolderId, this.tree);
            if (folder && folder.type === "folder") {
                if (!folder.children) folder.children = [];
                targetList = folder.children;
                folder.isOpen = true;
            }
        }

        targetList.push(newNode);
        this.saveWorkspace();
        this.openFile(newId);

        this.pendingRenameFileId = newId;
        this.render();
    },

    async createAndRenameFolder() {
        if (this.mode === "ssh") {
            await this.sshCreateFolder();
            return;
        }

        let baseName = "untitled folder";
        let counter = "";
        let name = baseName;

        let checkExists = (n, nodes) => nodes.some(f => f.name === n || (f.children && checkExists(n, f.children)));

        while (checkExists(name, this.tree)) {
            counter = (counter === "") ? 1 : counter + 1;
            name = `${baseName} ${counter}`;
        }

        const newId = this.generateId();
        const newNode = {
            id: newId,
            name: name,
            type: "folder",
            isOpen: true,
            children: []
        };

        let targetList = this.tree;
        if (this.activeFolderId) {
            const folder = this.findFile(this.activeFolderId, this.tree);
            if (folder && folder.type === "folder") {
                if (!folder.children) folder.children = [];
                targetList = folder.children;
                folder.isOpen = true;
            }
        }

        targetList.push(newNode);
        this.activeFolderId = newId; // instantly select the newly created folder
        this.saveWorkspace();

        this.pendingRenameFileId = newId;
        this.render();
    },

    // SSH: create a new empty file in the current directory
    async sshCreateFile() {
        let name = prompt("New file name:");
        if (!name || !name.trim()) return;
        name = name.trim();

        const filePath = this.currentPath + "/" + name;
        try {
            const resp = await fetch("/ssh-write", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: filePath, content: "" })
            });
            const data = await resp.json();
            if (!data.success) {
                if (this.handleSSHDisconnect(data.error)) return;
                alert("Failed to create file: " + data.error);
                return;
            }
        } catch (err) {
            alert("Failed to create file — connection error");
            return;
        }
        await this.loadSSHDirectory(this.currentPath);
    },

    // SSH: create a new directory in the current directory
    async sshCreateFolder() {
        let name = prompt("New folder name:");
        if (!name || !name.trim()) return;
        name = name.trim();

        const dirPath = this.currentPath + "/" + name;
        try {
            const resp = await fetch("/ssh-mkdir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: dirPath })
            });
            const data = await resp.json();
            if (!data.success) {
                if (this.handleSSHDisconnect(data.error)) return;
                alert("Failed to create folder: " + data.error);
                return;
            }
        } catch (err) {
            alert("Failed to create folder — connection error");
            return;
        }
        await this.loadSSHDirectory(this.currentPath);
    },

    // SSH: rename a file or folder
    async sshRename(node, newName) {
        if (!newName || newName === node.name) return;
        const parentDir = node.sshPath.substring(0, node.sshPath.lastIndexOf("/"));
        const newPath = parentDir + "/" + newName;

        try {
            const resp = await fetch("/ssh-mv", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ from: node.sshPath, to: newPath })
            });
            const data = await resp.json();
            if (!data.success) {
                if (this.handleSSHDisconnect(data.error)) return;
                alert("Rename failed: " + data.error);
                return;
            }
        } catch (err) {
            alert("Rename failed — connection error");
            return;
        }
        await this.loadSSHDirectory(this.currentPath);
    },

    // SSH: delete a file or empty folder
    async sshDelete(node) {
        const label = node.type === "folder"
            ? `empty folder "${node.name}"`
            : `"${node.name}"`;
        if (!confirm(`Delete ${label}?`)) return;

        try {
            const resp = await fetch("/ssh-rm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: node.sshPath })
            });
            const data = await resp.json();
            if (!data.success) {
                if (this.handleSSHDisconnect(data.error)) return;
                alert("Delete failed: " + data.error);
                return;
            }
        } catch (err) {
            alert("Delete failed — connection error");
            return;
        }
        await this.loadSSHDirectory(this.currentPath);
    },

    async saveActiveFile(content) {
        const file = this.findFile(this.activeFileId, this.tree);
        if (!file) return;

        file.content = content;

        if (this.mode === "ssh") {
            if (!file.writable) {
                this.showSaveStatus("Cannot save — file is read-only", "error");
                return;
            }
            try {
                const resp = await fetch("/ssh-write", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: file.sshPath, content })
                });
                const data = await resp.json();
                if (data.success) {
                    this.showSaveStatus("Saved to server", "success");
                } else {
                    if (this.handleSSHDisconnect(data.error)) return;
                    this.showSaveStatus("Save failed: " + data.error, "error");
                }
            } catch (err) {
                console.error("[SSH-WRITE FETCH]", err);
                this.showSaveStatus("Save failed — connection error", "error");
            }
            return;
        }

        this.saveWorkspace();
    },

    // Show a brief save status message in the status bar or as a floating indicator
    showSaveStatus(message, type) {
        // Look for an existing status bar element, or create a floating one
        let el = document.getElementById("ssh-save-status");
        if (!el) {
            el = document.createElement("div");
            el.id = "ssh-save-status";
            el.style.cssText = `
                position: fixed;
                bottom: 4px;
                right: 12px;
                z-index: 9999;
                font-size: 12px;
                padding: 3px 10px;
                border-radius: 3px;
                transition: opacity 0.4s ease;
                pointer-events: none;
            `;
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.style.opacity = "1";
        el.style.color = type === "error" ? "#f48771" : "#89d185";

        clearTimeout(this._saveStatusTimer);
        this._saveStatusTimer = setTimeout(() => {
            el.style.opacity = "0";
        }, 2500);
    },

    findFile(id, nodes) {
        for (let node of nodes) {
            if (node.id === id) return node;
            if (node.children) {
                const found = this.findFile(id, node.children);
                if (found) return found;
            }
        }
        return null;
    },

    async openFile(id) {
        const file = this.findFile(id, this.tree);
        if (!file || file.type !== "file") return;

        this.activeFileId = id;

        // In SSH mode, fetch file content from the server if not already loaded
        if (this.mode === "ssh" && file.sshPath && file.content === undefined) {
            try {
                const resp = await fetch("/ssh-read", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: file.sshPath })
                });
                const data = await resp.json();
                if (data.success) {
                    file.content = data.content;
                } else {
                    if (this.handleSSHDisconnect(data.error)) return;
                    console.error("[SSH-READ]", data.error);
                    file.content = `// Error reading file: ${data.error}`;
                }
            } catch (err) {
                console.error("[SSH-READ FETCH]", err);
                file.content = "// Error fetching file from server";
            }
        }

        const readOnly = this.mode === "ssh" && !file.writable;

        // Check if a tab for this file is already open in the sourceStack
        try {
            const { layout } = window.__ideModules || {};
            if (layout) {
                const stacks = layout.root.getItemsById("sourceStack");
                if (stacks.length > 0) {
                    const stack = stacks[0];

                    // Search existing tabs for this file ID
                    let existingTab = null;
                    for (let item of stack.contentItems) {
                        if (item.config && item.config.componentState && item.config.componentState.fileId === id) {
                            existingTab = item;
                            break;
                        }
                    }

                    if (existingTab) {
                        // Tab already exists — just activate it
                        stack.setActiveContentItem(existingTab);
                    } else {
                        // Create a new tab
                        stack.addChild({
                            type: "component",
                            componentName: "source",
                            title: file.name + (readOnly ? " 🔒" : ""),
                            isClosable: true,
                            componentState: {
                                readOnly: readOnly,
                                fileId: id,
                                initialContent: file.content || ""
                            }
                        });
                    }

                    this.render();
                    return;
                }
            }
        } catch (e) {
            console.warn("Tab open fallback:", e);
        }

        // Fallback: old single-editor approach
        if (this.callbacks.onOpenFile) {
            this.callbacks.onOpenFile(file.content || "", file.name);
        }
        this.render();
    },

    // Load initial code for ide.js setDefaults
    getInitialFileContent() {
        const file = this.findFile(this.activeFileId, this.tree) || this.tree.find(n => n.type === "file");
        if (file) {
            this.activeFileId = file.id;
            return { id: file.id, content: file.content, name: file.name };
        }
        return null;
    },

    render() {
        const container = document.getElementById("sidebar-tree");
        if (!container) return;
        container.innerHTML = "";

        // SSH mode: show loading spinner
        if (this.mode === "ssh" && this.loading) {
            container.innerHTML = '<div class="ssh-loading"><div class="ssh-spinner"></div>Loading…</div>';
            return;
        }

        // SSH mode: show inline error if directory failed to load
        if (this.mode === "ssh" && this.sshError) {
            const errEl = document.createElement("div");
            errEl.className = "ssh-error-banner";
            errEl.textContent = this.sshError;
            container.appendChild(errEl);
        }

        if (this.tree.length === 0 && !this.sshError) {
            const msg = this.mode === "ssh" ? "Empty directory" : "Empty workspace";
            container.innerHTML = `<div class="sidebar-placeholder">${msg}</div>`;
            return;
        }

        const buildTreeHtml = (nodes, depth) => {
            // In SSH mode the tree is flat (server returns a single level), so don't re-sort ".." — it's already first
            const sorted = [...nodes].sort((a, b) => {
                // Keep ".." pinned at the top
                if (a.name === "..") return -1;
                if (b.name === "..") return 1;
                if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            sorted.forEach(node => {
                const isSSH = this.mode === "ssh";
                const isParentDir = isSSH && node.name === "..";
                const isLocked = isSSH && node.name !== ".." && !node.readable;
                const isReadOnly = isSSH && node.type === "file" && node.readable && !node.writable;

                const el = document.createElement("div");
                let isSelectedFile = node.id === this.activeFileId;
                let isActiveFolder = node.id === this.activeFolderId;

                let cls = "tree-item";
                if (isSelectedFile) cls += " selected";
                else if (isActiveFolder) cls += " active-folder";
                if (isParentDir) cls += " ssh-parent-dir";
                if (isLocked) cls += " ssh-locked";
                el.className = cls;
                el.style.paddingLeft = (8 + depth * 12) + "px";

                const arrowEl = document.createElement("div");
                if (isParentDir) {
                    // Show a left-arrow for ".."
                    arrowEl.className = "tree-item-arrow";
                    arrowEl.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    `;
                } else {
                    arrowEl.className = "tree-item-arrow" + (node.type === "folder" ? (node.isOpen ? " open" : "") : " hidden");
                    arrowEl.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    `;
                }

                const iconEl = document.createElement("div");
                let iconClass = "file-default";
                if (node.type === "folder") {
                    iconClass = "folder";
                    iconEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
                } else {
                    let defaultSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;

                    if (node.name.endsWith(".java")) {
                        iconClass = "file-java";
                        iconEl.innerHTML = `<img src="https://cdn.simpleicons.org/openjdk/ED8B00" width="14" height="14" style="vertical-align: middle;">`;
                    } else if (node.name.endsWith(".py")) {
                        iconClass = "file-py";
                        iconEl.innerHTML = `<img src="https://cdn.simpleicons.org/python/3776ab" width="14" height="14" style="vertical-align: middle;">`;
                    } else if (node.name.endsWith(".c") || node.name.endsWith(".h")) {
                        iconClass = "file-c";
                        iconEl.innerHTML = `<img src="https://cdn.simpleicons.org/c/A8B9CC" width="14" height="14" style="vertical-align: middle;">`;
                    } else if (node.name.endsWith(".cpp") || node.name.endsWith(".hpp")) {
                        iconClass = "file-cpp";
                        iconEl.innerHTML = `<img src="https://cdn.simpleicons.org/cplusplus/00599c" width="14" height="14" style="vertical-align: middle;">`;
                    } else if (node.name.endsWith(".js")) {
                        iconClass = "file-js";
                        iconEl.innerHTML = `<img src="https://cdn.simpleicons.org/javascript/f7df1e" width="14" height="14" style="vertical-align: middle;">`;
                    } else {
                        iconEl.innerHTML = defaultSvg;
                    }
                }
                iconEl.className = "tree-item-icon " + iconClass;

                const nameEl = document.createElement("div");
                nameEl.className = "tree-item-name";
                nameEl.textContent = node.name;
                nameEl.style.flex = "1";
                nameEl.style.overflow = "hidden";
                nameEl.style.textOverflow = "ellipsis";

                // Lock icon for unreadable entries
                let lockEl = null;
                if (isLocked) {
                    lockEl = document.createElement("div");
                    lockEl.className = "ssh-lock-icon";
                    lockEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
                    lockEl.title = "No read permission";
                }

                // Read-only badge for readable but non-writable files
                let readOnlyBadge = null;
                if (isReadOnly) {
                    readOnlyBadge = document.createElement("span");
                    readOnlyBadge.className = "ssh-readonly-badge";
                    readOnlyBadge.textContent = "RO";
                    readOnlyBadge.title = "Read-only";
                }

                // Rename and delete buttons — shown for writable entries (both modes), hidden for ".." and locked entries
                let renameEl = null;
                let deleteEl = null;
                const showActions = isParentDir ? false : isLocked ? false : (isSSH ? node.writable : true);

                if (showActions) {
                    renameEl = document.createElement("div");
                    renameEl.className = "tree-item-action";
                    renameEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
                    renameEl.style.display = "none";
                    renameEl.style.marginLeft = "auto";
                    renameEl.style.paddingLeft = "4px";
                    renameEl.title = "Rename";

                    renameEl.onclick = (e) => {
                        e.stopPropagation();
                        const inputEl = document.createElement("input");
                        inputEl.type = "text";
                        inputEl.value = node.name;
                        inputEl.className = "tree-item-rename-input";
                        inputEl.style.flex = "1";
                        inputEl.style.minWidth = "0";
                        inputEl.style.background = "var(--input-bg, rgba(0,0,0,0.1))";
                        inputEl.style.border = "1px solid #0060c0";
                        inputEl.style.color = "inherit";
                        inputEl.style.outline = "none";
                        inputEl.style.padding = "0 2px";

                        const saveRename = () => {
                            const newName = inputEl.value.trim();
                            if (newName && newName !== node.name) {
                                if (isSSH) {
                                    this.sshRename(node, newName);
                                } else {
                                    node.name = newName;
                                    this.saveWorkspace();
                                    if (this.callbacks.onRenameFile && node.id === this.activeFileId) {
                                        this.callbacks.onRenameFile(node.name);
                                    }
                                    this.render();
                                }
                            } else {
                                this.render();
                            }
                        };

                        inputEl.onblur = saveRename;
                        inputEl.onkeydown = (e) => {
                            if (e.key === "Enter") {
                                inputEl.blur();
                            } else if (e.key === "Escape") {
                                inputEl.value = node.name;
                                inputEl.blur();
                            }
                        };

                        renameEl.style.display = "none";
                        deleteEl.style.display = "none";
                        el.onmouseenter = null;
                        el.onmouseleave = null;

                        el.replaceChild(inputEl, nameEl);
                        inputEl.focus();

                        let dotIndex = node.name.lastIndexOf('.');
                        if (dotIndex > 0 && node.type === "file") {
                            inputEl.setSelectionRange(0, dotIndex);
                        } else {
                            inputEl.select();
                        }
                    };

                    deleteEl = document.createElement("div");
                    deleteEl.className = "tree-item-action";
                    deleteEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
                    deleteEl.style.display = "none";
                    deleteEl.style.paddingLeft = "4px";
                    deleteEl.title = "Delete";

                    deleteEl.onclick = (e) => {
                        e.stopPropagation();
                        if (isSSH) {
                            this.sshDelete(node);
                        } else {
                            const label = node.type === "folder" ? `folder "${node.name}" and all its contents` : `"${node.name}"`;
                            if (!confirm(`Delete ${label}?`)) return;
                            this.deleteNode(node.id);
                        }
                    };

                    el.onmouseenter = () => { renameEl.style.display = "block"; deleteEl.style.display = "block"; };
                    el.onmouseleave = () => { renameEl.style.display = "none"; deleteEl.style.display = "none"; };
                }

                el.appendChild(arrowEl);
                el.appendChild(iconEl);
                el.appendChild(nameEl);
                if (lockEl) el.appendChild(lockEl);
                if (readOnlyBadge) el.appendChild(readOnlyBadge);
                if (renameEl) el.appendChild(renameEl);
                if (deleteEl) el.appendChild(deleteEl);

                if (this.pendingRenameFileId === node.id && renameEl) {
                    this.pendingRenameFileId = null;
                    setTimeout(() => renameEl.onclick(new Event('click')), 10);
                }

                el.onclick = (e) => {
                    e.stopPropagation();

                    // SSH mode: ".." navigates up, folders navigate into, files open
                    if (this.mode === "ssh") {
                        if (node.name === "..") {
                            this.loadSSHDirectory(node.sshPath);
                            return;
                        }
                        if (node.type === "folder") {
                            if (!node.readable) return;
                            this.loadSSHDirectory(node.sshPath);
                            return;
                        }
                        if (!node.readable) return;
                        this.openFile(node.id);
                        this.render();
                        return;
                    }

                    // Local mode (unchanged)
                    if (node.type === "folder") {
                        node.isOpen = !node.isOpen;
                        this.activeFolderId = node.id;
                        this.saveWorkspace();
                        this.render();
                    } else {
                        this.activeFolderId = this.findParentFolderId(node.id, this.tree);
                        this.openFile(node.id);
                        this.render();
                    }
                };

                container.appendChild(el);

                if (node.type === "folder" && node.isOpen && node.children) {
                    buildTreeHtml(node.children, depth + 1);
                }
            });
        };

        buildTreeHtml(this.tree, 0);
    },
    
    setupListeners() {
        const refreshBtn = document.getElementById("sidebar-refresh");
        if (refreshBtn) {
            refreshBtn.onclick = () => {
                if (this.mode === "ssh") {
                    this.loadSSHDirectory(this.currentPath || "~");
                } else {
                    this.loadWorkspace();
                    this.render();
                }
            };
        }
        
        const collapseBtn = document.getElementById("sidebar-collapse");
        if (collapseBtn) {
            collapseBtn.onclick = () => {
                const collapseAll = (nodes) => {
                    nodes.forEach(n => {
                        if (n.type === "folder") {
                            n.isOpen = false;
                            if (n.children) collapseAll(n.children);
                        }
                    });
                };
                collapseAll(this.tree);
                this.saveWorkspace();
                this.render();
            };
        }
    },

    findParentFolderId(id, nodes, parentId = null) {
        for (let node of nodes) {
            if (node.id === id) return parentId;
            if (node.children) {
                const found = this.findParentFolderId(id, node.children, node.id);
                if (found) return found;
            }
        }
        return null;
    },

    // Collect all file IDs inside a node (recursively for folders)
    collectFileIds(node) {
        let ids = [];
        if (node.type === "file") {
            ids.push(node.id);
        }
        if (node.children) {
            node.children.forEach(child => {
                ids = ids.concat(this.collectFileIds(child));
            });
        }
        return ids;
    },

    deleteNode(id) {
        const node = this.findFile(id, this.tree);
        if (!node) return;

        // Collect all file IDs that will be removed (for closing tabs)
        const fileIdsToClose = this.collectFileIds(node);

        // Remove node from tree
        const removeFromList = (nodes) => {
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].id === id) {
                    nodes.splice(i, 1);
                    return true;
                }
                if (nodes[i].children && removeFromList(nodes[i].children)) {
                    return true;
                }
            }
            return false;
        };
        removeFromList(this.tree);
        this.saveWorkspace();

        // Close open tabs for deleted files in Golden Layout
        try {
            const { layout } = window.__ideModules || {};
            if (layout) {
                const stacks = layout.root.getItemsById("sourceStack");
                if (stacks.length > 0) {
                    const stack = stacks[0];
                    // Iterate in reverse since we're removing items
                    for (let i = stack.contentItems.length - 1; i >= 0; i--) {
                        const item = stack.contentItems[i];
                        const itemFileId = item.config && item.config.componentState && item.config.componentState.fileId;
                        if (itemFileId && fileIdsToClose.includes(itemFileId)) {
                            item.remove();
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("Tab close on delete:", e);
        }

        // If the deleted node was the active file, switch to the first remaining file
        if (fileIdsToClose.includes(this.activeFileId)) {
            const firstFile = this.findFirstFile(this.tree);
            if (firstFile) {
                this.openFile(firstFile.id);
            } else {
                this.activeFileId = null;
            }
        }

        // Clear active folder if it was deleted
        if (this.activeFolderId === id) {
            this.activeFolderId = null;
        }

        this.render();
    },

    findFirstFile(nodes) {
        for (let node of nodes) {
            if (node.type === "file") return node;
            if (node.children) {
                const found = this.findFirstFile(node.children);
                if (found) return found;
            }
        }
        return null;
    }
};
