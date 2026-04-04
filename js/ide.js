import { usePuter } from "./puter.js";
import configuration from "./configuration.js";

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

var fontSize = 13;

var layout;

// variables to track the current file name and unsaved changes
var currentFileName = "Main.java";
var hasUnsavedChanges = false;
var isSaving = false;
var sourceContainer = null;
var suppressDirty = true;   // true while we are loading/setting initial content

// For autosave functionality
var autosaveTimer = null;
var AUTOSAVE_MS = 5000; // 2–5 seconds (pick what you want)

export var sourceEditor;
var stdinEditor;
var stdoutEditor;
var compileOutEditor;
var runOutEditor;

var $selectLanguage;
var $compilerOptions;
var $commandLineArguments;
var $runBtn;
var $clearBtn;
var $statusLine;
var $compileBtn;
var lastCompiledCode=null;

// Tracks the currently open WebSocket to the ssh-bridge terminal endpoint.
// Kept here so we can close it before opening a new one when Run is clicked again.
var activeTerminalWS = null;



var layoutConfig = {
    settings: {
        showPopoutIcon: false,
        reorderEnabled: true
    },
    content: [{
        type: configuration.get("appOptions.mainLayout"),
        content: [{
            type: "component",
            width: 66,
            componentName: "source",
            id: "source",
            title: "Source Code",
            isClosable: false,
            componentState: {
                readOnly: false
            }
        }, {
            type: configuration.get("appOptions.assistantLayout"),
            title: "AI Assistant and I/O",
            content: [configuration.get("appOptions.showAIAssistant") ? {
                type: "component",
                height: 66,
                componentName: "ai",
                id: "ai",
                title: "AI Assistant",
                isClosable: false,
                componentState: {
                    readOnly: false
                }
            } : null, {
                type: configuration.get("appOptions.ioLayout"),
                title: "I/O",
                content: [
                    configuration.get("appOptions.showInput") ? {
                        type: "component",
                        componentName: "stdin",
                        id: "stdin",
                        title: "Input",
                        isClosable: false,
                        componentState: {
                            readOnly: false
                        }
                    } : null, configuration.get("appOptions.showOutput") ? {
                        type: "component",
                        componentName: "compileOut",
                        id: "compileOut",
                        title: "Compile",
                        isClosable: false,
                        componentState: {
                            readOnly: true
                        }
                    } : null,
                    configuration.get("appOptions.showOutput") ? {
                        type: "component",
                        componentName: "terminal",
                        id: "terminal",
                        title: "Terminal",
                        isClosable: false,
                        componentState: {}
                    } : null].filter(Boolean)
            }].filter(Boolean)
        }]
    }]
};

var gPuterFile;

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
    // Clear the I/O editors
    if (stdinEditor) stdinEditor.setValue("");
    if (compileOutEditor) compileOutEditor.setValue("");
    if (runOutEditor) runOutEditor.setValue("");

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
    if (runOutEditor) runOutEditor.setValue("");

    $statusLine.html("Compiling...");

    // Switch to the Compile tab so the student sees compiler output.
    const compileTab = layout.root.getItemsById("compileOut")[0];
    if (compileTab && compileTab.parent && compileTab.parent.header && compileTab.parent.header.parent) {
        compileTab.parent.header.parent.setActiveContentItem(compileTab);
    }

    const langId   = getSelectedLanguageId();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl    = `${protocol}//${window.location.host}/terminal?token=${token}&mode=compile&lang=${langId}`;

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

function updateRunButtonState() {
    if (!$runBtn) return;

    const currentCode = sourceEditor ? sourceEditor.getValue().trim() : "";
    const canRun = !!lastCompiledCode && currentCode === lastCompiledCode;

    $runBtn.prop("disabled", !canRun);

    if (canRun) {
        $runBtn.removeClass("disabled");
        $runBtn.addClass("primary");
    } else {
        $runBtn.addClass("disabled");
        $runBtn.removeClass("primary");
    }
}

