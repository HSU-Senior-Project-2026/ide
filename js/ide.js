import configuration from "./configuration.js";
import { FileManager } from "./file_explorer.js";

// Supported languages — hardcoded to match LANGUAGE_COMMANDS in ssh-bridge.js.
// No external Judge0 API needed; all execution happens on the CSCI server via SSH.
const SUPPORTED_LANGUAGES = [
    { id: 62,  name: "Java",       source_file: "Main.java", editor_mode: "java" },
    { id: 103, name: "C (GCC)",    source_file: "main.c",    editor_mode: "c" },
    { id: 105, name: "C++ (GCC)",  source_file: "main.cpp",  editor_mode: "cpp" },
    { id: 71,  name: "Python 3",   source_file: "main.py",   editor_mode: "python" },
    { id: 102, name: "JavaScript (Node.js)", source_file: "main.js", editor_mode: "javascript" },
    { id: 46,  name: "Bash",       source_file: "main.sh",   editor_mode: "shell" },
];

// Language IDs that are interpreted (no compile step needed).
// For these, Run auto-uploads and executes without requiring a separate Compile click.
const INTERPRETED_LANGUAGE_IDS = [71, 102, 46]; // Python, Node.js, Bash

var fontSize = 13;

export var layout;

// variables to track the current file name and unsaved changes
window.currentFileName = "Main.java";
window.hasUnsavedChanges = false;
window.isSaving = false;
window.suppressDirty = true;   // true while we are loading/setting content

// For autosave functionality
var autosaveTimer = null;
var AUTOSAVE_MS = 5000; // 2–5 seconds (pick what you want)

export var sourceEditor;
export var sourceContainer;
window.sourceEditors = {}; // Manages concurrent Monaco models
var compileOutEditor;

var $selectLanguage;
var $compilerOptions;
var $commandLineArguments;
var $runBtn;
var $clearBtn;
var $statusLine;
var $compileBtn;
var lastCompiledCode=null;

// Tracks the currently open WebSocket for the run session (Output panel).
var activeRunWS = null;
// Tracks the persistent shell WebSocket (Shell panel). Opened on sign-in,
// closed on sign-out or tab close. Unlike activeRunWS this lives across runs.
var activeShellWS = null;



// Error line highlighting decorations
var errorDecorations = [];

function clearErrorHighlights() {
    if (sourceEditor && errorDecorations.length) {
        errorDecorations = sourceEditor.deltaDecorations(errorDecorations, []);
    }
}

function highlightErrorLines(compileOutput) {
    clearErrorHighlights();
    if (!sourceEditor || !compileOutput) return;

    var lineNumbers = [];
    // Java: Main.java:5: error: ...
    // C/GCC: main.c:12:5: error: ...  or  main.c:12:5: warning: ...
    // Python: File "main.py", line 3
    var patterns = [
        /\.(?:java|c|cpp|h):(\d+)/g,              // Java / C / C++
        /File\s+"[^"]+",\s+line\s+(\d+)/g,        // Python
        /^(\d+)\s*\|/gm,                           // GCC caret-style output
        /error.*?:(\d+):/g                         // generic fallback
    ];

    patterns.forEach(function (regex) {
        var match;
        while ((match = regex.exec(compileOutput)) !== null) {
            var lineNum = parseInt(match[1]);
            if (lineNum > 0 && lineNumbers.indexOf(lineNum) === -1) {
                lineNumbers.push(lineNum);
            }
        }
    });

    if (lineNumbers.length === 0) return;

    var decorations = lineNumbers.map(function (line) {
        return {
            range: new monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: true,
                className: "judge0-error-line",
                glyphMarginClassName: "judge0-error-glyph",
                overviewRuler: {
                    color: "#ff0000",
                    position: monaco.editor.OverviewRulerLane.Full
                }
            }
        };
    });

    errorDecorations = sourceEditor.deltaDecorations([], decorations);
}

var layoutConfig = {
    settings: {
        showPopoutIcon: false,
        reorderEnabled: true
    },
    content: [{
        type: configuration.get("appOptions.mainLayout"),
        content: [{
            type: "stack",
            width: 66,
            id: "sourceStack",
            content: [{
                type: "component",
                componentName: "source",
                id: "source",
                title: "Source Code",
                isClosable: false,
                componentState: {
                    readOnly: false
                }
            }]
        }, {
            type: configuration.get("appOptions.assistantLayout"),
            title: "AI Assistant and I/O",
            content: [{
                type: "column",
                title: "I/O",
                content: [{
                    type: "stack",
                    height: 50,
                    content: [{
                        type: "component",
                        componentName: "compileOut",
                        id: "compileOut",
                        title: "Compile",
                        isClosable: false,
                        componentState: {
                            readOnly: true
                        }
                    }, {
                        type: "component",
                        componentName: "output",
                        id: "output",
                        title: "Output",
                        isClosable: false,
                        componentState: {}
                    }]
                }, {
                    type: "component",
                    componentName: "shell",
                    id: "shell",
                    title: "Shell",
                    isClosable: false,
                    componentState: {}
                }]
            }].filter(Boolean)
        }]
    }]
};



function showError(title, content) {
    $("#judge0-site-modal #title").html(title);
    $("#judge0-site-modal .content").html(content);

    let FTitle = encodeURIComponent(`Error on ${window.location.href}`);
    let reportBody = encodeURIComponent(
        `**Error Title**: ${title}\n` +
        `**Error Timestamp**: \`${new Date()}\`\n` +
        `**Origin**: ${window.location.href}\n` +
        `**Description**:\n${content}`
    );

    $("#report-problem-btn").attr("href", `https://github.com/judge0/ide/issues/new?title=${FTitle}&body=${reportBody}`);
    $("#judge0-site-modal").modal("show");
}

// Clear I/O editors and status line before running new code
function clearIO() {
    if (compileOutEditor) compileOutEditor.setValue("");

    // Optional: clear old status line
    if ($statusLine) $statusLine.html("");

    // Optional: stop a stuck spinner
    if ($runBtn) $runBtn.removeClass("loading");
}

function getSelectedLanguage() {
    const id = getSelectedLanguageId();
    return SUPPORTED_LANGUAGES.find(l => l.id === id) || SUPPORTED_LANGUAGES[0];
}

function getSelectedLanguageId() {
    return parseInt($selectLanguage.val());
}



