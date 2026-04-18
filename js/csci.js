
//--------------------------------------------------

/*// Allow Ctrl+S / Cmd+S to save the currently open file.
document.addEventListener("keydown", (event) => {
  console.log("keydown detected:", event.key, "ctrl:", event.ctrlKey, "meta:", event.metaKey);

  const isSaveShortcut =
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s";

  if (isSaveShortcut) {
    console.log("Save shortcut detected");
    event.preventDefault();

    if (typeof window.saveCurrentFile === "function") {
      console.log("Calling saveCurrentFile()");
      window.saveCurrentFile();
    } else {
      console.error("saveCurrentFile is not available.");
    }
  }
});*/

// Show a brief slide-in notification in the top-right corner
function showNotification(message, type) {
  // type is "success", "error", or "warning" — maps to Semantic UI message colors
  const colorClass = type === "success" ? "green" : type === "error" ? "red" : "yellow";

  const note = document.createElement("div");
  note.className = `ui ${colorClass} message`;
  note.style.cssText = `
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 9999;
    min-width: 250px;
    max-width: 360px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    transition: opacity 0.4s ease;
  `;
  note.innerText = message;
  document.body.appendChild(note);

  // Fade out and remove after 3 seconds
  setTimeout(() => {
    note.style.opacity = "0";
    setTimeout(() => note.remove(), 400);
  }, 3000);
}

// ===== Sign-in modal helpers =====

function showSignInModal() {
  clearSignInError();
  $('#judge0-csci-sign-in-modal')
    .modal({ closable: false }).modal('show');
}

function hideSignInModal() {
  $('#judge0-csci-sign-in-modal').modal('hide');
}

// Sets the shared signed-in state across ide.js + csci.js and updates the nav UI.
function applySignedInUI(username, token) {
  window.csciSessionToken = token;
  window.sshToken = token;

  var displayName = (username || "").split("@")[0] || "User";
  document.getElementById("judge0-account-label").textContent = displayName;
  document.getElementById("judge0-csci-sign-in-btn").style.display = "none";
  document.getElementById("judge0-csci-sign-out-btn").style.display = "";

  window.dispatchEvent(new Event("csci-signed-in"));
}

// Show / clear the error message inside the sign-in modal.
function showSignInError(msg) {
  var el = document.getElementById("sign-in-error-msg");
  if (el) {
    el.textContent = msg;
    el.style.display = "";
  }
}

function clearSignInError() {
  var el = document.getElementById("sign-in-error-msg");
  if (el) {
    el.textContent = "";
    el.style.display = "none";
  }
  stopLockoutCountdown();
}

// Countdown timer shown in the modal when the user is locked out.
var _lockoutInterval = null;

function startLockoutCountdown(remainMs) {
  stopLockoutCountdown();

  var endTime = Date.now() + remainMs;
  var btn = document.getElementById("judge0-csci-modal-sign-in-btn");
  var timerEl = document.getElementById("sign-in-lockout-timer");

  if (btn) btn.classList.add("disabled");

  function tick() {
    var left = Math.max(0, endTime - Date.now());
    if (left <= 0) {
      stopLockoutCountdown();
      return;
    }
    var m = Math.floor(left / 60000);
    var s = Math.ceil((left % 60000) / 1000);
    if (s === 60) { m += 1; s = 0; }
    var display = m + ":" + (s < 10 ? "0" : "") + s;
    if (timerEl) {
      timerEl.textContent = "Try again in " + display;
      timerEl.style.display = "";
    }
  }

  tick();
  _lockoutInterval = setInterval(tick, 1000);
}

function stopLockoutCountdown() {
  if (_lockoutInterval) {
    clearInterval(_lockoutInterval);
    _lockoutInterval = null;
  }
  var btn = document.getElementById("judge0-csci-modal-sign-in-btn");
  if (btn) btn.classList.remove("disabled");
  var timerEl = document.getElementById("sign-in-lockout-timer");
  if (timerEl) { timerEl.textContent = ""; timerEl.style.display = "none"; }
}

// Try to restore a previous session from sessionStorage (survives page refresh).
async function tryRestoreSession() {
  var token, username;
  try {
    token = sessionStorage.getItem("csci.token");
    username = sessionStorage.getItem("csci.username");
  } catch (_) {}

  if (!token || !username) return false;

  try {
    var response = await fetch("/ssh-validate-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token })
    });
    var result = await response.json();
    if (result.success) {
      applySignedInUI(result.username || username, token);
      loadFileExplorer("~");
      return true;
    }
  } catch (err) {
    console.warn("Session restore failed:", err);
  }

  // Token expired or invalid — clear storage
  try {
    sessionStorage.removeItem("csci.token");
    sessionStorage.removeItem("csci.username");
  } catch (_) {}
  return false;
}

