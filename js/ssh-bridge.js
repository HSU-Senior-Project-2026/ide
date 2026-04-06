// SSH-server Bridge

const express = require("express");
const { Client } = require("ssh2");
const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");
const path = require("path");

const app = express();

// Judge0 auth token — lives here on the server, never sent to the browser
const JUDGE0_AUTH_TOKEN = "yjjcWNpQGFQMkpmHQasOKegTvGL8yZ1sI4WM7YYkCuVoUwYt";

// Proxy all /judge0/* requests to the Judge0 backend on port 2358
// The browser calls /judge0/languages → this strips /judge0 and forwards to localhost:2358/languages
// The proxy injects the X-Auth-Token header so the browser never needs to know the key
app.use("/judge0", createProxyMiddleware({
  target: "http://35.153.133.130:2358",
  changeOrigin: true,
  pathRewrite: { "^/judge0": "" },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader("X-Auth-Token", JUDGE0_AUTH_TOKEN);
    }
  }
}));

// Enable JSON parsing
app.use(express.json({ limit: "10kb" }));

// Serve frontend static files (index.html, js/, css/) from parent folder
app.use(express.static(path.join(__dirname, "..")));

// Optional: log every request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

// Variable to hold active SSH session
let sshSession = null;
// Cached home directory for the signed-in user
let sshHomeDir = null;

// SSH endpoint for sign-in
app.post("/ssh-sign-in", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, error: "Username or password missing" });
  }

  console.log(`[SSH LOGIN ATTEMPT] From ${req.ip}`);

  const conn = new Client();
  let responded = false;

  conn.on("ready", async () => {
    console.log(`[SSH LOGIN SUCCESS]`);
    sshSession = conn; // keep the session active for sign-out

    // Cache the user's home directory
    try {
      const home = await sshExec("echo $HOME");
      sshHomeDir = home.trim();
      console.log(`[SSH HOME] ${sshHomeDir}`);
    } catch (err) {
      console.error("[SSH HOME ERROR]", err.message);
      sshHomeDir = null;
    }

    if (!responded) {
      responded = true;
      res.json({ success: true, message: "SSH connection established" });
    }
  });

  conn.on("error", (err) => {
    console.log(`[SSH LOGIN FAILED] ${err.message}`);
    if (!responded) {
      responded = true;
      res.json({ success: false, error: "SSH connection failed: " + err.message });
    }
  });

  conn.connect({
    host: "csci.hsutx.edu",
    port: 22,
    username,
    password,
    readyTimeout: 10000,
  });
});

// SSH endpoint for sign-out
app.post("/ssh-sign-out", (req, res) => {
  console.log("Sign-out request received:", req.body);

  if (sshSession) {
    try {
      sshSession.end(); // safely close SSH session
      sshSession = null;
      sshHomeDir = null;
      return res.json({ success: true, message: "SSH session closed" });
    } catch (err) {
      console.error("Error closing SSH session:", err);
      return res.status(500).json({ success: false, message: "Failed to close SSH session" });
    }
  } else {
    return res.status(400).json({ success: false, message: "No active SSH session" });
  }
});

// Helper: run a command on the active SSH session and return stdout
function sshExec(command) {
  return new Promise((resolve, reject) => {
    if (!sshSession) return reject(new Error("No active SSH session"));

    sshSession.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = "";
      let stderr = "";

      stream.on("data", (data) => { stdout += data.toString(); });
      stream.stderr.on("data", (data) => { stderr += data.toString(); });
      stream.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || `Exit code ${code}`));
        resolve(stdout);
      });
    });
  });
}

// Resolve a path (expanding ~ to home dir) and ensure it stays within the home directory.
// Returns the resolved absolute path, or throws if the path is outside the home dir.
async function validatePath(inputPath) {
  if (!sshHomeDir) throw new Error("Home directory not resolved");

  // Replace leading ~ with the home directory
  let resolved = inputPath.replace(/^~/, sshHomeDir);

  // Use the server-side realpath to resolve symlinks and .. segments
  // Fall back to manual normalization if realpath fails (e.g. path doesn't exist yet)
  try {
    resolved = (await sshExec(`realpath -m ${JSON.stringify(resolved)}`)).trim();
  } catch {
    resolved = path.posix.normalize(resolved);
  }

  // Ensure the resolved path is within (or equal to) the home directory
  if (resolved !== sshHomeDir && !resolved.startsWith(sshHomeDir + "/")) {
    throw new Error("Access denied: path is outside your home directory");
  }

  return resolved;
}

// Parse a `ls -laF` permission string and return { readable, writable } for the owner
function parsePermissions(permStr) {
  // permStr looks like "drwxr-xr-x" (10 chars)
  // Owner permissions are chars 1-3
  return {
    readable: permStr.charAt(1) === "r",
    writable: permStr.charAt(2) === "w",
  };
}