/*function setCompileButtonLoading(loading) {
    if (loading) {
        $compileBtn.addClass("loading disabled");
        $compileBtn.find(".compile-icon").removeClass().addClass("compile-icon spinner loading icon");
    } else {
        $compileBtn.removeClass("loading disabled");
        $compileBtn.find(".compile-icon").removeClass().addClass("compile-icon");
    }
}*/

function compileOnly() {
    const currentCode = sourceEditor.getValue().trim();

    if (currentCode === "") {
        showError("Error", "Source code can't be empty!");
        lastCompiledCode = null;
        updateRunButtonState();
        return;
    }

    // Compilation now happens on the CSCI server via SSH, so the student must
    // be signed in. The token was stored on window by csci.js after sign-in.
    const token = window.csciSessionToken;
    if (!token) {
        showError("Error", "Please sign in to the CSCI server before compiling.");
        return;
    }

    lastCompiledCode = null;
    updateRunButtonState();

    if (compileOutEditor) compileOutEditor.setValue("");

    $statusLine.html("Compiling...");

    // Switch to the Compile tab so the student sees compiler output.
    const compileTab = layout.root.getItemsById("compileOut")[0];
    if (compileTab) {
        compileTab.parent.header.parent.setActiveContentItem(compileTab);
    }

    const langId   = getSelectedLanguageId();
    const fileName = encodeURIComponent(window.currentFileName || "");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl    = `${protocol}//${window.location.host}/terminal?token=${token}&mode=compile&lang=${langId}&file=${fileName}`;

    const ws = new WebSocket(wsUrl);
    let compileOutput = "";

    ws.onopen = () => {
        // Send the raw source code as the first (and only) message.
        // ssh-bridge receives it, base64-encodes it for safe shell handling,
        // writes it to a temp directory, and runs the compile command.
        ws.send(sourceEditor.getValue());
    };

    ws.onmessage = (event) => {
        // Accumulate compiler output and update the panel live as it arrives.
        // This gives the student streaming feedback for slow compilers.
        compileOutput += event.data;
        if (compileOutEditor) compileOutEditor.setValue(compileOutput);
    };

    ws.onclose = (event) => {
        // ssh-bridge closes with code 4000 on success, 4001 on failure.
        // This lets us know whether to enable the Run button without needing
        // to parse the compiler output for error messages.
        if (event.code === 4000) {
            lastCompiledCode = currentCode;
            if (compileOutEditor) {
                compileOutEditor.setValue(compileOutput || "Compilation successful.");
            }
            $statusLine.html("Compilation successful.");
        } else {
            lastCompiledCode = null;
            $statusLine.html("Compilation failed.");
        }
        updateRunButtonState();
    };

    ws.onerror = () => {
        lastCompiledCode = null;
        $statusLine.html("Connection error during compilation.");
        updateRunButtonState();
    };
}

function updateCompileButtonVisibility() {
    if (!$compileBtn) return;
    const languageId = getSelectedLanguageId();
    if (INTERPRETED_LANGUAGE_IDS.includes(languageId)) {
        $compileBtn.hide();
    } else {
        $compileBtn.show();
    }
    updateRunButtonState();
}

function updateRunButtonState() {
    if (!$runBtn) return;

    const currentCode = sourceEditor ? sourceEditor.getValue().trim() : "";
    const languageId = getSelectedLanguageId();
    const isInterpreted = INTERPRETED_LANGUAGE_IDS.includes(languageId);

    const canRun = isInterpreted || (!!lastCompiledCode && currentCode === lastCompiledCode);

    $runBtn.prop("disabled", !canRun);

    if (canRun) {
        $runBtn.removeClass("disabled").addClass("primary");
    } else {
        $runBtn.addClass("disabled").removeClass("primary");
    }
}

// For interpreted languages: upload the code via compile WS, then immediately run.
function autoCompileThenRun(currentCode, languageId) {
    const token = window.csciSessionToken;
    const fileName = encodeURIComponent(window.currentFileName || "");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const compileUrl = `${protocol}//${window.location.host}/terminal?token=${token}&mode=compile&lang=${languageId}&file=${fileName}`;

    const compileWs = new WebSocket(compileUrl);

    compileWs.onopen = () => {
        compileWs.send(sourceEditor.getValue());
    };

    compileWs.onclose = (event) => {
        if (event.code === 4000) {
            // Upload succeeded — now run
            lastCompiledCode = currentCode;
            updateRunButtonState();
            $statusLine.html("Running...");
            startRunWebSocket(token, languageId);
        } else {
            lastCompiledCode = null;
            $runBtn.removeClass("loading");
            $statusLine.html("Upload failed.");
            updateRunButtonState();
        }
    };

    compileWs.onerror = () => {
        $runBtn.removeClass("loading");
        $statusLine.html("Connection error.");
    };
}