async function signIn(e) {
  if (e) e.preventDefault();

  const usernameInput = document.getElementById("modal_username");
  const passwordInput = document.getElementById("modal_password");
  const username = usernameInput.value;
  const password = passwordInput.value;

  const $signInBtn = $("#judge0-csci-modal-sign-in-btn");
  $signInBtn.addClass("loading disabled");

  try {
    const response = await fetch("/ssh-sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();

    if (result.success) {
      passwordInput.value = "";
      $('#judge0-csci-sign-in-modal').modal('hide');
      clearSignInError();
      showNotification(`Connected to CSCI server as ${username}`, "success");

      applySignedInUI(username, result.token);

      // Persist session so a page reload doesn't force re-auth
      try {
        sessionStorage.setItem("csci.token", result.token);
        sessionStorage.setItem("csci.username", username);
      } catch (_) {}

      loadFileExplorer("~");

    } else {
      // Show attempts remaining / lockout info inside the modal
      let msg = result.error || "Login failed.";
      if (result.attemptsLeft !== undefined && result.attemptsLeft > 0) {
        msg += ` (${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? "" : "s"} remaining)`;
      }
      if (result.retryAfterMs) {
        startLockoutCountdown(result.retryAfterMs);
      }
      showSignInError(msg);
    }
  } catch (err) {
    console.error("Fetch error:", err);
    showNotification("Error connecting to server. See console for details.", "error");
  } finally {
    $signInBtn.removeClass("loading disabled");
  }
}

async function signOut() {
  const usernameInput = document.getElementById("modal_username");
  const passwordInput = document.getElementById("modal_password");

  try {
    const response = await fetch("/ssh-sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: window.csciSessionToken })
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = await response.json();
    console.log("Server response:", result);

    // Tell ide.js to tear down the persistent shell before clearing the token.
    window.dispatchEvent(new Event("csci-signed-out"));

    // Clear both token references — any subsequent run/file attempts will be rejected
    window.csciSessionToken = null;
    window.sshToken = null;
    showNotification("Disconnected from CSCI server.", "warning");

  } catch (err) {
    console.error("Error signing out:", err);
    showNotification("Error signing out. See console for details.", "error");
  } finally {
    if (usernameInput) usernameInput.value = "";
    if (passwordInput) passwordInput.value = "";
    // Reset account dropdown to signed-out state
    document.getElementById("judge0-account-label").textContent = "Account";
    document.getElementById("judge0-csci-sign-in-btn").style.display = "";
    document.getElementById("judge0-csci-sign-out-btn").style.display = "none";

    // Clear persisted session
    try {
      sessionStorage.removeItem("csci.token");
      sessionStorage.removeItem("csci.username");
    } catch (_) {}

    // Re-show the sign-in modal since nothing works without auth
    showSignInModal();
  }
}

// ===== Collapsible file tree (VS Code style) =====
// In-memory tree. Each node: { name, type, path, children: null|[], expanded }
// children === null means "not yet fetched"; [] means "fetched but empty".
window.explorerTree = null;

// Fetch one directory listing and convert to child nodes.
function entriesToNodes(entries, parentPath) {
  return entries
    .filter(e => e.name !== ".." && e.name !== ".")
    .map(e => ({
      name: e.name,
      type: e.type,
      path: parentPath + "/" + e.name,
      children: e.type === "directory" ? null : undefined,
      expanded: false
    }));
}

// Walk the tree to find a node by its absolute path.
function findNodeByPath(node, targetPath) {
  if (!node) return null;
  if (node.path === targetPath) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }
  return null;
}

// When reloading a folder that was already loaded, preserve the expanded
// state and loaded children of existing sub-folders.
function mergeChildren(oldChildren, newChildren) {
  if (!oldChildren) return newChildren;
  return newChildren.map(nc => {
    const old = oldChildren.find(oc => oc.name === nc.name && oc.type === nc.type);
    if (old && old.type === "directory" && old.children) {
      nc.children = old.children;
      nc.expanded = old.expanded;
    }
    return nc;
  });
}

// Load a directory and integrate the results into the in-memory tree.
// If path is "~" or matches the root, rebuilds from the top; otherwise
// reloads just the matching sub-folder.
async function loadFileExplorer(path = "~") {
  window.currentExplorerPath = path;
  if (!window.sshToken) return;

  try {
    const response = await fetch("/ssh-ls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: window.sshToken, path })
    });

    const result = await response.json();
    if (!result.success) {
      console.error("Failed to load files:", result.error);
      return;
    }

    const children = entriesToNodes(result.entries, result.path);

    if (!window.explorerTree || path === "~" || result.path === (window.explorerTree && window.explorerTree.path)) {
      // Root load or reload
      window.explorerTree = {
        name: "~",
        type: "directory",
        path: result.path,
        children: mergeChildren(window.explorerTree ? window.explorerTree.children : null, children),
        expanded: true
      };
    } else {
      // Reload a specific sub-folder
      const node = findNodeByPath(window.explorerTree, result.path);
      if (node) {
        node.children = mergeChildren(node.children, children);
        node.expanded = true;
      }
    }

    renderTreeExplorer();
  } catch (err) {
    console.error("Error loading file explorer:", err);
  }
}
window.loadFileExplorer = loadFileExplorer;

