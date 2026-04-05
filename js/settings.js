var isMac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);

var RESERVED_KEYS_MAC = [
    "Cmd+Q (Quit browser)",
    "Cmd+W (Close tab)",
    "Cmd+T (New tab)",
    "Cmd+N (New window)",
    "Cmd+L (Focus address bar)",
    "Cmd+Shift+T (Reopen closed tab)",
    "Cmd+Shift+N (Private window)",
    "Cmd+R (Reload page)",
    "Cmd+, (Browser settings)"
];

var RESERVED_KEYS_WIN = [
    "Ctrl+W (Close tab)",
    "Ctrl+T (New tab)",
    "Ctrl+N (New window)",
    "Ctrl+L (Focus address bar)",
    "Ctrl+Shift+T (Reopen closed tab)",
    "Ctrl+Shift+N (Private window)",
    "Ctrl+R (Reload page)",
    "Alt+F4 (Close window)",
    "F11 (Fullscreen)"
];

// Load saved mappings from localStorage
function loadMappings() {
    try {
        var raw = localStorage.getItem("judge0.vimMappings");
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
}

function saveMappings(mappings) {
    try {
        localStorage.setItem("judge0.vimMappings", JSON.stringify(mappings));
    } catch (e) {}
}

function loadEscTimeout() {
    try {
        var val = localStorage.getItem("judge0.vimEscTimeout");
        if (val) return parseInt(val, 10);
    } catch (e) {}
    return 200;
}

function saveEscTimeout(val) {
    try {
        localStorage.setItem("judge0.vimEscTimeout", String(val));
    } catch (e) {}
}

// Apply all saved vim settings via the vim helpers exposed by ide.js
function applyVimSettings() {
    var helpers = window.__vimHelpers;
    if (!helpers || !helpers.getVimAPI) return;
    var Vim = helpers.getVimAPI();
    if (!Vim) return;

    // Apply escape timeout
    var timeout = loadEscTimeout();
    Vim.setOption("insertModeEscKeysTimeout", timeout);

    // Clear previous custom mappings then re-apply
    var mappings = loadMappings();
    mappings.forEach(function (m) {
        if (m.type === "noremap") {
            Vim.noremap(m.from, m.to, m.mode);
        } else {
            Vim.map(m.from, m.to, m.mode);
        }
    });
}

// Build a mapping table row
function createMappingRow(tbody, mapping) {
    var tr = document.createElement("tr");

    var tdFrom = document.createElement("td");
    var inputFrom = document.createElement("input");
    inputFrom.type = "text";
    inputFrom.value = mapping.from || "";
    inputFrom.placeholder = "jk";
    tdFrom.appendChild(inputFrom);

    var tdTo = document.createElement("td");
    var inputTo = document.createElement("input");
    inputTo.type = "text";
    inputTo.value = mapping.to || "";
    inputTo.placeholder = "<Esc>";
    tdTo.appendChild(inputTo);

    var tdMode = document.createElement("td");
    var selectMode = document.createElement("select");
    ["normal", "insert", "visual"].forEach(function (mode) {
        var opt = document.createElement("option");
        opt.value = mode;
        opt.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        if (mapping.mode === mode) opt.selected = true;
        selectMode.appendChild(opt);
    });
    tdMode.appendChild(selectMode);

    var tdType = document.createElement("td");
    var selectType = document.createElement("select");
    ["map", "noremap"].forEach(function (type) {
        var opt = document.createElement("option");
        opt.value = type;
        opt.textContent = type;
        if (mapping.type === type) opt.selected = true;
        selectType.appendChild(opt);
    });
    tdType.appendChild(selectType);

    var tdDel = document.createElement("td");
    var delBtn = document.createElement("button");
    delBtn.className = "vim-mapping-delete";
    delBtn.textContent = "\u00D7";
    delBtn.title = "Remove mapping";
    delBtn.addEventListener("click", function () {
        tr.remove();
        saveMappingsFromTable();
        applyVimSettings();
    });
    tdDel.appendChild(delBtn);

    tr.appendChild(tdFrom);
    tr.appendChild(tdTo);
    tr.appendChild(tdMode);
    tr.appendChild(tdType);
    tr.appendChild(tdDel);

    // Auto-save on change
    [inputFrom, inputTo, selectMode, selectType].forEach(function (el) {
        el.addEventListener("change", function () {
            saveMappingsFromTable();
            applyVimSettings();
        });
    });

    tbody.appendChild(tr);
}

// Read current table state and persist
function saveMappingsFromTable() {
    var tbody = document.getElementById("vim-keymaps-body");
    var rows = tbody.querySelectorAll("tr");
    var mappings = [];
    rows.forEach(function (row) {
        var inputs = row.querySelectorAll("input[type='text']");
        var selects = row.querySelectorAll("select");
        var from = inputs[0] ? inputs[0].value.trim() : "";
        var to = inputs[1] ? inputs[1].value.trim() : "";
        var mode = selects[0] ? selects[0].value : "normal";
        var type = selects[1] ? selects[1].value : "map";
        if (from && to) {
            mappings.push({ from: from, to: to, mode: mode, type: type });
        }
    });
    saveMappings(mappings);
}

export function init({ onRefreshLayout }) {
    var closeBtn = document.getElementById("settings-close");
    var vimToggle = document.getElementById("settings-vim-toggle");
    var vimStatus = document.getElementById("vim-toggle-status");
    var vimConfigSection = document.getElementById("vim-config-section");
    var escTimeoutInput = document.getElementById("vim-esc-timeout");
    var addMappingBtn = document.getElementById("vim-add-mapping");
    var keymapsBody = document.getElementById("vim-keymaps-body");
    var reservedKeysEl = document.getElementById("vim-reserved-keys");
    var categories = document.querySelectorAll(".settings-category");
    var sections = document.querySelectorAll(".settings-section");

    // Category switching
    categories.forEach(function (cat) {
        cat.addEventListener("click", function () {
            var target = this.getAttribute("data-category");
            categories.forEach(function (c) { c.classList.remove("active"); });
            this.classList.add("active");
            sections.forEach(function (sec) {
                if (sec.getAttribute("data-section") === target) {
                    sec.classList.remove("judge0-hidden");
                } else {
                    sec.classList.add("judge0-hidden");
                }
            });
        });
    });

    // Populate browser-reserved keys warning based on platform
    var reservedList = isMac ? RESERVED_KEYS_MAC : RESERVED_KEYS_WIN;
    reservedKeysEl.textContent = "These shortcuts are intercepted by the browser and cannot be remapped: " + reservedList.join(", ") + ".";

    // Sync VIM toggle with existing state
    var vimEnabled = localStorage.getItem("judge0.vimMode") === "on";
    vimToggle.checked = vimEnabled;
    vimStatus.textContent = vimEnabled ? "On" : "Off";
    if (vimEnabled) {
        vimConfigSection.classList.remove("judge0-hidden");
    }

    // VIM toggle
    vimToggle.addEventListener("change", function () {
        var enabled = this.checked;
        vimStatus.textContent = enabled ? "On" : "Off";

        if (enabled) {
            vimConfigSection.classList.remove("judge0-hidden");
        } else {
            vimConfigSection.classList.add("judge0-hidden");
        }

        // Sync with ide.js vim state
        try { localStorage.setItem("judge0.vimMode", enabled ? "on" : "off"); } catch (e) {}
        if (window.__vimHelpers && window.__vimHelpers.toggle) {
            window.__vimHelpers.toggle(enabled);
        }

        // Sync the toolbar VIM button appearance
        var vimBtn = document.getElementById("vim-toggle-btn");
        if (vimBtn) {
            vimBtn.style.opacity = enabled ? "1" : "0.6";
            vimBtn.style.color = enabled ? "#4ec9b0" : "";
        }

        if (enabled) {
            applyVimSettings();
        }
    });

    // Escape timeout
    escTimeoutInput.value = loadEscTimeout();
    escTimeoutInput.addEventListener("change", function () {
        var val = parseInt(this.value, 10);
        if (isNaN(val) || val < 50) val = 50;
        if (val > 2000) val = 2000;
        this.value = val;
        saveEscTimeout(val);
        applyVimSettings();
    });

    // Load existing mappings into table
    var savedMappings = loadMappings();
    savedMappings.forEach(function (m) {
        createMappingRow(keymapsBody, m);
    });

    // Add mapping button
    addMappingBtn.addEventListener("click", function () {
        createMappingRow(keymapsBody, { from: "", to: "", mode: "insert", type: "noremap" });
    });

    // Close button
    closeBtn.addEventListener("click", function () {
        hide();
        var settingsIcon = document.querySelector('.activity-icon[data-panel="settings"]');
        if (settingsIcon) settingsIcon.classList.remove("active");
        if (onRefreshLayout) onRefreshLayout();
    });

    // Apply settings on init if vim is already active
    if (vimEnabled) {
        // Delay slightly to let ide.js finish initializing vim
        setTimeout(applyVimSettings, 500);
    }

    // Expose so ide.js can call after vim reinit
    window.__vimSettingsApply = applyVimSettings;
}

// Sync the settings toggle when vim is toggled from the toolbar button
export function syncToggle() {
    var vimToggle = document.getElementById("settings-vim-toggle");
    var vimStatus = document.getElementById("vim-toggle-status");
    var vimConfigSection = document.getElementById("vim-config-section");
    var enabled = localStorage.getItem("judge0.vimMode") === "on";
    if (vimToggle) vimToggle.checked = enabled;
    if (vimStatus) vimStatus.textContent = enabled ? "On" : "Off";
    if (vimConfigSection) {
        if (enabled) {
            vimConfigSection.classList.remove("judge0-hidden");
        } else {
            vimConfigSection.classList.add("judge0-hidden");
        }
    }
}

export function show() {
    var settingsPanel = document.getElementById("judge0-settings-panel");
    var sidebar = document.getElementById("judge0-sidebar");
    settingsPanel.classList.remove("judge0-hidden");
    sidebar.classList.add("collapsed");
}

export function hide() {
    var settingsPanel = document.getElementById("judge0-settings-panel");
    settingsPanel.classList.add("judge0-hidden");
}

export function isVisible() {
    var settingsPanel = document.getElementById("judge0-settings-panel");
    return !settingsPanel.classList.contains("judge0-hidden");
}