// Shared logic for opening the run WebSocket (used by both run() and autoCompileThenRun).
// Program I/O goes to the Output panel, not the Shell, so the shell stays undisturbed.
function startRunWebSocket(token, languageId) {
    // Switch to the Output tab so the student sees program output.
    const outTab = layout.root.getItemsById("output")[0];
    if (outTab && outTab.parent && outTab.parent.header && outTab.parent.header.parent) {
        outTab.parent.header.parent.setActiveContentItem(outTab);
    }

    const term = window.outputTerminal;
    if (!term) {
        $runBtn.removeClass("loading");
        return;
    }

    if (activeRunWS) {
        activeRunWS.close();
        activeRunWS = null;
    }

    term.clear();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    const wsUrl = `${protocol}//${window.location.host}/terminal?token=${token}&mode=run&lang=${languageId}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(wsUrl);
    activeRunWS = ws;

    ws.onmessage = (event) => {
        term.write(event.data);
    };

    const dataDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
    });

    ws.onopen = () => {
        $statusLine.html("Running...");
    };

    ws.onclose = () => {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        activeRunWS = null;
        $runBtn.removeClass("loading");
        $statusLine.html("Program finished.");
    };

    ws.onerror = () => {
        term.write("\r\nERROR: Lost connection to server.\r\n");
        $runBtn.removeClass("loading");
        $statusLine.html("Connection error.");
    };
}

function run() {
    // Gate 1: student must be signed in to the CSCI server.
    // window.csciSessionToken is set by csci.js after a successful sign-in.
    const token = window.csciSessionToken;
    if (!token) {
        if (window.outputTerminal) {
            window.outputTerminal.write("\r\nERROR: Not signed in. Please sign in to the CSCI server first.\r\n");
        }
        return;
    }

    // Gate 2: for compiled languages, code must have been compiled first.
    // For interpreted languages, auto-upload via the compile WebSocket before running.
    const currentCode = sourceEditor.getValue().trim();
    const languageId = getSelectedLanguageId();
    const isInterpreted = INTERPRETED_LANGUAGE_IDS.includes(languageId);

    if (!isInterpreted && (!lastCompiledCode || currentCode !== lastCompiledCode)) {
        updateRunButtonState();
        return;
    }

    $runBtn.addClass("loading");
    $statusLine.html(isInterpreted ? "Uploading..." : "Connecting...");

    // For interpreted languages, run the compile (upload) step first, then run.
    if (isInterpreted) {
        autoCompileThenRun(currentCode, languageId);
        return;
    }

    // Compiled language with successful compile — go straight to run.
    startRunWebSocket(token, languageId);
}

// Opens a persistent shell WebSocket in the Shell panel. Called automatically
// on sign-in and can be called again via the Shell button to reconnect.
function openShell() {
    const token = window.csciSessionToken;
    if (!token) {
        if (window.shellTerminal) {
            window.shellTerminal.write("\r\nERROR: Not signed in. Please sign in to the CSCI server first.\r\n");
        }
        return;
    }

    const term = window.shellTerminal;
    if (!term) return;

    // If a shell WS is already open and healthy, just focus the panel.
    if (activeShellWS && activeShellWS.readyState === WebSocket.OPEN) return;

    // Close any dead/closing WS before opening a fresh one.
    if (activeShellWS) {
        activeShellWS.close();
        activeShellWS = null;
    }

    term.clear();
    $statusLine.html("Opening shell...");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    const wsUrl = `${protocol}//${window.location.host}/terminal?token=${token}&mode=shell&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(wsUrl);
    activeShellWS = ws;

    ws.onmessage = (event) => {
        term.write(event.data);
    };

    const dataDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
    });

    ws.onopen = () => {
        $statusLine.html("Shell connected.");
    };

    ws.onclose = () => {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        activeShellWS = null;
        $statusLine.html("Shell disconnected.");
    };

    ws.onerror = () => {
        term.write("\r\nERROR: Lost connection to server.\r\n");
        $statusLine.html("Connection error.");
    };
}

// Tears down the shell WebSocket. Called on sign-out so the persistent
// shell doesn't outlive the SSH session.
function closeShell() {
    if (activeShellWS) {
        activeShellWS.close();
        activeShellWS = null;
    }
    if (window.shellTerminal) {
        window.shellTerminal.clear();
        window.shellTerminal.write("Sign in to the CSCI server to open a shell.\r\n");
    }
}

// Helper function to update the source tab title with unsaved changes indicator and saving status
function updateSourceTabTitle() {
  if (!sourceContainer) return; // source tab not ready yet

  var dot = window.hasUnsavedChanges ? " •" : "";
  var saving = window.isSaving ? " — Saving..." : "";
  sourceContainer.setTitle(window.currentFileName + dot + saving);
}

window.updateSourceTabTitle = updateSourceTabTitle;


function setSourceCodeName(name) {
  window.currentFileName = name;
  selectLanguageForExtension(name.split(".").pop());
  window.updateSourceTabTitle();
}

/*function setSourceCodeName(name) {
    $(".lm_title")[0].innerText = name;
}*/

/*function getSourceCodeName() {
    return $(".lm_title")[0].innerText;
}*/

function newFile(filename) {
    clear();
    window.suppressDirty = true;
    sourceEditor.setValue("");
    suppressDirty = false;

    selectLanguageForExtension(filename.split(".").pop());
    setSourceCodeName(filename);

    window.hasUnsavedChanges = false;
    window.updateSourceTabTitle();

    // Clear saved source so refresh starts fresh with the new file
    try { localStorage.removeItem("judge0.sourceCode"); } catch (e) {}
}

window.setSourceCodeName = setSourceCodeName;

function openFile(content, filename) {
    window.suppressDirty = true;                 // prevent dirty flag during load
    clear();

    sourceEditor.setValue(content);
    window.suppressDirty = false;                // now allow user edits to mark dirty

    selectLanguageForExtension(filename.split(".").pop());
    setSourceCodeName(filename);

    window.hasUnsavedChanges = false;            // freshly loaded file = clean
    window.updateSourceTabTitle();               // ensure correct title
}
window.openFile = openFile; // Expose globally for file explorer callbacks

// Opens a remote (server) file in its own Golden Layout tab, or focuses the
// existing tab if the file is already open. Each remote tab is identified by
// its absolute server path so the same file can't appear twice.
function openFileInTab(filePath, fileName, content) {
    if (!layout || !layout.root) {
        // Layout not ready yet — fall back to single-editor behavior
        openFile(content, fileName);
        window.currentOpenFilePath = filePath;
        window.currentOpenFileName = fileName;
        return;
    }

    const tabId = "remote:" + filePath;

    // If already open, just focus that tab
    const existing = layout.root.getItemsById(tabId)[0];
    if (existing) {
        if (existing.parent && existing.parent.setActiveContentItem) {
            existing.parent.setActiveContentItem(existing);
        }
        // If content has drifted on disk and there are no unsaved edits,
        // refresh — otherwise leave the user's work intact.
        try {
            const editorForTab = (window.sourceEditorsByPath || {})[filePath];
            if (editorForTab && editorForTab.editor && !window.hasUnsavedChanges) {
                if (editorForTab.editor.getValue() !== content) {
                    window.suppressDirty = true;
                    editorForTab.editor.setValue(content);
                    window.suppressDirty = false;
                }
            }
        } catch (e) {}
        return;
    }

    const sourceStack = layout.root.getItemsById("sourceStack")[0];
    if (!sourceStack) {
        openFile(content, fileName);
        window.currentOpenFilePath = filePath;
        window.currentOpenFileName = fileName;
        return;
    }

    sourceStack.addChild({
        type: "component",
        componentName: "source",
        id: tabId,
        title: fileName,
        componentState: {
            readOnly: false,
            filePath: filePath,
            fileName: fileName,
            initialContent: content
        }
    });
}
window.openFileInTab = openFileInTab;

// Closes a remote tab by its server path (used when the file is deleted).
function closeRemoteTabByPath(filePath) {
    if (!layout || !layout.root) return;
    const item = layout.root.getItemsById("remote:" + filePath)[0];
    if (item) {
        try { item.remove(); } catch (e) {}
    }
}
window.closeRemoteTabByPath = closeRemoteTabByPath;

