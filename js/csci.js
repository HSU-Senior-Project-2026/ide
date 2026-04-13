
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
      // This token is required for future authenticated actions
      // like reading, writing, compiling, and running code.
      window.sshToken = result.token;
      console.log("SSH token saved:", window.sshToken);

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
      body: JSON.stringify({ action: "exit" })
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = await response.json();
    console.log("Server response:", result);

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
  console.log("renderFileExplorer called");
  console.log("Entries being rendered:", entries);

  const container = document.getElementById("file-explorer-list");
  console.log("Explorer container:", container);
  
  if (!container) {
    console.error("Explorer container not found.");
    return;
  }

  container.innerHTML = "";

  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "file-explorer-item";
    item.textContent = entry.type === "directory" ? `📁 ${entry.name}` : `📄 ${entry.name}`;

    item.addEventListener("click", () => {
      if (entry.type === "directory") {
        const nextPath =
          entry.name === ".."
            ? `${currentPath}/..`
            : `${currentPath}/${entry.name}`;
        loadFileExplorer(nextPath);
      } else {
        const filePath = `${currentPath}/${entry.name}`;
        openServerFile(filePath, entry.name);
      }
    });

    container.appendChild(item);
  });
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

    // Load file contents into the editor
    window.sourceEditor.setValue(result.content);

    // Remember which file is currently open
    window.currentOpenFilePath = result.path;
    window.currentOpenFileName = fileName;

    console.log("Current open file:", window.currentOpenFilePath);

    // Update visible editor tab title if available
    const tabLabel = document.querySelector(".lm_title");
    if (tabLabel) {
      tabLabel.textContent = fileName;
    }
  } catch (err) {
    console.error("Error opening file:", err);
  }
}

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("judge0-csci-sign-in-btn").addEventListener("click", showSignInModal);

  // Prevent native form submission to keep credentials out of the URL
  document.getElementById("judge0-csci-sign-in-form").addEventListener("submit", function (e) {
    e.preventDefault();
    signIn(e);
  });

  document.getElementById("judge0-csci-modal-sign-in-btn").addEventListener("click", signIn);
  document.getElementById("judge0-csci-modal-sign-in-cancel-btn").addEventListener("click", hideSignInModal);
  document.getElementById("judge0-csci-sign-out-btn").addEventListener("click", signOut);

  // Tab-close / navigation-away sign-out.
  //
  // With Layer 1 (persistent SSH connection per session), every signed-in
  // student holds an open SSH channel to csci.hsutx.edu on the server. If
  // they just close the tab, the server wouldn't know to tear that down
  // until the 30-minute idle-reap timer fires. sendBeacon lets us fire a
  // best-effort POST to /ssh-sign-out during page unload — the browser
  // guarantees delivery even as the page dies, and it doesn't block the
  // close. The server handles the sign-out exactly like a normal one
  // (invalidateSession → sshClient.end → delete from Map).
  //
  // Notes:
  // - 'pagehide' fires more reliably than 'beforeunload' on mobile and with
  //   back/forward cache, so we register both and let whichever fires first
  //   do the work. The server endpoint is idempotent (a second sign-out
  //   just returns "no active session").
  // - sendBeacon requires a Blob with the correct Content-Type for Express's
  //   json middleware to parse the body.
  // - If csciSessionToken is null (never signed in, or already signed out)
  //   we skip — nothing to clean up.
  function beaconSignOut() {
    if (!window.csciSessionToken) return;
    try {
      const payload = new Blob(
        [JSON.stringify({ token: window.csciSessionToken })],
        { type: "application/json" }
      );
      navigator.sendBeacon("/ssh-sign-out", payload);
    } catch (err) {
      // Nothing we can do during unload — page is going away regardless.
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

    console.log(`Saved file: ${window.currentOpenFilePath}`);
  } catch (err) {
    console.error("Error saving file:", err);
  }
}

window.saveCurrentFile = saveCurrentFile;