// List files and folders at a given path
// Returns array of { name, type, readable, writable }
app.post("/ssh-ls", async (req, res) => {
  const dir = req.body.path || "~";

  try {
    const resolvedDir = await validatePath(dir);
    const isHome = resolvedDir === sshHomeDir;

    // ls -laF gives us permissions + type indicators
    const output = await sshExec(`ls -laF ${JSON.stringify(resolvedDir)}`);
    const lines = output.split("\n").filter(Boolean);

    const entries = [];
    for (const line of lines) {
      // Skip the "total N" line
      if (line.startsWith("total ")) continue;

      // Parse ls -la output: perms links owner group size date name
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const permStr = parts[0];
      // Name is everything from column 9 onward (handles spaces in names)
      const rawName = parts.slice(8).join(" ");

      // Skip current directory entry
      if (rawName === "./" || rawName === ".") continue;

      // Handle ".." — include it so the frontend can navigate up
      if (rawName === "../" || rawName === "..") {
        if (!isHome) {
          entries.unshift({ name: "..", type: "directory", readable: true, writable: false });
        }
        continue;
      }

      const isDir = rawName.endsWith("/");
      const name = rawName.replace(/[/*@=|]$/, "");
      const { readable, writable } = parsePermissions(permStr);

      entries.push({ name, type: isDir ? "directory" : "file", readable, writable });
    }

    res.json({ success: true, path: resolvedDir, isHome, entries });
  } catch (err) {
    console.error("[SSH-LS ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Read a file's contents
app.post("/ssh-read", async (req, res) => {
  const filePath = req.body.path;

  if (!filePath) {
    return res.json({ success: false, error: "File path is required" });
  }

  try {
    const resolvedPath = await validatePath(filePath);
    const content = await sshExec(`cat ${JSON.stringify(resolvedPath)}`);
    res.json({ success: true, path: resolvedPath, content });
  } catch (err) {
    console.error("[SSH-READ ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Write content to a file
app.post("/ssh-write", async (req, res) => {
  const { path: filePath, content } = req.body;

  if (!filePath) {
    return res.json({ success: false, error: "File path is required" });
  }

  try {
    const resolvedPath = await validatePath(filePath);
    // Base64 encode to safely handle special characters and newlines
    const encoded = Buffer.from(content || "").toString("base64");
    await sshExec(`echo ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(resolvedPath)}`);
    res.json({ success: true, path: resolvedPath });
  } catch (err) {
    console.error("[SSH-WRITE ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Create a directory
app.post("/ssh-mkdir", async (req, res) => {
  const dirPath = req.body.path;
  if (!dirPath) {
    return res.json({ success: false, error: "Path is required" });
  }

  try {
    const resolvedPath = await validatePath(dirPath);
    await sshExec(`mkdir ${JSON.stringify(resolvedPath)}`);
    res.json({ success: true, path: resolvedPath });
  } catch (err) {
    console.error("[SSH-MKDIR ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Rename / move a file or folder
app.post("/ssh-mv", async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    return res.json({ success: false, error: "Both 'from' and 'to' paths are required" });
  }

  try {
    const resolvedFrom = await validatePath(from);
    const resolvedTo = await validatePath(to);
    await sshExec(`mv ${JSON.stringify(resolvedFrom)} ${JSON.stringify(resolvedTo)}`);
    res.json({ success: true, from: resolvedFrom, to: resolvedTo });
  } catch (err) {
    console.error("[SSH-MV ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Delete a single file or empty folder
app.post("/ssh-rm", async (req, res) => {
  const filePath = req.body.path;
  if (!filePath) {
    return res.json({ success: false, error: "Path is required" });
  }

  try {
    const resolvedPath = await validatePath(filePath);

    // Determine if it's a directory — if so, use rmdir (only removes empty dirs)
    const fileType = (await sshExec(`stat -c %F ${JSON.stringify(resolvedPath)}`)).trim();
    if (fileType === "directory") {
      await sshExec(`rmdir ${JSON.stringify(resolvedPath)}`);
    } else {
      await sshExec(`rm ${JSON.stringify(resolvedPath)}`);
    }

    res.json({ success: true, path: resolvedPath });
  } catch (err) {
    console.error("[SSH-RM ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Per-user settings — stored as ~/.judge0-settings.json on the SSH server
const SETTINGS_FILE = "~/.judge0-settings.json";

app.post("/user-settings", async (req, res) => {
  const { action, settings } = req.body;

  if (!sshSession) {
    return res.json({ success: false, error: "Not signed in" });
  }

  try {
    if (action === "load") {
      // Read the settings file; return empty object if it doesn't exist
      const output = await sshExec(`cat ${SETTINGS_FILE} 2>/dev/null || echo "{}"`);
      const parsed = JSON.parse(output.trim());
      res.json({ success: true, settings: parsed });
    } else if (action === "save") {
      if (!settings || typeof settings !== "object") {
        return res.json({ success: false, error: "Invalid settings payload" });
      }
      const encoded = Buffer.from(JSON.stringify(settings, null, 2)).toString("base64");
      await sshExec(`echo ${JSON.stringify(encoded)} | base64 -d > ${SETTINGS_FILE}`);
      res.json({ success: true });
    } else {
      res.json({ success: false, error: "Unknown action. Use 'load' or 'save'." });
    }
  } catch (err) {
    console.error("[USER-SETTINGS ERROR]", err.message);
    res.json({ success: false, error: err.message });
  }
});

// Start HTTP server on port 80
http.createServer(app).listen(3000, "127.0.0.1", () => {
  console.log("Server running on http://localhost:3000");
});