// Updates an open remote tab when the file is renamed elsewhere (e.g. from
// the file-tree rename flow). Changes the tab id/title/state to the new path.
function renameRemoteTabByPath(oldPath, newPath, newName) {
    if (!layout || !layout.root) return;
    const item = layout.root.getItemsById("remote:" + oldPath)[0];
    if (!item) return;

    const cfg = item.config;
    cfg.id = "remote:" + newPath;
    cfg.title = newName;
    cfg.componentState = cfg.componentState || {};
    cfg.componentState.filePath = newPath;
    cfg.componentState.fileName = newName;

    try { item.setTitle(newName); } catch (e) {}

    // Update the per-path editor map
    if (window.sourceEditorsByPath && window.sourceEditorsByPath[oldPath]) {
        window.sourceEditorsByPath[newPath] = window.sourceEditorsByPath[oldPath];
        delete window.sourceEditorsByPath[oldPath];
    }

    // If this is the active tab, re-sync globals and language detection
    if (window.currentOpenFilePath === oldPath) {
        window.currentOpenFilePath = newPath;
        window.currentOpenFileName = newName;
        window.currentFileName = newName;
        try { selectLanguageForExtension(newName.split(".").pop()); } catch (e) {}
        if (typeof window.updateSourceTabTitle === "function") {
            window.updateSourceTabTitle();
        }
    }
}
window.renameRemoteTabByPath = renameRemoteTabByPath;

// Double-click on a source tab's title triggers rename via ssh-mv.
// Only attaches once per page load; delegates from document.
let _sourceTabDblClickWired = false;
function setupSourceTabInteractions() {
    if (_sourceTabDblClickWired) return;
    _sourceTabDblClickWired = true;

    $(document).on("dblclick", ".lm_header .lm_tab .lm_title", function (e) {
        if (!layout || !layout.root) return;
        const sourceStack = layout.root.getItemsById("sourceStack")[0];
        if (!sourceStack) return;

        // Find which stack this tab belongs to via DOM walk
        const tabEl = $(this).closest(".lm_tab")[0];
        const stackEl = $(tabEl).closest(".lm_stack")[0];
        if (!stackEl || sourceStack.element[0] !== stackEl) return;

        // Map DOM tab element to the GL content item
        const tabObj = (sourceStack.header && sourceStack.header.tabs || [])
            .find(t => t.element && t.element[0] === tabEl);
        const item = tabObj ? tabObj.contentItem : null;
        if (!item) return;

        const state = (item.config && item.config.componentState) || {};
        if (!state.filePath) return; // scratch tab isn't renamable this way

        e.preventDefault();
        e.stopPropagation();
        beginInlineTabRename(this, state.filePath, state.fileName || item.config.title);
    });
}

// Replaces the tab title with an inline <input>, lets the user edit the name
// directly, and submits the rename via /ssh-mv on Enter/blur. Escape cancels.
function beginInlineTabRename(titleEl, oldPath, oldName) {
    const $title = $(titleEl);
    if ($title.find("input.tab-rename-input").length) return; // already editing

    const originalText = $title.text();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = oldName;
    input.spellcheck = false;
    input.autocomplete = "off";

    $title.empty().append(input);
    input.focus();
    // Select the basename (everything before the final dot) for quick editing
    const dot = oldName.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();

    let finished = false;

    function restoreTitle(text) {
        $title.empty().text(text);
    }

    function cancel() {
        if (finished) return;
        finished = true;
        restoreTitle(originalText);
    }

    function submit() {
        if (finished) return;
        const newName = input.value.trim();
        if (!newName || newName === oldName) {
            cancel();
            return;
        }
        finished = true;

        const token = window.sshToken || window.csciSessionToken;
        if (!token) {
            restoreTitle(originalText);
            showError("Error", "Please sign in to the CSCI server before renaming.");
            return;
        }

        const basePath = oldPath.substring(0, oldPath.lastIndexOf("/"));
        const newPath = basePath + "/" + newName;

        // Optimistic title update so the UI feels snappy
        restoreTitle(newName);

        fetch("/ssh-mv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token, from: oldPath, to: newPath })
        })
        .then(r => r.json())
        .then(result => {
            if (!result.success) {
                restoreTitle(originalText);
                showError("Rename failed", result.error || "Unknown error");
                return;
            }
            renameRemoteTabByPath(result.from || oldPath, result.to || newPath, newName);
            if (typeof window.loadFileExplorer === "function" && window.currentExplorerPath) {
                window.loadFileExplorer(window.currentExplorerPath);
            }
        })
        .catch(err => {
            restoreTitle(originalText);
            showError("Error", "Rename failed: " + err.message);
        });
    }

    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); submit(); }
        else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
        ev.stopPropagation();
    });
    // Stop the parent tab from interpreting clicks/drags as tab switches/drags
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("blur", () => submit());
}


function saveNow(reason) {
  if (!sourceEditor) return;

  window.isSaving = true;
  window.updateSourceTabTitle();

  var content = sourceEditor.getValue();

  // MVP: save to localStorage (silent autosave)
  localStorage.setItem("autosave:" + window.currentFileName, content);
  FileManager.saveActiveFile(content);

  window.isSaving = false;
  window.hasUnsavedChanges = false;
  window.updateSourceTabTitle();
}

// Schedules an automatic save after the user stops typing
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);

  autosaveTimer = setTimeout(function () {
    // Only save if there are unsaved changes
    if (!window.hasUnsavedChanges) return;
    saveNow("idle");
  }, AUTOSAVE_MS);
}

function saveFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

async function openAction() {
    document.getElementById("open-file-input").click();
}

async function saveAction() {
    saveFile(sourceEditor.getValue(), window.currentFileName);
}

function setFontSizeForAllEditors(fontSize) {
    // Apply to all open source editor tabs
    Object.values(window.sourceEditors).forEach(ed => {
        if (ed) ed.updateOptions({ fontSize });
    });
    if (compileOutEditor) compileOutEditor.updateOptions({ fontSize });
}

function loadLanguages() {
    let options = SUPPORTED_LANGUAGES.map(lang => {
        let option = new Option(lang.name, lang.id);
        option.setAttribute("langauge_mode", lang.editor_mode);
        if (lang.id === DEFAULT_LANGUAGE_ID) {
            option.selected = true;
        }
        return option;
    });

    $selectLanguage.append(options);
    $selectLanguage.parent(".ui.dropdown").dropdown("refresh");
}

function loadSelectedLanguage(skipSetDefaultSourceCodeName = false) {
    if (!sourceEditor) {
        console.warn("Editor not initialized yet");
        return;
    }
    monaco.editor.setModelLanguage(sourceEditor.getModel(), $selectLanguage.find(":selected").attr("langauge_mode"));
    if (!skipSetDefaultSourceCodeName) {
        setSourceCodeName(getSelectedLanguage().source_file);
    }
    updateCompileButtonVisibility();
}

