export const FileManager = {
    tree: [], 
    activeFileId: null,

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
        
        if (!this.tree || this.tree.length === 0) {
            this.tree = this.getDefaultTree();
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
        const ext = name.split('.').pop() || "txt";
        let defaultContent = "";
        
        // basic class template for java
        if (ext === "java") {
            const className = name.split('.')[0];
            defaultContent = `public class ${className} {\n    public static void main(String[] args) {\n        \n    }\n}\n`;
        } else if (ext === "c") {
            defaultContent = `#include <stdio.h>\n\nint main() {\n    return 0;\n}\n`;
        }

        const newNode = {
            id: this.generateId(),
            name: name,
            type: "file",
            content: defaultContent
        };
        this.tree.push(newNode);
        this.saveWorkspace();
        this.openFile(newNode.id);
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
        if (file) {
            this.activeFileId = id;
            if (this.callbacks.onOpenFile) {
                this.callbacks.onOpenFile(file.content, file.name);
            }
            this.render();
        }
    },

    // Load initial code for ide.js setDefaults
    getInitialFileContent() {
        const file = this.findFile(this.activeFileId, this.tree) || this.tree.find(n => n.type === "file");
        if (file) {
            this.activeFileId = file.id;
            return { content: file.content, name: file.name };
        }
        return null;
    },

    render() {
        const container = document.getElementById("sidebar-tree");
        if (!container) return;
        container.innerHTML = "";
        
        if (this.tree.length === 0) {
            container.innerHTML = '<div class="sidebar-placeholder">Empty workspace</div>';
            return;
        }

        const buildTreeHtml = (nodes, depth) => {
            nodes.sort((a, b) => {
                if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            nodes.forEach(node => {
                const el = document.createElement("div");
                el.className = "tree-item" + (node.id === this.activeFileId ? " selected" : "");
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
                    if (node.name.endsWith(".java")) iconClass = "file-java";
                    else if (node.name.endsWith(".py")) iconClass = "file-py";
                    else if (node.name.endsWith(".c") || node.name.endsWith(".cpp") || node.name.endsWith(".h")) iconClass = "file-c";
                    else if (node.name.endsWith(".js")) iconClass = "file-js";
                    
                    iconEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
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
                    const newName = prompt("Enter new name:", node.name);
                    if (newName && newName.trim() !== "" && newName !== node.name) {
                        node.name = newName.trim();
                        this.saveWorkspace();
                        this.render();
                        if (this.callbacks.onRenameFile && node.id === this.activeFileId) {
                            this.callbacks.onRenameFile(node.name);
                        }
                    }
                };

                el.onmouseenter = () => renameEl.style.display = "block";
                el.onmouseleave = () => renameEl.style.display = "none";
                
                el.appendChild(arrowEl);
                el.appendChild(iconEl);
                el.appendChild(nameEl);
                el.appendChild(renameEl);
                
                el.onclick = (e) => {
                    e.stopPropagation();
                    if (node.type === "folder") {
                        node.isOpen = !node.isOpen;
                        this.saveWorkspace();
                        this.render();
                    } else {
                        this.openFile(node.id);
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
    }
};