// Map file extension to an icon CSS class (mirrors the tree-item-icon.file-* rules)
function getFileIconClass(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "java": return "file-java";
    case "py":   return "file-py";
    case "c": case "h": return "file-c";
    case "cpp": case "cc": case "cxx": case "hpp": return "file-c";
    case "js":   return "file-js";
    case "txt": case "text": case "md": return "file-txt";
    default: return "file-default";
  }
}

// Lazy-load and toggle a folder node, then re-render the tree.
async function toggleFolder(node) {
  if (node.expanded) {
    node.expanded = false;
    renderTreeExplorer();
    return;
  }

  if (!node.children) {
    try {
      const response = await fetch("/ssh-ls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: window.sshToken, path: node.path })
      });
      const result = await response.json();
      if (!result.success) return;
      node.children = entriesToNodes(result.entries, result.path);
    } catch (err) {
      console.error("Error loading folder:", err);
      return;
    }
  }

  node.expanded = true;
  window.currentExplorerPath = node.path;
  renderTreeExplorer();
}

// Render a single tree node (file or folder) as a .tree-item row, and
// recursively render expanded children underneath.
function renderTreeNode(parentEl, node, depth) {
  const row = document.createElement("div");
  row.className = "tree-item";
  row.style.paddingLeft = (depth * 16 + 8) + "px";
  row.dataset.nodePath = node.path;

  // Chevron arrow (folders only; hidden placeholder for files to keep alignment)
  const arrow = document.createElement("span");
  arrow.className = "tree-item-arrow" + (node.type === "directory" ? (node.expanded ? " open" : "") : " hidden");
  arrow.textContent = "\u25B6"; // ▶
  row.appendChild(arrow);

  // Icon
  const icon = document.createElement("span");
  if (node.type === "directory") {
    icon.className = "tree-item-icon folder";
    icon.textContent = node.expanded ? "\uD83D\uDCC2" : "\uD83D\uDCC1"; // 📂 / 📁
  } else {
    icon.className = "tree-item-icon " + getFileIconClass(node.name);
    icon.textContent = "\uD83D\uDCC4"; // 📄
  }
  row.appendChild(icon);

  // Name
  const nameSpan = document.createElement("span");
  nameSpan.className = "tree-item-name";
  nameSpan.textContent = node.name;
  row.appendChild(nameSpan);

  // Hover actions (rename + delete)
  const actions = document.createElement("div");
  actions.className = "file-actions";

  const renameBtn = document.createElement("i");
  renameBtn.className = "edit icon rename-btn";
  renameBtn.title = "Rename";
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    beginTreeRename(node, nameSpan);
  });

  const deleteBtn = document.createElement("i");
  deleteBtn.className = "trash icon delete-btn";
  deleteBtn.title = "Delete";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
    deleteExplorerItem({ name: node.name, type: node.type }, parentPath);
  });

  actions.appendChild(renameBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(actions);

  // Click: expand/collapse folder, or open file
  row.addEventListener("click", () => {
    if (node.type === "directory") {
      toggleFolder(node);
    } else {
      // Highlight selection
      document.querySelectorAll("#file-explorer-list .tree-item.selected").forEach(el => el.classList.remove("selected"));
      row.classList.add("selected");
      openServerFile(node.path, node.name);
    }
  });

  parentEl.appendChild(row);

  // Expanded children
  if (node.type === "directory" && node.expanded && node.children) {
    const childContainer = document.createElement("div");
    childContainer.className = "tree-children open";
    node.children.forEach(child => renderTreeNode(childContainer, child, depth + 1));
    parentEl.appendChild(childContainer);
  }
}