function selectLanguageById(languageId) {
    let option = $selectLanguage.find(`[value=${languageId}]`);
    if (option.length) {
        option.prop("selected", true);
        $selectLanguage.trigger("change", { skipSetDefaultSourceCodeName: true });
    }
}

function selectLanguageForExtension(extension) {
    let language = getLanguageForExtension(extension);
    if (language) {
        selectLanguageById(language.language_id);
    }
}

function setDefaults() {
    setFontSizeForAllEditors(fontSize);
    sourceEditor.setValue(DEFAULT_SOURCE);
    $compilerOptions.val(DEFAULT_COMPILER_OPTIONS);
    $commandLineArguments.val(DEFAULT_CMD_ARGUMENTS);

    $statusLine.html("");

    loadSelectedLanguage();
}

function clear() {
    sourceEditor.setValue("");
    $compilerOptions.val("");
    $commandLineArguments.val("");

    $statusLine.html("");

    // Clear saved source code from localStorage
    try { localStorage.removeItem("judge0.sourceCode"); } catch (e) {}
}

function refreshSiteContentHeight() {
    const navigationHeight = document.getElementById("judge0-site-navigation").offsetHeight;

    const wrapper = document.getElementById("judge0-site-wrapper");
    wrapper.style.top = `${navigationHeight}px`;

    const siteContent = document.getElementById("judge0-site-content");
    siteContent.style.height = `${window.innerHeight - navigationHeight}px`;
}

function refreshLayoutSize() {
    refreshSiteContentHeight();
    layout.updateSize();
}

