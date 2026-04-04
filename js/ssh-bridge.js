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
  target: "http://localhost:2358",//"http://192.168.56.101:2358",
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

// Store SSH sessions per user instead of one global session
const sshSessions = {};

// SSH endpoint for sign-in
app.post("/ssh-sign-in", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, error: "Username or password missing" });
  }

  console.log(`[SSH LOGIN ATTEMPT] From ${req.ip} → username: ${username}`);

  const conn = new Client();
  let responded = false;

  conn.on("ready", () => {
    console.log(`[SSH LOGIN SUCCESS] username: ${username}`);
    sshSessions[username] = conn; // keep the session active for sign-out, Save this user's SSH session using their username as the key
    if (!responded) {
      responded = true;
      res.json({ success: true, message: "SSH connection established" });
    }
  });

  conn.on("error", (err) => {
    console.log(`[SSH LOGIN FAILED] username: ${username} → ${err.message}`);
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

// File listing endpoint
// Uses the logged-in user's SSH session to access their current server directory
// For now, this is a simple test route to confirm that:
// 1. the user has an active SSH session
// 2. we can execute commands through that session
// 3. we can see the files available in that user's directory
app.get("/list-files", (req, res) => {
  const username = req.query.username;

  // Make sure a username was provided
  if (!username) {
    return res.status(400).json({
      success: false,
      error: "Username is required."
    });
  }

  // Look up this user's SSH session
  const userSession = sshSessions[username];

  // If no active SSH session exists, the user must sign in first
  if (!userSession) {
    return res.status(401).json({
      success: false,
      error: "No active SSH session found for this user. Please sign in first."
    });
  }

  // Run a simple command on the server:
  // - pwd shows the current directory
  // - ls -la lists all files, including hidden ones, with details
  userSession.exec("pwd && ls -la", (err, stream) => {
    if (err) {
      console.error(`[LIST FILES ERROR] ${username}:`, err);
      return res.status(500).json({
        success: false,
        error: "Failed to execute file listing command."
      });
    }

    let output = "";
    let errorOutput = "";

    stream.on("data", (data) => {
      output += data.toString();
    });

    stream.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    stream.on("close", () => {
      if (errorOutput) {
        console.error(`[LIST FILES STDERR] ${username}:`, errorOutput);
      }

      return res.json({
        success: true,
        username,
        output
      });
    });
  });
});

// Read file endpoint
// Reads the contents of a specific file from the user's server directory
app.get("/read-file", (req, res) => {
  const { username, path } = req.query;

  // Validate inputs
  if (!username || !path) {
    return res.status(400).json({
      success: false,
      error: "Username and file path are required."
    });
  }

  const userSession = sshSessions[username];

  // Ensure user is logged in
  if (!userSession) {
    return res.status(401).json({
      success: false,
      error: "No active SSH session. Please sign in first."
    });
  }

  // Use 'cat' to read file contents
  userSession.exec(`cat ${path}`, (err, stream) => {
    if (err) {
      console.error(`[READ FILE ERROR] ${username}:`, err);
      return res.status(500).json({
        success: false,
        error: "Failed to read file."
      });
    }

    let output = "";
    let errorOutput = "";

    stream.on("data", (data) => {
      output += data.toString();
    });

    stream.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    stream.on("close", () => {
      if (errorOutput) {
        return res.status(400).json({
          success: false,
          error: errorOutput
        });
      }

      return res.json({
        success: true,
        path,
        content: output
      });
    });
  });
});

// Write file endpoint
// Saves (or overwrites) a file in the user's server directory
app.post("/write-file", (req, res) => {
  const { username, path, content } = req.body;

  // Validate inputs
  if (!username || !path || content === undefined) {
    return res.status(400).json({
      success: false,
      error: "Username, file path, and content are required."
    });
  }

  const userSession = sshSessions[username];

  // Ensure user is logged in
  if (!userSession) {
    return res.status(401).json({
      success: false,
      error: "No active SSH session. Please sign in first."
    });
  }

  // Escape double quotes and special characters for safe writing
  const safeContent = content.replace(/"/g, '\\"');

  // Use echo to overwrite file content
  const command = `echo "${safeContent}" > ${path}`;

  userSession.exec(command, (err, stream) => {
    if (err) {
      console.error(`[WRITE FILE ERROR] ${username}:`, err);
      return res.status(500).json({
        success: false,
        error: "Failed to write file."
      });
    }

    let errorOutput = "";

    stream.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    stream.on("close", () => {
      if (errorOutput) {
        return res.status(400).json({
          success: false,
          error: errorOutput
        });
      }

      return res.json({
        success: true,
        message: `File ${path} saved successfully.`
      });
    });
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

// Start HTTP server on port 80
http.createServer(app).listen(3000, "127.0.0.1", () => {
  console.log("Server running on http://localhost:3000");
});