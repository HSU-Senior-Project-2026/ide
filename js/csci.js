
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

async function showSignInModal() {
  $('#judge0-csci-sign-in-modal')
    .modal({ closable: false }).modal('show');
}

async function hideSignInModal() {
  $('#judge0-csci-sign-in-modal').modal('hide');
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
      // Clear credentials from DOM immediately after successful login
      passwordInput.value = "";
      $('#judge0-csci-sign-in-modal').modal('hide');
      showNotification(`Connected to CSCI server as ${username}`, "success");
      // Update account dropdown to show signed-in state
      var displayName = username.split("@")[0] || "User";
      document.getElementById("judge0-account-label").textContent = displayName;
      document.getElementById("judge0-csci-sign-in-btn").style.display = "none";
      document.getElementById("judge0-csci-sign-out-btn").style.display = "";

      // Save the SSH session token returned by the backend.
      // window.csciSessionToken is used by ide.js (run, compile, shell).
      // window.sshToken is used by file explorer operations (ssh-ls, ssh-read, etc).
      // Both must point to the same token.
      window.csciSessionToken = result.token;
      window.sshToken = result.token;

      // Tell ide.js to auto-open the persistent shell.
      window.dispatchEvent(new Event("csci-signed-in"));

      loadFileExplorer("~");

    } else {
      showNotification("Login failed: " + result.error, "error");
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
  }
}

// Load files from the user's home directory and render them in the Explorer
async function loadFileExplorer(path = "~") {
  console.log("loadFileExplorer called with path:", path);
  window.currentDirectory = path;
  window.currentExplorerPath = path;  // Track current path for navigation and new file creation
  
  if (!window.sshToken) {
    console.error("No SSH token found.");
    return;
  }

  try {
    console.log("Sending /ssh-ls request...");

    const response = await fetch("/ssh-ls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: window.sshToken,
        path
      })
    });

    console.log("Received response from /ssh-ls:", response.status);

    const result = await response.json();
    console.log("ssh-ls result:", result);

    if (result.success && result.path) {
      window.currentDirectory = result.path;
    }

    if (!result.success) {
      console.error("Failed to load files:", result.error);
      return;
    }

    renderFileExplorer(result.entries, result.path);
  } catch (err) {
    console.error("Error loading file explorer:", err);
  }
}

// Render file/folder entries into the Explorer sidebar
function renderFileExplorer(entries, currentPath) {
  const container = document.getElementById("file-explorer-list");
  if (!container) {
    console.error("Explorer container not found.");
    return;
  }

  container.innerHTML = "";
  entries.sort((a, b) => {
  // folders first
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;

  // then alphabetical
    return a.name.localeCompare(b.name);
  });
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "file-item";
    item.style.display = "flex";
    item.style.justifyContent = "space-between";
    item.style.alignItems = "center";
    if (entry.type === "directory") {
      item.classList.add("folder-item");
    } else {
      item.classList.add("file-entry");
  }

    const label = document.createElement("span");
    label.className = "file-label";
    label.innerHTML = entry.type === "directory"
      ? `<i class="folder icon"></i>${entry.name}`
      : `<i class="file outline icon"></i>${entry.name}`;
    label.style.flex = "1";
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    label.style.cursor = "pointer";
    label.style.minWidth = "0";

    label.addEventListener("click", () => {
      if (entry.type === "directory") {
        const nextPath =
          entry.name === ".."
            ? `${currentPath}/..`
            : `${currentPath}/${entry.name}`;
        loadFileExplorer(nextPath);
      } else {
        const filePath = `${currentPath}/${entry.name}`;
        document.querySelectorAll(".file-item").forEach(el => {
          el.classList.remove("active-file");
        });
        item.classList.add("active-file");
        
        openServerFile(filePath, entry.name);
      }
    });

    const actions = document.createElement("div");
    actions.className = "file-actions";
    actions.style.display = "flex";
    actions.style.gap = "6px";
    actions.style.marginLeft = "8px";

    const renameBtn = document.createElement("i");
    renameBtn.className = "edit icon rename-btn";
    renameBtn.title = "Rename";

    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showInlineRenameInput(entry, currentPath);
    });

    const deleteBtn = document.createElement("i");
    deleteBtn.className = "trash icon delete-btn";
    deleteBtn.title = "Delete";

    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteExplorerItem(entry, currentPath);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(label);
    item.appendChild(actions);
    container.appendChild(item);
  });
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

document.addEventListener("DOMContentLoaded", function () {
  document
    .getElementById("judge0-csci-sign-in-btn")
    .addEventListener("click", showSignInModal);

  const signInForm = document.getElementById("judge0-csci-sign-in-form");
  const signInBtn = document.getElementById("judge0-csci-modal-sign-in-btn");
  const cancelBtn = document.getElementById("judge0-csci-modal-sign-in-cancel-btn");
  const signOutBtn = document.getElementById("judge0-csci-sign-out-btn");

  // Keep normal form submission from reloading the page
  signInForm?.addEventListener("submit", function (e) {
    e.preventDefault();
    signIn(e);
  });

  // Force Enter key to trigger sign-in from anywhere inside the modal form
  signInForm?.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      signIn(e);
    }
  });

  signInBtn?.addEventListener("click", signIn);
  cancelBtn?.addEventListener("click", hideSignInModal);
  signOutBtn?.addEventListener("click", signOut);

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
});