// Full re-render of the tree from the in-memory model.
function renderTreeExplorer() {
  const container = document.getElementById("file-explorer-list");
  if (!container || !window.explorerTree) return;
  container.innerHTML = "";
  entries.sort((a, b) => {
  // folders first
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;

  if (!window.explorerTree.children || window.explorerTree.children.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "sidebar-placeholder";
    placeholder.textContent = "No files found";
    container.appendChild(placeholder);
    return;
  }

  window.explorerTree.children.forEach(node => renderTreeNode(container, node, 0));
}

// Inline rename: replace the name span's text with an editable input.
function beginTreeRename(node, nameSpan) {
  if (nameSpan.querySelector("input")) return;

  const oldName = node.name;

  const input = document.createElement("input");
  input.type = "text";
  input.value = oldName;
  input.className = "tree-rename-input";
  input.spellcheck = false;
  input.autocomplete = "off";

  nameSpan.textContent = "";
  nameSpan.appendChild(input);
  input.focus();
  const dot = oldName.lastIndexOf(".");
  if (dot > 0) input.setSelectionRange(0, dot);
  else input.select();

  let finished = false;

  async function submit() {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      nameSpan.textContent = oldName;
      return;
    }

    const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
    const oldPath = node.path;
    const newPath = parentPath + "/" + newName;

    try {
      const response = await fetch("/ssh-mv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: window.sshToken, from: oldPath, to: newPath })
      });
      const result = await response.json();
      if (!result.success) {
        nameSpan.textContent = oldName;
        console.error("Rename failed:", result.error);
        return;
      }

      node.name = newName;
      node.path = result.to || newPath;
      nameSpan.textContent = newName;

      if (typeof window.renameRemoteTabByPath === "function") {
        window.renameRemoteTabByPath(result.from || oldPath, result.to || newPath, newName);
      }
    } catch (err) {
      nameSpan.textContent = oldName;
      console.error("Error renaming:", err);
    }
  }

  function cancel() {
    if (finished) return;
    finished = true;
    nameSpan.textContent = oldName;
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => { if (!finished) submit(); }, 80);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

// Delete a file or empty folder from the Explorer
async function deleteExplorerItem(entry, currentPath) {
    if (!window.sshToken) {
        console.error("No SSH token found.");
        return;
    }

    const targetPath = `${currentPath}/${entry.name}`;
    const confirmed = confirm(`Delete ${entry.name}?`);

    if (!confirmed) return;

    try {
        const response = await fetch("/ssh-rm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: window.sshToken,
                path: targetPath
            })
        });

        const result = await response.json();
        console.log("Delete result:", result);

        if (!result.success) {
            console.error("Delete failed:", result.error);
            return;
        }

        // If a tab is open for the deleted file, close it.
        if (typeof window.closeRemoteTabByPath === "function") {
            window.closeRemoteTabByPath(result.path);
        }

        if (window.currentOpenFilePath === result.path) {
            window.currentOpenFilePath = null;
            window.currentOpenFileName = null;
            window.hasUnsavedChanges = false;

            if (typeof window.updateSourceTabTitle === "function") {
                window.updateSourceTabTitle();
            }
        }

        await loadFileExplorer(currentPath);
    } catch (err) {
        console.error("Error deleting item:", err);
    }
}

// Open a file from the server and load it into Monaco
// Open a file from the server and load its contents into the Monaco editor
async function openServerFile(filePath, fileName) {
  console.log("Opening file:", filePath);

  if (!window.sshToken) {
    console.error("No SSH token found.");
    return;
  }

  try {
    const response = await fetch("/ssh-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: window.sshToken,
        path: filePath
      })
    });

    const result = await response.json();
    console.log("ssh-read result:", result);

    if (!result.success) {
      console.error("Failed to read file:", result.error);
      return;
    }

    // Make sure the Monaco editor exists
    if (!window.sourceEditor) {
      console.error("Editor not initialized.");
      return;
    }

    // Open (or focus) a dedicated Golden Layout tab for this file so multiple
    // files can stay open at once. openFileInTab handles deduping by path.
    if (typeof window.openFileInTab === "function") {
        window.openFileInTab(result.path, fileName, result.content);
    } else {
        window.openFile(result.content, fileName);
    }

    // Remember which file is currently open (used by the Save button).
    // The tab's "show" handler also sets these, but set them here in case
    // the tab is already focused and show() doesn't re-fire.
    window.currentOpenFilePath = result.path;
    window.currentOpenFileName = fileName;

    console.log("Current open file:", window.currentOpenFilePath);

  } catch (err) {
    console.error("Error opening file:", err);
  }
}

