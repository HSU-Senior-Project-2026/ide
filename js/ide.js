import configuration from "./configuration.js";
import { FileManager } from "./file_explorer.js";

// API key and auth are handled server-side by the ssh-bridge proxy — not needed here
const AUTH_HEADERS = {};

const CE = "CE";
const EXTRA_CE = "EXTRA_CE";

// Relative URL: browser calls /judge0/... on port 80, proxy forwards to localhost:2358
const AUTHENTICATED_CE_BASE_URL = "/judge0";
const AUTHENTICATED_EXTRA_CE_BASE_URL = "/judge0";

var AUTHENTICATED_BASE_URL = {};
AUTHENTICATED_BASE_URL[CE] = AUTHENTICATED_CE_BASE_URL;
AUTHENTICATED_BASE_URL[EXTRA_CE] = AUTHENTICATED_EXTRA_CE_BASE_URL;

const UNAUTHENTICATED_CE_BASE_URL = "/judge0";
const UNAUTHENTICATED_EXTRA_CE_BASE_URL = "/judge0";

var UNAUTHENTICATED_BASE_URL = {};
UNAUTHENTICATED_BASE_URL[CE] = UNAUTHENTICATED_CE_BASE_URL;
UNAUTHENTICATED_BASE_URL[EXTRA_CE] = UNAUTHENTICATED_EXTRA_CE_BASE_URL;

const INITIAL_WAIT_TIME_MS = 0;
const WAIT_TIME_FUNCTION = i => 100;
const MAX_PROBE_REQUESTS = 600;

var fontSize = 13;

export var layout;

// variables to track the current file name and unsaved changes
var currentFileName = "Main.java";
var hasUnsavedChanges = false;
var isSaving = false;
var suppressDirty = true;   // true while we are loading/setting content

// For autosave functionality
var autosaveTimer = null;
var AUTOSAVE_MS = 5000; // 2–5 seconds (pick what you want)

export var sourceEditor;
export var sourceContainer;
window.sourceEditors = {}; // Manages concurrent Monaco models
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
var lastCompiledCode = null;

var timeStart;

var sqliteAdditionalFiles;
var languages = {};

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
                        componentName: "runOut",
                        id: "runOut",
                        title: "Runtime",
                        isClosable: false,
                        componentState: {
                            readOnly: true
                        }
                    } : null].filter(Boolean)
            }].filter(Boolean)
        }]
    }]
};



function encode(str) {
    return btoa(unescape(encodeURIComponent(str || "")));
}

function decode(bytes) {
    var escaped = escape(atob(bytes || ""));
    try {
        return decodeURIComponent(escaped);
    } catch {
        return unescape(escaped);
    }
}

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

function showHttpError(jqXHR) {
    showError(`${jqXHR.statusText} (${jqXHR.status})`, `<pre>${JSON.stringify(jqXHR, null, 4)}</pre>`);
}

function handleRunError(jqXHR) {
    showHttpError(jqXHR);
    $runBtn.removeClass("loading");

    window.top.postMessage(JSON.parse(JSON.stringify({
        event: "runError",
        data: jqXHR
    })), "*");
}