function run() {
    // Gate 1: student must be signed in to the CSCI server.
    // window.csciSessionToken is set by csci.js after a successful sign-in.
    const token = window.csciSessionToken;
    if (!token) {
        if (window.sshTerminal) {
            window.sshTerminal.write("\r\nERROR: Not signed in. Please sign in to the CSCI server first.\r\n");
        }
        return;
    }

    // Gate 2: code must have been compiled successfully before running.
    const currentCode = sourceEditor.getValue().trim();
    if (!lastCompiledCode || currentCode !== lastCompiledCode) {
        updateRunButtonState();
        return;
    }

    $runBtn.addClass("loading");
    $statusLine.html("Connecting...");

    // Switch the visible panel to the terminal tab so the student sees output.
    const termTab = layout.root.getItemsById("terminal")[0];
    if (termTab && termTab.parent && termTab.parent.header && termTab.parent.header.parent) {
        termTab.parent.header.parent.setActiveContentItem(termTab);
    }

    const term = window.sshTerminal;
    if (!term) {
        $runBtn.removeClass("loading");
        return;
    }

    // Close any WebSocket still open from a previous run before starting a new one.
    if (activeTerminalWS) {
        activeTerminalWS.close();
        activeTerminalWS = null;
    }

    term.clear();

    // Build the WebSocket URL. We use window.location.host so this works regardless
    // of whether the IDE is on localhost, a LAN IP, or a public domain.
    // ws:// is plain WebSocket (matching our http:// server). wss:// would be used
    // if the server were running over https://.
    const languageId = getSelectedLanguageId();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/terminal?token=${token}&mode=run&lang=${languageId}`;

    const ws = new WebSocket(wsUrl);
    activeTerminalWS = ws;

    // Wire 1: server → terminal.
    // Whenever ssh-bridge sends data (program output, error messages, echo text),
    // write it directly into the xterm.js terminal for the student to see.
    ws.onmessage = (event) => {
        term.write(event.data);
    };

    // Wire 2: terminal keystrokes → server.
    // term.onData fires for every character the student types, including special
    // keys like backspace, arrow keys, and Enter. We forward each character to
    // ssh-bridge, which passes it to the running program's stdin.
    // onData returns a disposable — calling dispose() stops listening, which we
    // do when the connection closes to avoid attaching duplicate listeners.
    const dataDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    ws.onopen = () => {
        $statusLine.html("Running...");
    };

    ws.onclose = () => {
        dataDisposable.dispose();
        activeTerminalWS = null;
        $runBtn.removeClass("loading");
        $statusLine.html("Program finished.");
    };

    ws.onerror = () => {
        term.write("\r\nERROR: Lost connection to server.\r\n");
        $runBtn.removeClass("loading");
        $statusLine.html("Connection error.");
    };
}

function openShell() {
    const token = window.csciSessionToken;
    if (!token) {
        if (window.sshTerminal) {
            window.sshTerminal.write("\r\nERROR: Not signed in. Please sign in to the CSCI server first.\r\n");
        }
        return;
    }

    // Switch to the terminal tab.
    const termTab = layout.root.getItemsById("terminal")[0];
    if (termTab && termTab.parent && termTab.parent.header && termTab.parent.header.parent) {
        termTab.parent.header.parent.setActiveContentItem(termTab);
    }

    const term = window.sshTerminal;
    if (!term) return;

    // Close any existing connection (previous run or shell session).
    if (activeTerminalWS) {
        activeTerminalWS.close();
        activeTerminalWS = null;
    }

    term.clear();
    $statusLine.html("Opening shell...");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/terminal?token=${token}&mode=shell`;

    const ws = new WebSocket(wsUrl);
    activeTerminalWS = ws;

    ws.onmessage = (event) => {
        term.write(event.data);
    };

    const dataDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    ws.onopen = () => {
        $statusLine.html("Shell connected.");
    };

    ws.onclose = () => {
        dataDisposable.dispose();
        activeTerminalWS = null;
        $statusLine.html("Shell disconnected.");
    };

    ws.onerror = () => {
        term.write("\r\nERROR: Lost connection to server.\r\n");
        $statusLine.html("Connection error.");
    };
}

// Helper function to update the source tab title with unsaved changes indicator and saving status
function updateSourceTabTitle() {
  if (!sourceContainer) return; // source tab not ready yet

  var dot = hasUnsavedChanges ? " •" : "";
  var saving = isSaving ? " — Saving..." : "";
  sourceContainer.setTitle(currentFileName + dot + saving);
}


function setSourceCodeName(name) {
  currentFileName = name;
  updateSourceTabTitle();
}

/*function setSourceCodeName(name) {
    $(".lm_title")[0].innerText = name;
}*/

/*function getSourceCodeName() {
    return $(".lm_title")[0].innerText;
}*/

function openFile(content, filename) {
    clear();

    suppressDirty = true;                 // prevent dirty flag during load
    sourceEditor.setValue(content);
    suppressDirty = false;                // now allow user edits to mark dirty

    selectLanguageForExtension(filename.split(".").pop());
    setSourceCodeName(filename);

    hasUnsavedChanges = false;            // freshly loaded file = clean
    updateSourceTabTitle();               // ensure correct title
}