/*document.addEventListener("DOMContentLoaded", function () {
  document
    .getElementById("judge0-csci-sign-in-btn")
    .addEventListener("click", showSignInModal);

  // Pressing Enter in the login form should sign in
  document
    .getElementById("judge0-csci-sign-in-form")
    .addEventListener("submit", function (e) {
      e.preventDefault(); // prevent page reload / query params
      signIn(e);
    });

  document
    .getElementById("judge0-csci-modal-sign-in-btn")
    .addEventListener("click", signIn);

  document
    .getElementById("judge0-csci-modal-sign-in-cancel-btn")
    .addEventListener("click", hideSignInModal);

  document
    .getElementById("judge0-csci-sign-out-btn")
    .addEventListener("click", signOut);

  function beaconSignOut() {
    if (!window.csciSessionToken) return;

    try {
      const payload = new Blob(
        [JSON.stringify({ token: window.csciSessionToken })],
        { type: "application/json" }
      );
      navigator.sendBeacon("/ssh-sign-out", payload);
    } catch (err) {
      console.warn("sendBeacon sign-out failed:", err);
    }
  }

  window.addEventListener("pagehide", beaconSignOut);
  window.addEventListener("beforeunload", beaconSignOut);
});*/

document.addEventListener("DOMContentLoaded", async function () {
  document
    .getElementById("judge0-csci-sign-in-btn")
    .addEventListener("click", showSignInModal);

  const signInForm = document.getElementById("judge0-csci-sign-in-form");
  const signInBtn = document.getElementById("judge0-csci-modal-sign-in-btn");
  const signOutBtn = document.getElementById("judge0-csci-sign-out-btn");

  signInForm?.addEventListener("submit", function (e) {
    e.preventDefault();
    signIn(e);
  });

  signInForm?.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      signIn(e);
    }
  });

  signInBtn?.addEventListener("click", signIn);
  signOutBtn?.addEventListener("click", signOut);

  // Try to restore a session saved from before the reload.
  // If it works, skip the sign-in modal entirely.
  const restored = await tryRestoreSession();
  if (!restored) {
    showSignInModal();
  }
});


// Attach saveCurrentFile to the Save button in the UI
document.getElementById("save-file-btn")?.addEventListener("click", () => {
  if (typeof window.saveCurrentFile === "function") {
    window.saveCurrentFile();
  } else {
    console.error("saveCurrentFile is not available.");
  }
});

// Save the currently open file back to the server.
// Uses the active SSH session token and the file path stored
// when the user opened a file from the Explorer.
async function saveCurrentFile() {
  if (!window.sshToken) {
    console.error("No SSH token found.");
    return;
  }

  if (!window.currentOpenFilePath) {
    console.error("No file is currently open.");
    return;
  }

  if (!window.sourceEditor) {
    console.error("Editor not initialized.");
    return;
  }

  /*if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }*/

  if (window.isSaving) return;

  window.isSaving = true;
  window.updateSourceTabTitle();

  const content = window.sourceEditor.getValue();

  try {
    const response = await fetch("/ssh-write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: window.sshToken,
        path: window.currentOpenFilePath,
        content
      })
    });

    const result = await response.json();
    console.log("Save result:", result);

    if (!result.success) {
      console.error("Failed to save file:", result.error);
      return;
    }

    window.isSaving = false;
    window.hasUnsavedChanges = false;
    window.updateSourceTabTitle();

    console.log(`Saved file: ${window.currentOpenFilePath}`);
  } catch (err) {
    console.error("Error saving file:", err);
  } finally {
    window.isSaving = false;
    window.updateSourceTabTitle();
  }
}

window.saveCurrentFile = saveCurrentFile;

