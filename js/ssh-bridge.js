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

// SSH endpoint for sign-in
app.post("/ssh-sign-in", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, error: "Username or password missing" });
  }

  console.log(`[SSH LOGIN ATTEMPT] From ${req.ip}`);

  const conn = new Client();
  let responded = false;

  conn.on("ready", () => {
    console.log(`[SSH LOGIN SUCCESS]`);
    sshSession = conn; // keep the session active for sign-out
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

// List files and folders at a given path
// Returns array of { name, type: "file"|"directory" }
app.post("/ssh-ls", async (req, res) => {
  const dir = req.body.path || "~";

  try {
    // ls -1F appends / to dirs, @ to symlinks, * to executables
    const output = await sshExec(`ls -1aF ${JSON.stringify(dir)}`);
    const entries = output.split("\n").filter(Boolean).map((entry) => {
      if (entry === "./" || entry === "../") return null;

      const isDir = entry.endsWith("/");
      const name = entry.replace(/[/*@=|]$/, ""); // strip type indicators
      return { name, type: isDir ? "directory" : "file" };
    }).filter(Boolean);

    res.json({ success: true, path: dir, entries });
  } catch (err) {
    console.error("[SSH-LS ERROR]", err.message);
    res.json({ success: false, error: err.message });
  }
});

// Read a file's contents
app.post("/ssh-read", async (req, res) => {
  const filePath = req.body.path;

  if (!filePath) {
    return res.json({ success: false, error: "File path is required" });
  }

  try {
    const content = await sshExec(`cat ${JSON.stringify(filePath)}`);
    res.json({ success: true, path: filePath, content });
  } catch (err) {
    console.error("[SSH-READ ERROR]", err.message);
    res.json({ success: false, error: err.message });
  }
});

// Write content to a file
app.post("/ssh-write", async (req, res) => {
  const { path: filePath, content } = req.body;

  if (!filePath) {
    return res.json({ success: false, error: "File path is required" });
  }

  try {
    // Base64 encode to safely handle special characters and newlines
    const encoded = Buffer.from(content || "").toString("base64");
    await sshExec(`echo ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(filePath)}`);
    res.json({ success: true, path: filePath });
  } catch (err) {
    console.error("[SSH-WRITE ERROR]", err.message);
    res.json({ success: false, error: err.message });
  }
});

// Start HTTP server on port 80
http.createServer(app).listen(3000, "127.0.0.1", () => {
  console.log("Server running on http://localhost:3000");
});