function handleResult(data) {
    const tat = Math.round(performance.now() - timeStart);
    console.log(`It took ${tat}ms to get submission result.`);

    const status = data.status;
    const stdout = decode(data.stdout);
    const stderr = decode(data.stderr);
    const compileOutput = data.compile_output ? decode(data.compile_output) : null;
    const time = (data.time === null ? "-" : data.time + "s");
    const memory = (data.memory === null ? "-" : data.memory + "KB");

    $statusLine.html(`${status.description}, ${time}, ${memory} (TAT: ${tat}ms)`);

    const runtimeOutput = [stdout, stderr].filter(x => x).join("\n").trimEnd();
    const compileText = (compileOutput || "").trimEnd();

    // Highlight error lines from compiler output or runtime errors
    highlightErrorLines(compileOutput || stderr);

    // Compile tab: show compiler output or a friendly success message
    if (compileOutEditor) {
        compileOutEditor.setValue(compileText || "Compilation successful.");
        const lastLine = compileOutEditor.getModel()?.getLineCount?.() ?? 1;
        compileOutEditor.revealLine(lastLine);
    }
    // Runtime tab: show stdout + stderr (can be empty if program prints nothing)
    if (runOutEditor) {
        runOutEditor.setValue(runtimeOutput);
        const lastLine = runOutEditor.getModel()?.getLineCount?.() ?? 1;
        runOutEditor.revealLine(lastLine);
    }
    const output = [compileText, runtimeOutput].filter(x => x).join("\n").trimEnd();
    
    $runBtn.removeClass("loading");

    window.top.postMessage(JSON.parse(JSON.stringify({
        event: "postExecution",
        status: data.status,
        time: data.time,
        memory: data.memory,
        output: output
    })), "*");
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

async function getSelectedLanguage() {
    return getLanguage(getSelectedLanguageFlavor(), getSelectedLanguageId())
}

function getSelectedLanguageId() {
    return parseInt($selectLanguage.val());
}

function getSelectedLanguageFlavor() {
    return $selectLanguage.find(":selected").attr("flavor");
}

function setCompileButtonLoading(loading) {
    if (loading) {
        $compileBtn.addClass("loading disabled");
        $compileBtn.find(".compile-icon").removeClass().addClass("compile-icon spinner loading icon");
    } else {
        $compileBtn.removeClass("loading disabled");
        $compileBtn.find(".compile-icon").removeClass().addClass("compile-icon");
    }
}

function compileOnly() {
    const currentCode = sourceEditor.getValue().trim();

    if (currentCode === "") {
        showError("Error", "Source code can't be empty!");
        lastCompiledCode = null;
        updateRunButtonState();
        return;
    }

    lastCompiledCode = null;
    updateRunButtonState();

    if (compileOutEditor) compileOutEditor.setValue("");
    if (runOutEditor) runOutEditor.setValue("");

    $statusLine.html("Compiling...");
    // Switch to Compile tab when compiling
    const compileTab = layout.root.getItemsById("compileOut")[0];
    if (compileTab) {
        compileTab.parent.header.parent.setActiveContentItem(compileTab);
    }

    let sourceValue = encode(sourceEditor.getValue());
    let languageId = getSelectedLanguageId();
    let flavor = getSelectedLanguageFlavor();

    let data = {
        source_code: sourceValue,
        language_id: languageId,
        stdin: encode(""),
        redirect_stderr_to_stdout: false
    };

    clearErrorHighlights();

    $.ajax({
        url: `${AUTHENTICATED_BASE_URL[flavor]}/submissions?base64_encoded=true&wait=true`,
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify(data),
        headers: AUTH_HEADERS,
        success: function (data) {
            const compileOutput = decode(data.compile_output);

            if (compileOutEditor) {
                compileOutEditor.setValue(
                    compileOutput ? compileOutput : "Compilation successful."
                );
            }

            if (runOutEditor) {
                runOutEditor.setValue("");
            }

            highlightErrorLines(compileOutput);
            $statusLine.html(data.status.description);

            // success only when there is no compile output
            if (!compileOutput) {
                lastCompiledCode = currentCode;
            } else {
                lastCompiledCode = null;
            }

            updateRunButtonState();
        },
        error: function (jqXHR) {
            lastCompiledCode = null;
            updateRunButtonState();
            handleRunError(jqXHR);
        }
    });
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

function run() {
    const currentCode = sourceEditor.getValue().trim();
    const isInterpreted = INTERPRETED_LANGUAGE_IDS.includes(getSelectedLanguageId());

    if (!isInterpreted && (!lastCompiledCode || currentCode !== lastCompiledCode)) {
        updateRunButtonState();
        return;
    }

    $runBtn.addClass("loading");

    //stdoutEditor.setValue("");
    if (compileOutEditor) compileOutEditor.setValue("");
    if (runOutEditor) runOutEditor.setValue("");
    $statusLine.html("");

    /*let x = layout.root.getItemsById("runOut")[0];
    x.parent.header.parent.setActiveContentItem(x);*/

    const runtimeTab = layout.root.getItemsById("runOut")[0];
    if (runtimeTab && runtimeTab.parent && runtimeTab.parent.header && runtimeTab.parent.header.parent) {
        runtimeTab.parent.header.parent.setActiveContentItem(runtimeTab);
    }

    let sourceValue = encode(sourceEditor.getValue());
    let stdinValue = encode(stdinEditor.getValue());
    let languageId = getSelectedLanguageId();
    let compilerOptions = $compilerOptions.val();
    let commandLineArguments = $commandLineArguments.val();

    let flavor = getSelectedLanguageFlavor();

    if (languageId === 44) {
        sourceValue = sourceEditor.getValue();
    }

    let data = {
        source_code: sourceValue,
        language_id: languageId,
        stdin: stdinValue,
        compiler_options: compilerOptions,
        command_line_arguments: commandLineArguments,
        redirect_stderr_to_stdout: true
    };

    let sendRequest = function (data) {
        window.top.postMessage(JSON.parse(JSON.stringify({
            event: "preExecution",
            source_code: sourceEditor.getValue(),
            language_id: languageId,
            flavor: flavor,
            stdin: stdinEditor.getValue(),
            compiler_options: compilerOptions,
            command_line_arguments: commandLineArguments
        })), "*");

        timeStart = performance.now();
        $.ajax({
            url: `${AUTHENTICATED_BASE_URL[flavor]}/submissions?base64_encoded=true&wait=false`,
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify(data),
            headers: AUTH_HEADERS,
            success: function (data, textStatus, request) {
                console.log(`Your submission token is: ${data.token}`);
                let region = request.getResponseHeader('X-Judge0-Region');
                setTimeout(fetchSubmission.bind(null, flavor, region, data.token, 1), INITIAL_WAIT_TIME_MS);
            },
            error: handleRunError
        });
    }

    if (languageId === 82) {
        if (!sqliteAdditionalFiles) {
            $.ajax({
                url: `./data/additional_files_zip_base64.txt`,
                contentType: "text/plain",
                success: function (responseData) {
                    sqliteAdditionalFiles = responseData;
                    data["additional_files"] = sqliteAdditionalFiles;
                    sendRequest(data);
                },
                error: handleRunError
            });
        }
        else {
            data["additional_files"] = sqliteAdditionalFiles;
            sendRequest(data);
        }
    } else {
        sendRequest(data);
    }
}

function fetchSubmission(flavor, region, submission_token, iteration) {
    if (iteration >= MAX_PROBE_REQUESTS) {
        handleRunError({
            statusText: "Maximum number of probe requests reached.",
            status: 504
        }, null, null);
        return;
    }

    $.ajax({
        url: `${UNAUTHENTICATED_BASE_URL[flavor]}/submissions/${submission_token}?base64_encoded=true`,
        headers: {
            "X-Judge0-Region": region
        },
        success: function (data) {
            if (data.status.id <= 2) { // In Queue or Processing
                $statusLine.html(data.status.description);
                setTimeout(fetchSubmission.bind(null, flavor, region, submission_token, iteration + 1), WAIT_TIME_FUNCTION(iteration));
            } else {
                handleResult(data);
            }
        },
        error: handleRunError
    });
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
  selectLanguageForExtension(name.split(".").pop());
  updateSourceTabTitle();
}

/*function setSourceCodeName(name) {
    $(".lm_title")[0].innerText = name;
}*/

/*function getSourceCodeName() {
    return $(".lm_title")[0].innerText;
}*/

function newFile(filename) {
    clear();
    suppressDirty = true;
    sourceEditor.setValue("");
    suppressDirty = false;

    selectLanguageForExtension(filename.split(".").pop());
    setSourceCodeName(filename);

    hasUnsavedChanges = false;
    updateSourceTabTitle();

    // Clear saved source so refresh starts fresh with the new file
    try { localStorage.removeItem("judge0.sourceCode"); } catch (e) {}
}

function openFile(content, filename) {
    suppressDirty = true;                 // prevent dirty flag during load
    clear();

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
  FileManager.saveActiveFile(content);

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
    document.getElementById("open-file-input").click();
}

async function saveAction() {
    saveFile(sourceEditor.getValue(), currentFileName);
}

function setFontSizeForAllEditors(fontSize) {
    // Apply to all open source editor tabs
    Object.values(window.sourceEditors).forEach(ed => {
        if (ed) ed.updateOptions({ fontSize });
    });
    if (stdinEditor) stdinEditor.updateOptions({ fontSize });
    if (stdoutEditor) stdoutEditor.updateOptions({ fontSize });
    if (compileOutEditor) compileOutEditor.updateOptions({ fontSize });
    if (runOutEditor) runOutEditor.updateOptions({ fontSize });
}

async function loadLangauges() {
    // Only allow Java, C, and Python from available backend languages
    var ALLOWED_CE_LANGUAGES = [62, 50, 71];     // Java (OpenJDK 13.0.1), C (GCC 9.2.0), Python (3.8.1)
    var ALLOWED_EXTRA_CE_LANGUAGES = [];

    return new Promise((resolve, reject) => {
        let options = [];

        $.ajax({
            url: UNAUTHENTICATED_CE_BASE_URL + "/languages",
            success: function (data) {
                for (let i = 0; i < data.length; i++) {
                    let language = data[i];
                    // Only add allowed CE languages
                    if (!ALLOWED_CE_LANGUAGES.includes(language.id)) {
                        continue;
                    }
                    let option = new Option(language.name, language.id);
                    option.setAttribute("flavor", CE);
                    option.setAttribute("langauge_mode", getEditorLanguageMode(language.name));

                    //if (language.id !== 89) {
                        options.push(option);
                    //}

                    if (language.id === DEFAULT_LANGUAGE_ID) {
                        option.selected = true;
                    }
                }
            },
            error: reject
        }).always(function () {
            $.ajax({
                url: UNAUTHENTICATED_EXTRA_CE_BASE_URL + "/languages",
                success: function (data) {
                    for (let i = 0; i < data.length; i++) {
                        let language = data[i];
                        // Only add allowed Extra CE languages
                        if (!ALLOWED_EXTRA_CE_LANGUAGES.includes(language.id)) {
                            continue;
                        }
                        let option = new Option(language.name, language.id);
                        option.setAttribute("flavor", EXTRA_CE);
                        option.setAttribute("langauge_mode", getEditorLanguageMode(language.name));

                        //if (options.findIndex((t) => (t.text === option.text)) === -1 && language.id !== 89) {
                            options.push(option);
                        //}
                    }
                },
                error: reject
            }).always(function () {
                options.sort((a, b) => a.text.localeCompare(b.text));
                $selectLanguage.append(options);
                $selectLanguage.parent(".ui.dropdown").dropdown("refresh");
                resolve();
            });
        });
    });
};

// Languages that are interpreted and do not need a separate compile step
const INTERPRETED_LANGUAGE_IDS = [71]; // Python (3.8.1)

function updateCompileButtonVisibility() {
    let languageId = getSelectedLanguageId();
    if (INTERPRETED_LANGUAGE_IDS.includes(languageId)) {
        $compileBtn.hide();
    } else {
        $compileBtn.show();
    }
}

async function loadSelectedLanguage(skipSetDefaultSourceCodeName = false) {
    if (!sourceEditor) {
        console.warn("Editor not initialized yet");
        return;
    }
    monaco.editor.setModelLanguage(sourceEditor.getModel(), $selectLanguage.find(":selected").attr("langauge_mode"));
    if (!skipSetDefaultSourceCodeName) {
        setSourceCodeName((await getSelectedLanguage()).source_file);
    }
    updateCompileButtonVisibility();
}

function selectLanguageByFlavorAndId(languageId, flavor) {
    let option = $selectLanguage.find(`[value=${languageId}][flavor=${flavor}]`);
    if (option.length) {
        option.prop("selected", true);
        $selectLanguage.trigger("change", { skipSetDefaultSourceCodeName: true });
    }
}

function selectLanguageForExtension(extension) {
    let language = getLanguageForExtension(extension);
    selectLanguageByFlavorAndId(language.language_id, language.flavor);
}

async function getLanguage(flavor, languageId) {
    return new Promise((resolve, reject) => {
        if (languages[flavor] && languages[flavor][languageId]) {
            resolve(languages[flavor][languageId]);
            return;
        }

        $.ajax({
            url: `${UNAUTHENTICATED_BASE_URL[flavor]}/languages/${languageId}`,
            success: function (data) {
                if (!languages[flavor]) {
                    languages[flavor] = {};
                }

                languages[flavor][languageId] = data;
                resolve(data);
            },
            error: reject
        });
    });
}

function setDefaults() {
    setFontSizeForAllEditors(fontSize);

    // Source editor content is now loaded by the source component itself.
    // Just initialize the other editors.

    stdinEditor.setValue(DEFAULT_STDIN);
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
        let skipSetDefaultSourceCodeName = (data && data.skipSetDefaultSourceCodeName) || !!gPuterFile;
        loadSelectedLanguage(skipSetDefaultSourceCodeName);

        // Persist selected language to localStorage
        try {
            localStorage.setItem("judge0.languageId", getSelectedLanguageId());
            localStorage.setItem("judge0.languageFlavor", getSelectedLanguageFlavor());
        } catch (e) {}
    });

    await loadLangauges();

    // Restore saved language or default to Java
    var savedLangId = localStorage.getItem("judge0.languageId");
    var savedLangFlavor = localStorage.getItem("judge0.languageFlavor");
    if (savedLangId && savedLangFlavor) {
        selectLanguageByFlavorAndId(parseInt(savedLangId), savedLangFlavor);
    } else {
        const JAVA_ID = "91";
        $selectLanguage.parent(".ui.dropdown").dropdown("set selected", JAVA_ID);
    }
    loadSelectedLanguage(true);

    $compilerOptions = $("#compiler-options");
    $commandLineArguments = $("#command-line-arguments");

    $runBtn = $("#run-btn");
    updateRunButtonState();

    $clearBtn = $("#clear-btn");
    $compileBtn = $("#compile-btn");
    $runBtn.click(run);
    $clearBtn.click(clearIO);
    $compileBtn.click(compileOnly);

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

            // Set initial content if parsed dynamically via file_explorer open callbacks
            if (state.initialContent !== undefined) {
                editor.setValue(state.initialContent);
            }

            let fileId = state.fileId;
            if (!fileId) {
                // If it is the default first tab generated implicitly by Golden Layout's config tree
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

                // Get the canonical file name from the VFS
                let vfsFile = FileManager.findFile(fileId, FileManager.tree);
                if (vfsFile) {
                    currentFileName = vfsFile.name;
                } else {
                    currentFileName = container._config.title;
                }
                selectLanguageForExtension(currentFileName.split(".").pop());

                // Sync sidebar selection
                FileManager.activeFileId = fileId;
                let parentId = FileManager.findParentFolderId(fileId, FileManager.tree);
                if (parentId) {
                    FileManager.activeFolderId = parentId;
                }
                FileManager.render();

                // Reattach vim to the newly active editor
                try {
                    if (window.__vimHelpers) window.__vimHelpers.reattach();
                } catch(e) {}
            });

            container.on("destroy", () => {
                // Save content before disposing
                try {
                    let file = FileManager.findFile(fileId, FileManager.tree);
                    if (file) {
                        file.content = editor.getValue();
                        FileManager.saveWorkspace();
                    }
                } catch (e) {}
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
                if (suppressDirty) return;   // ignore changes caused by setValue/openFile/init
                hasUnsavedChanges = true;
                updateSourceTabTitle();
                scheduleAutosave();         // schedule an autosave after user stops typing for a bit

                // Persist source code to localStorage
                try { localStorage.setItem("judge0.sourceCode", editor.getValue()); } catch (e) {}
                if (fileId !== "default") {
                    try { FileManager.saveActiveFile(editor.getValue()); } catch (e) {}
                }
            });

             // After initial editor setup/content load finishes, mark file as clean and enable dirty tracking
            setTimeout(function () {
                hasUnsavedChanges = false;
                suppressDirty = false;
                updateSourceTabTitle();
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

        layout.registerComponent("stdin", function (container, state) {
            var el = container.getElement()[0];

            // Add placeholder overlay for stdin
            var placeholder = document.createElement("div");
            placeholder.className = "stdin-placeholder";
            placeholder.textContent = "Enter input for your program here (e.g. values read by stdin)";
            placeholder.style.cssText = "position:absolute;top:0;color:#888;pointer-events:none;z-index:1;padding:2px 0;font-family:'JetBrains Mono',monospace;";
            el.style.position = "relative";
            el.appendChild(placeholder);

            stdinEditor = monaco.editor.create(el, {
                automaticLayout: true,
                scrollBeyondLastLine: false,
                readOnly: state.readOnly,
                language: "plaintext",
                minimap: {
                    enabled: false
                }
            });

            // Sync placeholder position and size with editor gutter/font
            function updatePlaceholderPosition() {
                var layoutInfo = stdinEditor.getLayoutInfo();
                var opts = stdinEditor.getOptions();
                var currentFontSize = opts.get(monaco.editor.EditorOption.fontSize);
                placeholder.style.left = layoutInfo.contentLeft + "px";
                placeholder.style.fontSize = currentFontSize + "px";
                placeholder.style.lineHeight = stdinEditor.getOption(monaco.editor.EditorOption.lineHeight) + "px";
            }
            stdinEditor.onDidLayoutChange(updatePlaceholderPosition);
            updatePlaceholderPosition();

            // Show/hide placeholder based on content
            function togglePlaceholder() {
                placeholder.style.display = stdinEditor.getValue() ? "none" : "block";
            }
            stdinEditor.onDidChangeModelContent(togglePlaceholder);
            togglePlaceholder();
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



        layout.on("initialised", function () {
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
            if (stdinEditor) stdinEditor.updateOptions({ wordWrap: wrapSetting });
            if (compileOutEditor) compileOutEditor.updateOptions({ wordWrap: wrapSetting });
            if (runOutEditor) runOutEditor.updateOptions({ wordWrap: wrapSetting });
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

    // Font size toolbar controls
    var $fontDisplay = document.getElementById("font-size-display");
    function updateFontDisplay() {
        $fontDisplay.textContent = fontSize + "px";
        try { localStorage.setItem("judge0.fontSize", fontSize); } catch (e) {}
    }
    // Restore saved font size
    var savedFontSize = localStorage.getItem("judge0.fontSize");
    if (savedFontSize) {
        fontSize = parseInt(savedFontSize);
    }
    updateFontDisplay();

    document.getElementById("font-decrease-btn").addEventListener("click", function () {
        if (fontSize > 8) {
            fontSize -= 1;
            setFontSizeForAllEditors(fontSize);
            updateFontDisplay();
        }
    });
    document.getElementById("font-increase-btn").addEventListener("click", function () {
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
        if (stdinEditor) stdinEditor.updateOptions({ wordWrap: setting });
        if (compileOutEditor) compileOutEditor.updateOptions({ wordWrap: setting });
        if (runOutEditor) runOutEditor.updateOptions({ wordWrap: setting });
        if (wordWrapEnabled) {
            $wordWrapBtn.classList.add("active");
        } else {
            $wordWrapBtn.classList.remove("active");
        }
        try { localStorage.setItem("judge0.wordWrap", setting); } catch (e) {}
    }
    $wordWrapBtn.addEventListener("click", function () {
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
            if (e.data.language_id && e.data.flavor) {
                selectLanguageByFlavorAndId(e.data.language_id, e.data.flavor);
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
            if (e.data.api_key) {
                AUTH_HEADERS["Authorization"] = `Bearer ${e.data.api_key}`;
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

const DEFAULT_STDIN = "";

const DEFAULT_COMPILER_OPTIONS = "";
const DEFAULT_CMD_ARGUMENTS = "";
const DEFAULT_LANGUAGE_ID = 62; // Java (OpenJDK 13.0.1)

function getEditorLanguageMode(languageName) {
    const DEFAULT_EDITOR_LANGUAGE_MODE = "plaintext";
    const LANGUAGE_NAME_TO_LANGUAGE_EDITOR_MODE = {
        "Bash": "shell",
        "C": "c",
        "C3": "c",
        "C#": "csharp",
        "C++": "cpp",
        "Clojure": "clojure",
        "F#": "fsharp",
        "Go": "go",
        "Java": "java",
        "JavaScript": "javascript",
        "Kotlin": "kotlin",
        "Objective-C": "objective-c",
        "Pascal": "pascal",
        "Perl": "perl",
        "PHP": "php",
        "Python": "python",
        "R": "r",
        "Ruby": "ruby",
        "SQL": "sql",
        "Swift": "swift",
        "TypeScript": "typescript",
        "Visual Basic": "vb"
    }

    for (let key in LANGUAGE_NAME_TO_LANGUAGE_EDITOR_MODE) {
        if (languageName.toLowerCase().startsWith(key.toLowerCase())) {
            return LANGUAGE_NAME_TO_LANGUAGE_EDITOR_MODE[key];
        }
    }
    return DEFAULT_EDITOR_LANGUAGE_MODE;
}

const EXTENSIONS_TABLE = {
    "java": { "flavor": CE, "language_id": 62 }, // Java (OpenJDK 13.0.1)
    "c": { "flavor": CE, "language_id": 50 }, // C (GCC 9.2.0)
    "py": { "flavor": CE, "language_id": 71 }, // Python (3.8.1)
    "txt": { "flavor": CE, "language_id": 43 }, // Plain Text
};

function getLanguageForExtension(extension) {
    return EXTENSIONS_TABLE[extension] || { "flavor": CE, "language_id": 43 }; // Plain Text (https://ce.judge0.com/languages/43)
}