document.getElementById("sidebar-new-file")?.addEventListener("click", () => {
    if (!window.sshToken) {
        console.error("No SSH token found.");
        return;
    }
    showInlineNewItemInput("file");
});

document.getElementById("sidebar-new-folder")?.addEventListener("click", () => {
    if (!window.sshToken) {
        console.error("No SSH token found.");
        return;
    }

    showInlineNewItemInput("folder");
});

async function saveCurrentFileAs() {
  if (!window.sshToken) {
    console.error("No SSH token found.");
    return;
  }

  if (!window.sourceEditor) {
    console.error("Editor not initialized.");
    return;
  }

  const currentPath = window.currentOpenFilePath || "";
  const currentName = window.currentOpenFileName || "Main.java";
  const newFileName = prompt("Save file as:", currentName);

  if (!newFileName) return;

  const trimmedName = newFileName.trim();
  if (!trimmedName) return;

  const parentDir = window.currentOpenFilePath
  ? getParentDirectory(window.currentOpenFilePath)
  : window.currentDirectory || "";
  const newPath = parentDir ? `${parentDir}/${trimmedName}` : trimmedName;
  const content = window.sourceEditor.getValue();

  try {
    const response = await fetch("/ssh-write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: window.sshToken,
        path: newPath,
        content
      })
    });

    const result = await response.json();
    console.log("Save As result:", result);

    if (!result.success) {
      console.error("Failed to save file as:", result.error);
      return;
    }

    window.currentOpenFilePath = newPath;
    window.currentOpenFileName = trimmedName;
    window.hasUnsavedChanges = false;

    if (typeof loadFileExplorer === "function") {
      await loadFileExplorer(window.currentDirectory || window.currentExplorerPath || "~");
    }

    /*if (typeof window.setSourceCodeName === "function") {
      window.setSourceCodeName(trimmedName);
    }*/

    /*if (typeof window.updateSourceTabTitle === "function") {
      window.updateSourceTabTitle();
    }*/

    if (typeof openServerFile === "function") {
      await openServerFile(newPath, trimmedName);
    }

    console.log(`Saved file as: ${newPath}`);
  } catch (err) {
    console.error("Error saving file as:", err);
  }

}

window.saveCurrentFileAs = saveCurrentFileAs;

function showInlineNewItemInput(type) {
    const container = document.getElementById("file-explorer-list");
    if (!container) return;

    // Prevent multiple inputs
    if (document.getElementById("inline-new-item")) return;

    const row = document.createElement("div");
    row.id = "inline-new-item";
    row.className = "tree-item";
    row.style.paddingLeft = "8px";

    const arrowPlaceholder = document.createElement("span");
    arrowPlaceholder.className = "tree-item-arrow hidden";
    arrowPlaceholder.textContent = "\u25B6";
    row.appendChild(arrowPlaceholder);

    const icon = document.createElement("span");
    icon.className = "tree-item-icon " + (type === "folder" ? "folder" : "file-default");
    icon.textContent = type === "folder" ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
    row.appendChild(icon);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = type === "folder" ? "New folder" : "New file";
    input.className = "tree-rename-input";
    input.spellcheck = false;
    row.appendChild(input);

    container.prepend(row);
    input.focus();

    let finished = false;

    async function submit() {
        if (finished) return;
        finished = true;

        const name = input.value.trim();
        if (!name) {
            row.remove();
            return;
        }

        const basePath = window.currentExplorerPath || (window.explorerTree && window.explorerTree.path) || "~";
        const fullPath = basePath + "/" + name;

        try {
            let response, result;

            if (type === "file") {
                response = await fetch("/ssh-write", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: window.sshToken, path: fullPath, content: "" })
                });
                result = await response.json();
                if (!result.success) { console.error("Create file failed:", result.error); return; }

                await loadFileExplorer(basePath);
                openServerFile(result.path, name);
            } else {
                response = await fetch("/ssh-mkdir", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: window.sshToken, path: fullPath })
                });
                result = await response.json();
                if (!result.success) { console.error("Create folder failed:", result.error); return; }

                await loadFileExplorer(basePath);
            }
        } catch (err) {
            console.error("Error creating item:", err);
        } finally {
            row.remove();
        }
    }

    function cancel() {
        if (finished) return;
        finished = true;
        row.remove();
    }

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener("blur", () => {
        setTimeout(() => { if (!finished) cancel(); }, 100);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
}

// (showInlineRenameInput removed — replaced by beginTreeRename above)
