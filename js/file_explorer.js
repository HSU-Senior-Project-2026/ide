export const FileManager = {
    tree: [], 
    activeFileId: null,

    activeFolderId: null,

    init(callbacks) {
        this.callbacks = callbacks || {};
        this.loadWorkspace();
        this.render();
        this.setupListeners();
    },

    loadWorkspace() {
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
        
        if (!this.tree) {
            this.tree = [];
        }

        // Find first file to set as active initially if none selected
        if (!this.activeFileId && this.tree.length > 0) {
            const firstFile = this.tree.find(n => n.type === "file");
            if (firstFile) this.activeFileId = firstFile.id;
        }
    },

    saveWorkspace() {
        localStorage.setItem("judge0.workspace", JSON.stringify(this.tree));
    },

    getDefaultTree() {
        return [];
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

    createAndRenameFile() {
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

    createAndRenameFolder() {
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

    saveActiveFile(content) {
        const file = this.findFile(this.activeFileId, this.tree);
        if (file) {
            file.content = content;
            this.saveWorkspace();
        }
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

    openFile(id) {
        const file = this.findFile(id, this.tree);
        if (!file || file.type !== "file") return;

        this.activeFileId = id;

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
                            title: file.name,
                            isClosable: true,
                            componentState: {
                                readOnly: false,
                                fileId: id,
                                initialContent: file.content
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
            this.callbacks.onOpenFile(file.content, file.name);
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
        
        if (this.tree.length === 0) {
            container.innerHTML = '<div class="sidebar-placeholder">No files yet.<br>Use the <b>+</b> buttons above to create a file or folder.</div>';
            return;
        }

        const buildTreeHtml = (nodes, depth) => {
            nodes.sort((a, b) => {
                if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            nodes.forEach(node => {
                const el = document.createElement("div");
                let isSelectedFile = node.id === this.activeFileId;
                let isActiveFolder = node.id === this.activeFolderId;
                
                el.className = "tree-item" + 
                               (isSelectedFile ? " selected" : "") + 
                               (isActiveFolder && !isSelectedFile ? " active-folder" : "");
                el.style.paddingLeft = (8 + depth * 12) + "px";
                
                const arrowEl = document.createElement("div");
                arrowEl.className = "tree-item-arrow" + (node.type === "folder" ? (node.isOpen ? " open" : "") : " hidden");
                arrowEl.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                `;
                
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
                
                const renameEl = document.createElement("div");
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
                        const newName = inputEl.value;
                        if (newName && newName.trim() !== "" && newName !== node.name) {
                            node.name = newName.trim();
                            this.saveWorkspace();
                            if (this.callbacks.onRenameFile && node.id === this.activeFileId) {
                                this.callbacks.onRenameFile(node.name);
                            }
                        }
                        this.render();
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

                const deleteEl = document.createElement("div");
                deleteEl.className = "tree-item-action";
                deleteEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
                deleteEl.style.display = "none";
                deleteEl.style.paddingLeft = "4px";
                deleteEl.title = "Delete";

                deleteEl.onclick = (e) => {
                    e.stopPropagation();
                    const label = node.type === "folder" ? `folder "${node.name}" and all its contents` : `"${node.name}"`;
                    if (!confirm(`Delete ${label}?`)) return;
                    this.deleteNode(node.id);
                };

                el.onmouseenter = () => { renameEl.style.display = "block"; deleteEl.style.display = "block"; };
                el.onmouseleave = () => { renameEl.style.display = "none"; deleteEl.style.display = "none"; };
                
                el.appendChild(arrowEl);
                el.appendChild(iconEl);
                el.appendChild(nameEl);
                el.appendChild(renameEl);
                el.appendChild(deleteEl);
                
                if (this.pendingRenameFileId === node.id) {
                    this.pendingRenameFileId = null;
                    setTimeout(() => renameEl.onclick(new Event('click')), 10);
                }

                el.onclick = (e) => {
                    e.stopPropagation();
                    if (node.type === "folder") {
                        node.isOpen = !node.isOpen;
                        this.activeFolderId = node.id;
                        this.saveWorkspace();
                        this.render();
                    } else {
                        // Inherit active folder from its parent if clicking a file
                        this.activeFolderId = this.findParentFolderId(node.id, this.tree);
                        this.openFile(node.id);
                        this.render(); // force re-render to update the active selected visual state
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
                this.loadWorkspace();
                this.render();
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