// Attach saveCurrentFile to the Save button in the UI
document.getElementById("save-file-btn")?.addEventListener("click", () => {
  if (typeof window.saveCurrentFile === "function") {
    window.saveCurrentFile();
  } else {
    console.error("saveCurrentFile is not available.");
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

document.getElementById("sidebar-new-file")?.addEventListener("click", async () => {
    if (!window.sshToken) {
        console.error("No SSH token found.");
        return;
    }

    showInlineNewItemInput("file");

    // Create the file in the current directory if you are tracking one,
    // otherwise default to the home directory.
    const filePath = window.currentExplorerPath
        ? `${window.currentExplorerPath}/${fileName}`
        : `~/${fileName}`;

    try {
        const response = await fetch("/ssh-write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: window.sshToken,
                path: filePath,
                content: ""
            })
        });

        const result = await response.json();
        console.log("Create file result:", result);

        if (!result.success) {
            console.error("Failed to create file:", result.error);
            return;
        }

        // Refresh the sidebar
        loadFileExplorer(window.currentExplorerPath || "~");

        // Optionally open the new empty file immediately
        openServerFile(result.path, fileName);
    } catch (err) {
        console.error("Error creating file:", err);
    }
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
    if (!container) {
        console.error("Explorer container not found.");
        return;
    }

    // Prevent multiple inputs
    if (document.getElementById("inline-new-item")) return;

    const row = document.createElement("div");
    row.id = "inline-new-item";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.padding = "4px";

    const icon = document.createElement("span");
    icon.textContent = type === "folder" ? "📁 " : "📄 ";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = type === "folder" ? "New folder" : "New file";
    input.style.flex = "1";
    input.style.background = "transparent";
    input.style.color = "white";
    input.style.border = "1px solid #555";
    input.style.outline = "none";

    row.appendChild(icon);
    row.appendChild(input);

    container.prepend(row);

    input.focus();

    async function submit() {
        const name = input.value.trim();
        if (!name) {
            row.remove();
            return;
        }

        const basePath = window.currentExplorerPath || "~";
        const fullPath = `${basePath}/${name}`;

        try {
            let response, result;

            if (type === "file") {
                response = await fetch("/ssh-write", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        token: window.sshToken,
                        path: fullPath,
                        content: ""
                    })
                });

                result = await response.json();

                if (!result.success) {
                    console.error("Create file failed:", result.error);
                    return;
                }

                await loadFileExplorer(basePath);
                openServerFile(result.path, name);

            } else {
                response = await fetch("/ssh-mkdir", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        token: window.sshToken,
                        path: fullPath
                    })
                });

                result = await response.json();

                if (!result.success) {
                    console.error("Create folder failed:", result.error);
                    return;
                }

                await loadFileExplorer(basePath);
            }

        } catch (err) {
            console.error("Error creating item:", err);
        } finally {
            row.remove();
        }
    }

    function cancel() {
        row.remove();
    }

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") cancel();
    });

    input.addEventListener("blur", () => {
        setTimeout(() => {
            if (document.body.contains(row)) cancel();
        }, 100);
    });
}

// Show an inline rename input for a file or folder in the Explorer
async function showInlineRenameInput(entry, currentPath) {
    const container = document.getElementById("file-explorer-list");
    if (!container) {
        console.error("Explorer container not found.");
        return;
    }

    // Prevent multiple inline inputs at once
    if (document.getElementById("inline-rename-item")) return;

    const row = document.createElement("div");
    row.id = "inline-rename-item";
    row.className = "file-explorer-item inline-new-item";

    const icon = document.createElement("span");
    icon.textContent = entry.type === "directory" ? "📁 " : "📄 ";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-new-item-input";
    input.value = entry.name;

    row.appendChild(icon);
    row.appendChild(input);

    container.prepend(row);

    input.focus();
    input.select();

    async function submitRename() {
        const newName = input.value.trim();

        if (!newName || newName === entry.name) {
            row.remove();
            return;
        }

        const oldPath = `${currentPath}/${entry.name}`;
        const newPath = `${currentPath}/${newName}`;

        try {
            const response = await fetch("/ssh-mv", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: window.sshToken,
                    from: oldPath,
                    to: newPath
                })
            });

            const result = await response.json();
            console.log("Rename result:", result);

            if (!result.success) {
                console.error("Rename failed:", result.error);
                return;
            }

            // Update the open Golden Layout tab for this file (if any) so its
            // id/title/state all reflect the new path.
            if (typeof window.renameRemoteTabByPath === "function") {
                window.renameRemoteTabByPath(result.from || oldPath, result.to || newPath, newName);
            } else if (window.currentOpenFilePath === result.from) {
                window.currentOpenFilePath = result.to;
                window.currentOpenFileName = newName;
                if (typeof window.setSourceCodeName === "function") {
                    window.setSourceCodeName(newName);
                }
            }

            await loadFileExplorer(currentPath);
        } catch (err) {
            console.error("Error renaming item:", err);
        } finally {
            row.remove();
        }
    }

    function cancelRename() {
        row.remove();
    }

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            submitRename();
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRename();
        }
    });

    input.addEventListener("blur", () => {
        setTimeout(() => {
            if (document.body.contains(row)) {
                cancelRename();
            }
        }, 100);
    });
}

function getParentDirectory(filePath) {
  if (!filePath) return "";
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash !== -1 ? filePath.substring(0, lastSlash) : "";
}