function saveNow(reason) {
  if (!sourceEditor) return;

  isSaving = true;
  updateSourceTabTitle();

  var content = sourceEditor.getValue();

  // MVP: save to localStorage (silent autosave)
  localStorage.setItem("autosave:" + currentFileName, content);

  isSaving = false;
  hasUnsavedChanges = false;
  updateSourceTabTitle();
}

// Schedules an automatic save after the user stops typing
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);

  autosaveTimer = setTimeout(function () {
    // Only save if there are unsaved changes
    if (!hasUnsavedChanges) return;
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
    if (usePuter()) {
        gPuterFile = await puter.ui.showOpenFilePicker();
        openFile(await (await gPuterFile.read()).text(), gPuterFile.name);
    } else {
        document.getElementById("open-file-input").click();
    }
}

async function saveAction() {
    if (usePuter()) {
        if (gPuterFile) {
            gPuterFile.write(sourceEditor.getValue());
        } else {
            gPuterFile = await puter.ui.showSaveFilePicker(sourceEditor.getValue(), currentFileName);
            setSourceCodeName(gPuterFile.name);
        }
    } else {
        saveFile(sourceEditor.getValue(), currentFileName);
    }
}

function setFontSizeForAllEditors(fontSize) {
    if (sourceEditor) sourceEditor.updateOptions({ fontSize });
    if (stdinEditor) stdinEditor.updateOptions({ fontSize });
    if (stdoutEditor) stdoutEditor.updateOptions({ fontSize });
    if (compileOutEditor) compileOutEditor.updateOptions({ fontSize });
    if (runOutEditor) runOutEditor.updateOptions({ fontSize });
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
    stdinEditor.setValue("");
    $compilerOptions.val(DEFAULT_COMPILER_OPTIONS);
    $commandLineArguments.val(DEFAULT_CMD_ARGUMENTS);

    $statusLine.html("");

    loadSelectedLanguage();
}

function clear() {
    sourceEditor.setValue("");
    stdinEditor.setValue("");
    $compilerOptions.val("");
    $commandLineArguments.val("");

    $statusLine.html("");
}

function refreshSiteContentHeight() {
    const navigationHeight = document.getElementById("judge0-site-navigation").offsetHeight;

    const siteContent = document.getElementById("judge0-site-content");
    siteContent.style.height = `${window.innerHeight}px`;
    siteContent.style.paddingTop = `${navigationHeight}px`;
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
        let skipSetDefaultSourceCodeName = (data && data.skipSetDefaultSourceCodeName) || !!gPuterFile;
        loadSelectedLanguage(skipSetDefaultSourceCodeName);
    });

    loadLanguages();
    // Default editor language for MVP
    const JAVA_ID = "91"; // replace after you confirm
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
                case "o":
                    e.preventDefault();
                    openAction();
                    break;
                case "+":
                case "=":
                    e.preventDefault();
                    fontSize += 1;
                    setFontSizeForAllEditors(fontSize);
                    break;
                case "-":
                    e.preventDefault();
                    fontSize -= 1;
                    setFontSizeForAllEditors(fontSize);
                    break;
                case "0":
                    e.preventDefault();
                    fontSize = 13;
                    setFontSizeForAllEditors(fontSize);
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

        layout.registerComponent("source", function (container, state) {
            sourceContainer = container;
            sourceEditor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: true,
                readOnly: state.readOnly,
                language: "java",
                minimap: {
                    enabled: true
                },

                // Disable auto-indent
                autoIndent: "none",
                formatOnType: false,
                formatOnPaste: false,

                 //Disable automatic bracket/quote closing
                autoClosingBrackets: "never",
                autoClosingQuotes: "never",
                autoSurround: "never",

                // Disable autocomplete
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                parameterHints: { enabled: false },
                acceptSuggestionOnEnter: "off",
                tabCompletion: "off",
                wordBasedSuggestions: false,
                snippetSuggestions: "none"
            });

            // When the user types in the source editor, mark file as modified
           sourceEditor.onDidChangeModelContent(function () {
                if (suppressDirty) return;   // ignore changes caused by setValue/openFile/init
                hasUnsavedChanges = true;
                updateSourceTabTitle();
                scheduleAutosave();         // schedule an autosave after user stops typing for a bit
            });

             // After initial editor setup/content load finishes, mark file as clean and enable dirty tracking
            setTimeout(function () {
                hasUnsavedChanges = false;
                suppressDirty = false;
                updateSourceTabTitle();
            }, 0);

            sourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
                saveNow("manual");
            });

            sourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

            sourceEditor.onDidChangeModelContent(() => {
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

        layout.registerComponent("stdin", function (container, state) {
            stdinEditor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: false,
                readOnly: state.readOnly,
                language: "plaintext",
                minimap: {
                    enabled: false
                }
            });
        });

        layout.registerComponent("stdout", function (container, state) {
            stdoutEditor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: false,
                readOnly: state.readOnly,
                language: "plaintext",
                minimap: {
                    enabled: false
                }
            });
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

        layout.registerComponent("runOut", function (container, state) {
            runOutEditor = monaco.editor.create(container.getElement()[0], {
                automaticLayout: true,
                scrollBeyondLastLine: false,
                readOnly: true,
                language: "plaintext",
                minimap: { enabled: false
                }
            });
        });

        layout.registerComponent("terminal", function (container) {
            // Create a div that fills the entire golden-layout panel.
            // xterm.js renders its canvas inside this div.
            const termDiv = document.createElement("div");
            termDiv.style.width = "100%";
            termDiv.style.height = "100%";
            termDiv.style.overflow = "hidden";
            termDiv.style.backgroundColor = "#1e1e1e";
            container.getElement()[0].appendChild(termDiv);

            // Create the xterm.js terminal instance.
            // convertEol: true  → treats \n from the server as \r\n so lines don't
            //                     staircase down the screen without returning to the left.
            // scrollback: 1000  → remembers up to 1000 lines above the visible area.
            // fontFamily        → matches the JetBrains Mono font already used in the editor.
            const term = new Terminal({
                convertEol: true,
                scrollback: 1000,
                fontSize: 13,
                fontFamily: "JetBrains Mono, monospace",
                theme: {
                    background: "#1e1e1e",
                    foreground: "#d4d4d4"
                }
            });

            term.open(termDiv);

            // Static placeholder text so we can confirm the terminal is rendering
            // correctly before wiring it to the WebSocket in the next step.
            term.write("Terminal ready.\r\n");
            term.write("Sign in to the CSCI server and click Run to begin.\r\n");

            // Store the terminal instance on window so run() can reach it later.
            // window is the global object in the browser — anything attached to it
            // is accessible from any other script on the page.
            window.sshTerminal = term;

            // When the golden-layout panel is resized, resize the terminal to match.
            // Without this, the terminal stays its original size even if the panel grows.
            container.on("resize", function () {
                const cols = Math.max(10, Math.floor(container.width / 8));
                const rows = Math.max(5, Math.floor(container.height / 17));
                try { term.resize(cols, rows); } catch (e) { /* ignore during init */ }
            });
        });

        layout.registerComponent("ai", function (container, state) {
            container.getElement()[0].appendChild(document.getElementById("judge0-chat-container"));
        });

        layout.on("initialised", function () {
            setDefaults();
            refreshLayoutSize();
            window.top.postMessage({ event: "initialised" }, "*");
        });

        layout.init();
    });

    let superKey = "⌘";
    if (!/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform)) {
        superKey = "Ctrl";
    }

    [$runBtn].forEach(btn => {
        btn.attr("data-content", `${superKey}${btn.attr("data-content")}`);
    });

    document.querySelectorAll(".description").forEach(e => {
        e.innerText = `${superKey}${e.innerText}`;
    });

    if (usePuter()) {
        puter.ui.onLaunchedWithItems(async function (items) {
            gPuterFile = items[0];
            openFile(await (await gPuterFile.read()).text(), gPuterFile.name);
        });
    }

    document.getElementById("judge0-open-file-btn").addEventListener("click", openAction);
    document.getElementById("judge0-save-btn").addEventListener("click", saveAction);

    window.onmessage = function (e) {
        if (!e.data) {
            return;
        }

        if (e.data.action === "get") {
            window.top.postMessage(JSON.parse(JSON.stringify({
                event: "getResponse",
                source_code: sourceEditor.getValue(),
                language_id: getSelectedLanguageId(),
                flavor: getSelectedLanguageFlavor(),
                stdin: stdinEditor.getValue(),
                stdout: stdoutEditor.getValue(),
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
            if (e.data.stdin) {
                stdinEditor.setValue(e.data.stdin);
            }
            if (e.data.stdout) {
                stdoutEditor.setValue(e.data.stdout);
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