window.addEventListener("resize", refreshLayoutSize);
document.addEventListener("DOMContentLoaded", async function () {
    $(".ui.selection.dropdown").dropdown();
    $("[data-content]").popup({
        lastResort: "left center"
    });

    refreshSiteContentHeight();

    console.log("Hey, Judge0 IDE is open-sourced: https://github.com/judge0/ide. Have fun!");

    $selectLanguage = $("#select-language");
    $selectLanguage.change(function (event, data) {
        let skipSetDefaultSourceCodeName = !!(data && data.skipSetDefaultSourceCodeName);
        loadSelectedLanguage(skipSetDefaultSourceCodeName);

        // Persist selected language to localStorage
        try {
            localStorage.setItem("judge0.languageId", getSelectedLanguageId());
        } catch (e) {}
    });

    loadLanguages();
    // Default editor language for MVP
    const JAVA_ID = "62";
    $selectLanguage.parent(".ui.dropdown").dropdown("set selected", JAVA_ID);
    loadSelectedLanguage(true); // ensure Monaco updates; true avoids filename reset

    $compilerOptions = $("#compiler-options");
    $commandLineArguments = $("#command-line-arguments");

    $runBtn = $("#run-btn");
    updateRunButtonState();

    $clearBtn = $("#clear-btn");
    $compileBtn = $("#compile-btn");
    $runBtn.click(run);
    $clearBtn.click(clearIO);
    $compileBtn.click(compileOnly);
    $("#shell-btn").click(openShell);

    // Auto-open the persistent shell when the student signs in, and tear it
    // down on sign-out. csci.js dispatches these events after the HTTP calls.
    window.addEventListener("csci-signed-in", openShell);
    window.addEventListener("csci-signed-out", closeShell);

    $("#open-file-input").change(function (e) {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            const reader = new FileReader();
            reader.onload = function (e) {
                openFile(e.target.result, selectedFile.name);
            };

            reader.onerror = function (e) {
                showError("Error", "Error reading file: " + e.target.error);
            };

            reader.readAsText(selectedFile);
        }
    });

    $statusLine = $("#judge0-status-line");

    $(document).on("keydown", "body", function (e) {
        // Shift+Alt shortcuts (avoid browser conflicts)
        if (e.shiftKey && e.altKey) {
            switch (e.key.toLowerCase()) {
                case "n":
                    e.preventDefault();
                    document.getElementById("sidebar-new-file")?.click();
                    return;
                case "o":
                    e.preventDefault();
                    openAction();
                    return;
                case "d":
                    e.preventDefault();
                    if (sourceEditor) {
                        saveFile(sourceEditor.getValue(), currentFileName);
                    }
                    return;
            }
        }

        if (e.metaKey || e.ctrlKey) {
            switch (e.key) {
                case "Enter":
                    e.preventDefault();
                    run();
                    break;
                case "s":
                    e.preventDefault();
                    saveAction();
                    break;
                case "+":
                case "=":
                    e.preventDefault();
                    if (fontSize < 32) {
                        fontSize += 1;
                        setFontSizeForAllEditors(fontSize);
                        updateFontDisplay();
                    }
                    break;
                case "-":
                    e.preventDefault();
                    if (fontSize > 8) {
                        fontSize -= 1;
                        setFontSizeForAllEditors(fontSize);
                        updateFontDisplay();
                    }
                    break;
                case "0":
                    e.preventDefault();
                    fontSize = 13;
                    setFontSizeForAllEditors(fontSize);
                    updateFontDisplay();
                    break;
                case "`":
                    e.preventDefault();
                    sourceEditor.focus();
                    break;
            }
        }
    });

    require(["vs/editor/editor.main"], function (ignorable) {
        layout = new GoldenLayout(layoutConfig, $("#judge0-site-content"));
        window.__ideModules = { layout: layout };

        layout.registerComponent("source", function (container, state) {
            
            const editor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: true,
                readOnly: state.readOnly,
                language: "java",
                minimap: {
                    enabled: true
                },

                autoIndent: "full",
                formatOnType: true,
                formatOnPaste: true,

                autoClosingBrackets: "always",
                autoClosingQuotes: "always",
                autoSurround: "languageDefined",

                glyphMargin: true,

                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                parameterHints: { enabled: false },
                acceptSuggestionOnEnter: "off",
                tabCompletion: "off",
                wordBasedSuggestions: false,
                snippetSuggestions: "none"
            });

            // Expose the Monaco editor globally so other scripts
            // can open and save files through it
            window.sourceEditor = editor;

            // Handle Ctrl+S / Cmd+S directly inside Monaco
            /*editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
                console.log("Monaco save shortcut triggered");

                if (typeof window.saveCurrentFile === "function") {
                    window.saveCurrentFile();
                } else {
                    console.error("saveCurrentFile is not available.");
                }
            });*/

            /*editor.addAction({
                id: "save-file-action",
                label: "Save File",
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS
                ],
                run: function () {
                    console.log("Monaco save action triggered");

                    if (typeof window.saveCurrentFile === "function") {
                        console.log("Calling window.saveCurrentFile from Monaco action");
                        return window.saveCurrentFile();
                    } else {
                        console.error("window.saveCurrentFile is not available");
                    }
                }
            });*/

            // Set initial content if parsed dynamically via file_explorer open callbacks
            if (state.initialContent !== undefined) {
                window.suppressDirty = true;
                editor.setValue(state.initialContent);
                window.suppressDirty = false;
            }

            // A tab backed by a remote server file carries its full path in state.
            // These tabs don't participate in the local FileManager (workspace) tree.
            const remotePath = state.filePath || null;
            const remoteName = state.fileName || null;
            let fileId = state.fileId;

            if (remotePath) {
                container.setTitle(remoteName);
                try { selectLanguageForExtension(remoteName.split(".").pop()); } catch(e) {}
                window.sourceEditorsByPath = window.sourceEditorsByPath || {};
                window.sourceEditorsByPath[remotePath] = { editor: editor, container: container };
                fileId = "remote:" + remotePath;
            } else if (!fileId) {
                // Default first tab generated implicitly by Golden Layout's config tree
                let initialFile = FileManager.getInitialFileContent();
                if (initialFile) {
                    fileId = initialFile.id;
                    container.setTitle(initialFile.name);
                    editor.setValue(initialFile.content);
                    currentFileName = initialFile.name;
                    selectLanguageForExtension(initialFile.name.split(".").pop());
                } else {
                    fileId = "default";
                }
                container._config.componentState = { fileId: fileId };
                sourceEditor = editor;
                sourceContainer = container;
            }

            window.sourceEditors[fileId] = editor;

            container.on("show", () => {
                sourceEditor = editor;
                sourceContainer = container;
                window.sourceEditor = editor;
                window.sourceContainer = container;

                // Read the remote path from current state (may have changed after rename)
                const curRemotePath = (container._config.componentState || {}).filePath;
                const curRemoteName = (container._config.componentState || {}).fileName;

                if (curRemotePath) {
                    // Remote-backed tab: drive the server-save state off this tab.
                    window.currentFileName = curRemoteName || container._config.title;
                    window.currentOpenFilePath = curRemotePath;
                    window.currentOpenFileName = window.currentFileName;
                    selectLanguageForExtension(window.currentFileName.split(".").pop());
                    if (typeof window.updateSourceTabTitle === "function") {
                        window.updateSourceTabTitle();
                    }
                } else {
                    // Local workspace tab.
                    let vfsFile = FileManager.findFile(fileId, FileManager.tree);
                    if (vfsFile) {
                        currentFileName = vfsFile.name;
                    } else {
                        currentFileName = container._config.title;
                    }
                    selectLanguageForExtension(currentFileName.split(".").pop());

                    // Clear remote-save pointers so Ctrl+S on a local scratch tab
                    // doesn't write to the last-opened remote file.
                    window.currentOpenFilePath = null;
                    window.currentOpenFileName = null;

                    FileManager.activeFileId = fileId;
                    let parentId = FileManager.findParentFolderId(fileId, FileManager.tree);
                    if (parentId) {
                        FileManager.activeFolderId = parentId;
                    }
                    FileManager.render();
                }

                // Reattach vim to the newly active editor
                try {
                    if (window.__vimHelpers) window.__vimHelpers.reattach();
                } catch(e) {}
            });

            container.on("destroy", () => {
                const st = container._config.componentState || {};
                if (st.filePath && window.sourceEditorsByPath) {
                    delete window.sourceEditorsByPath[st.filePath];
                } else {
                    // Save content of local workspace tabs before disposing
                    try {
                        let file = FileManager.findFile(fileId, FileManager.tree);
                        if (file) {
                            file.content = editor.getValue();
                            FileManager.saveWorkspace();
                        }
                    } catch (e) {}
                }
                try {
                    if (window.__vimHelpers) window.__vimHelpers.detach();
                } catch(e) {}
                delete window.sourceEditors[fileId];
                editor.dispose();
            });

            // Disable F1 command palette and right-click context menu
            editor.addCommand(monaco.KeyCode.F1, function () {});
            editor.updateOptions({ contextmenu: false });

            // When the user types in the source editor, mark file as modified
            editor.onDidChangeModelContent(function () {
                if (window.suppressDirty) return;   // ignore changes caused by setValue/openFile/init
                
                window.hasUnsavedChanges = true;
                window.updateSourceTabTitle();
                //scheduleAutosave();         // schedule an autosave after user stops typing for a bit
            });

             // After initial editor setup/content load finishes, mark file as clean and enable dirty tracking
            setTimeout(function () {
                window.hasUnsavedChanges = false;
                window.suppressDirty = false;
                window.updateSourceTabTitle();
            }, 0);

            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
                saveNow("manual");
            });

            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

            editor.onDidChangeModelContent(() => {
                lastCompiledCode = null;
                updateRunButtonState();
            });
            /*monaco.languages.registerInlineCompletionsProvider('*', {
                provideInlineCompletions: async (model, position) => {
                    if (!puter.auth.isSignedIn() || !document.getElementById("judge0-inline-suggestions").checked || !configuration.get("appOptions.showAIAssistant")) {
                        return;
                    }

                    const textBeforeCursor = model.getValueInRange({
                        startLineNumber: 1,
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column
                    });

                    const textAfterCursor = model.getValueInRange({
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: model.getLineCount(),
                        endColumn: model.getLineMaxColumn(model.getLineCount())
                    });

                    const aiResponse = await puter.ai.chat([{
                        role: "user",
                        content: `You are a code completion assistant. Given the following context, generate the most likely code completion.

                    ### Code Before Cursor:
                    ${textBeforeCursor}

                    ### Code After Cursor:
                    ${textAfterCursor}

                    ### Instructions:
                    - Predict the next logical code segment.
                    - Ensure the suggestion is syntactically and contextually correct.
                    - Keep the completion concise and relevant.
                    - Do not repeat existing code.
                    - Provide only the missing code.
                    - **Respond with only the code, without markdown formatting.**
                    - **Do not include triple backticks (\`\`\`) or additional explanations.**

                    ### Completion:`.trim()
                    }], {
                        model: document.getElementById("judge0-chat-model-select").value,
                    });

                    let aiResponseValue = aiResponse?.toString().trim() || "";

                    if (Array.isArray(aiResponseValue)) {
                        aiResponseValue = aiResponseValue.map(v => v.text).join("\n").trim();
                    }

                    if (!aiResponseValue || aiResponseValue.length === 0) {
                        return;
                    }

                    return {
                        items: [{
                            insertText: aiResponseValue,
                            range: new monaco.Range(
                                position.lineNumber,
                                position.column,
                                position.lineNumber,
                                position.column
                            )
                        }]
                    };
                },
                handleItemDidShow: () => { },
                freeInlineCompletions: () => { }
            });*/
        });

        layout.registerComponent("compileOut", function (container, state) {
            compileOutEditor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: false,
                readOnly: true,
                language: "plaintext",
                minimap: { enabled: false 
                }
            });
        });

        // Helper: create an xterm.js instance inside a golden-layout container.
        // Used for both the Output and Shell panels.
        function createXterm(container, placeholder) {
            const termDiv = document.createElement("div");
            termDiv.style.width = "100%";
            termDiv.style.height = "100%";
            termDiv.style.overflow = "hidden";
            termDiv.style.backgroundColor = "#1e1e1e";
            container.getElement()[0].appendChild(termDiv);

            const term = new Terminal({
                convertEol: true,
                scrollback: 1000,
                fontSize: 13,
                fontFamily: "JetBrains Mono, monospace",
                theme: { background: "#1e1e1e", foreground: "#d4d4d4" }
            });

            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termDiv);
            try { fitAddon.fit(); } catch (e) { /* container may not be sized yet */ }

            if (placeholder) term.write(placeholder);

            container.on("resize", function () {
                try { fitAddon.fit(); } catch (e) { /* ignore during init */ }
            });

            return { term, fitAddon };
        }

        // Output panel — displays run output (program I/O). Separate from the
        // shell so running code doesn't steal focus from an active shell session.
        layout.registerComponent("output", function (container) {
            const { term, fitAddon } = createXterm(container, "Click Run to execute your code.\r\n");
            window.outputTerminal = term;
            window.outputFitAddon = fitAddon;
        });

        // Shell panel — persistent interactive SSH shell. Auto-connected on
        // sign-in and stays open for the entire session. Always visible below
        // the Compile/Output tabs so students can use it while code runs above.
        layout.registerComponent("shell", function (container) {
            const { term, fitAddon } = createXterm(container, "Sign in to the CSCI server to open a shell.\r\n");
            window.shellTerminal = term;
            window.shellFitAddon = fitAddon;
        });

        layout.registerComponent("ai", function (container, state) {
            container.getElement()[0].appendChild(document.getElementById("judge0-chat-container"));
        });

        layout.on("initialised", function () {
            setupSourceTabInteractions();
            FileManager.init({
                onOpenFile: (content, name) => {
                    openFile(content, name);
                },
                onRenameFile: (name) => {
                    setSourceCodeName(name);
                }
            });

            // Handle new file from sidebar
            var sidebarNewFileBtn = document.getElementById("sidebar-new-file");
            if (sidebarNewFileBtn) {
                sidebarNewFileBtn.addEventListener("click", function () {
                    FileManager.createAndRenameFile();
                });
            }

            // Handle new folder from sidebar
            var sidebarNewFolderBtn = document.getElementById("sidebar-new-folder");
            if (sidebarNewFolderBtn) {
                sidebarNewFolderBtn.addEventListener("click", function () {
                    FileManager.createAndRenameFolder();
                });
            }

            // Resizer handle logic
            var resizer = document.getElementById("sidebar-resizer");
            var sidebar = document.getElementById("judge0-sidebar");
            var isResizing = false;

            if (resizer && sidebar) {
                resizer.addEventListener("mousedown", function(e) {
                    isResizing = true;
                    document.body.style.cursor = 'col-resize';
                    resizer.classList.add("dragging");
                });

                document.addEventListener("mousemove", function(e) {
                    if (!isResizing) return;
                    var newWidth = e.clientX - sidebar.getBoundingClientRect().left;
                    if (newWidth > 150 && newWidth < 800) {
                        sidebar.style.width = newWidth + "px";
                        refreshLayoutSize();
                    }
                });

                document.addEventListener("mouseup", function(e) {
                    if (isResizing) {
                        isResizing = false;
                        document.body.style.cursor = '';
                        resizer.classList.remove("dragging");
                    }
                });
            }

            // Handle explicit close button from sidebar
            var sidebarCloseBtn = document.getElementById("sidebar-close");
            if (sidebarCloseBtn) {
                sidebarCloseBtn.addEventListener("click", function() {
                    var explorerIcon = document.querySelector('.activity-icon[data-panel="explorer"]');
                    var sidebar = document.getElementById("judge0-sidebar");
                    
                    if (explorerIcon) explorerIcon.classList.remove("active");
                    if (sidebar) sidebar.classList.add("collapsed");
                    
                    refreshLayoutSize();
                });
            }

            // Activity bar: toggle sidebar
            document.querySelectorAll(".activity-icon").forEach(function (icon) {
                icon.addEventListener("click", function () {
                    var panel = this.getAttribute("data-panel");
                    var sidebar = document.getElementById("judge0-sidebar");

                    if (this.classList.contains("active")) {
                        // Collapse sidebar
                        this.classList.remove("active");
                        sidebar.classList.add("collapsed");
                    } else {
                        // Expand sidebar
                        document.querySelectorAll(".activity-icon").forEach(function (i) { i.classList.remove("active"); });
                        this.classList.add("active");
                        sidebar.classList.remove("collapsed");
                    }

                    // Refresh immediately for a snappy UX
                    refreshLayoutSize();
                });
            });

            setDefaults();
            refreshLayoutSize();
            // Apply saved font size and word wrap after editors exist
            setFontSizeForAllEditors(fontSize);
            var wrapSetting = localStorage.getItem("judge0.wordWrap") !== "off" ? "on" : "off";
            Object.values(window.sourceEditors).forEach(ed => { if (ed) ed.updateOptions({ wordWrap: wrapSetting }); });
            if (compileOutEditor) compileOutEditor.updateOptions({ wordWrap: wrapSetting });
            window.top.postMessage({ event: "initialised" }, "*");
        });

        layout.init();
    });

    // Vim mode support — only one instance at a time (the active tab)
    var vimEnabled = localStorage.getItem("judge0.vimMode") === "on";
    var activeVimInstance = null;
    var MonacoVim = null;

    // Load monaco-vim module
    require(["monaco-vim"], function (mod) {
        MonacoVim = mod;
        if (vimEnabled) {
            applyVimMode();
        }
    });

    function applyVimMode() {
        var statusBar = document.getElementById("vim-status-bar");
        var vimBtn = document.getElementById("vim-toggle-btn");

        // Always dispose the current instance first
        if (activeVimInstance) {
            activeVimInstance.dispose();
            activeVimInstance = null;
        }
        statusBar.innerHTML = "";

        if (vimEnabled && MonacoVim && sourceEditor) {
            statusBar.style.display = "block";
            if (vimBtn) { vimBtn.style.opacity = "1"; vimBtn.style.color = "#4ec9b0"; }
            activeVimInstance = MonacoVim.initVimMode(sourceEditor, statusBar);
        } else {
            statusBar.style.display = "none";
            if (vimBtn) { vimBtn.style.opacity = "0.6"; vimBtn.style.color = ""; }
        }
    }

    // Called when tabs switch — reattach vim to the newly active editor
    window.__vimHelpers = {
        reattach: function() {
            if (vimEnabled && MonacoVim) {
                applyVimMode();
            }
        },
        detach: function() {
            if (activeVimInstance) {
                activeVimInstance.dispose();
                activeVimInstance = null;
            }
            var statusBar = document.getElementById("vim-status-bar");
            if (statusBar) statusBar.innerHTML = "";
        }
    };

    var vimToggleBtn = document.getElementById("vim-toggle-btn");
    if (vimToggleBtn) {
        vimToggleBtn.addEventListener("click", function () {
            vimEnabled = !vimEnabled;
            try { localStorage.setItem("judge0.vimMode", vimEnabled ? "on" : "off"); } catch (e) {}
            applyVimMode();
        });
    }

    let superKey = "⌘";
    if (!/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform)) {
        superKey = "Ctrl";
    }

    [$runBtn].forEach(btn => {
        btn.attr("data-content", `${superKey}${btn.attr("data-content")}`);
    });

    document.getElementById("judge0-open-file-btn")?.addEventListener("click", openAction);
    document.getElementById("judge0-save-btn")?.addEventListener("click", saveAction);
    document.getElementById("judge0-download-btn")?.addEventListener("click", function () {
        if (sourceEditor) {
            saveFile(sourceEditor.getValue(), currentFileName);
        }
    });

    // Font size toolbar controls (elements may not exist in all layouts)
    var $fontDisplay = document.getElementById("font-size-display");
    function updateFontDisplay() {
        if ($fontDisplay) $fontDisplay.textContent = fontSize + "px";
        try { localStorage.setItem("judge0.fontSize", fontSize); } catch (e) {}
    }
    // Restore saved font size
    var savedFontSize = localStorage.getItem("judge0.fontSize");
    if (savedFontSize) {
        fontSize = parseInt(savedFontSize);
    }
    updateFontDisplay();

    var fontDecBtn = document.getElementById("font-decrease-btn");
    if (fontDecBtn) fontDecBtn.addEventListener("click", function () {
        if (fontSize > 8) {
            fontSize -= 1;
            setFontSizeForAllEditors(fontSize);
            updateFontDisplay();
        }
    });
    var fontIncBtn = document.getElementById("font-increase-btn");
    if (fontIncBtn) fontIncBtn.addEventListener("click", function () {
        if (fontSize < 32) {
            fontSize += 1;
            setFontSizeForAllEditors(fontSize);
            updateFontDisplay();
        }
    });

    // Word wrap toggle
    var wordWrapEnabled = localStorage.getItem("judge0.wordWrap") !== "off";
    var $wordWrapBtn = document.getElementById("word-wrap-btn");
    function applyWordWrap() {
        var setting = wordWrapEnabled ? "on" : "off";
        Object.values(window.sourceEditors).forEach(ed => { if (ed) ed.updateOptions({ wordWrap: setting }); });
        if (compileOutEditor) compileOutEditor.updateOptions({ wordWrap: setting });
        if ($wordWrapBtn) {
            if (wordWrapEnabled) {
                $wordWrapBtn.classList.add("active");
            } else {
                $wordWrapBtn.classList.remove("active");
            }
        }
        try { localStorage.setItem("judge0.wordWrap", setting); } catch (e) {}
    }
    if ($wordWrapBtn) $wordWrapBtn.addEventListener("click", function () {
        wordWrapEnabled = !wordWrapEnabled;
        applyWordWrap();
    });




    window.onmessage = function (e) {
        if (!e.data) {
            return;
        }

        if (e.data.action === "get") {
            window.top.postMessage(JSON.parse(JSON.stringify({
                event: "getResponse",
                source_code: sourceEditor.getValue(),
                language_id: getSelectedLanguageId(),
                compiler_options: $compilerOptions.val(),
                command_line_arguments: $commandLineArguments.val()
            })), "*");
        } else if (e.data.action === "set") {
            if (e.data.source_code) {
                sourceEditor.setValue(e.data.source_code);
            }
            if (e.data.language_id) {
                selectLanguageById(e.data.language_id);
            }
            if (e.data.compiler_options) {
                $compilerOptions.val(e.data.compiler_options);
            }
            if (e.data.command_line_arguments) {
                $commandLineArguments.val(e.data.command_line_arguments);
            }
        } else if (e.data.action === "run") {
            run();
        }
    };
});

const DEFAULT_SOURCE = "\
public class Main {\n\
    public static void main(String[] args) {\n\
        System.out.println(\"Hello, World!\");\n\
    }\n\
}\n\
";

const DEFAULT_COMPILER_OPTIONS = "";
const DEFAULT_CMD_ARGUMENTS = "";
const DEFAULT_LANGUAGE_ID = 62; // Java

// Maps file extensions to language IDs for the "Open File" feature.
// Only extensions matching SUPPORTED_LANGUAGES are included.
const EXTENSIONS_TABLE = {
    "java": { language_id: 62 },
    "c":    { language_id: 103 },
    "cpp":  { language_id: 105 },
    "py":   { language_id: 71 },
    "js":   { language_id: 102 },
    "sh":   { language_id: 46 },
};

function getLanguageForExtension(extension) {
    return EXTENSIONS_TABLE[extension] || null;
}

window.increaseFont = function () {
    if (fontSize < 32) {
        fontSize += 2;
        setFontSizeForAllEditors(fontSize);
    }
};

window.decreaseFont = function () {
    if (fontSize > 8) {
        fontSize -= 2;
        setFontSizeForAllEditors(fontSize);
    }
};