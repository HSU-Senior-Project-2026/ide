// SSH-server Bridge

const express = require("express");
const { Client } = require("ssh2");
const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const app = express();

// Judge0 auth token — lives here on the server, never sent to the browser
const JUDGE0_AUTH_TOKEN = "yjjcWNpQGFQMkpmHQasOKegTvGL8yZ1sI4WM7YYkCuVoUwYt";

// Proxy all /judge0/* requests to the Judge0 backend on port 2358
// The browser calls /judge0/languages → this strips /judge0 and forwards to localhost:2358/languages
// The proxy injects the X-Auth-Token header so the browser never needs to know the key
app.use("/judge0", createProxyMiddleware({
  target: "http://localhost:2358",//"http://35.153.133.130:2358",
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

// Map of session tokens → { username, password }
// Each student who signs in gets a unique token stored here.
// When they click Run, they present their token so we know whose credentials to use.
const sessions = new Map();

// SSH endpoint for sign-in
// Opens a test SSH connection to validate credentials. On success, generates
// a unique session token, stores the credentials under that token, closes the
// test connection, and returns the token to the browser. The browser holds
// this token and presents it every time the student clicks Run.
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

    // Generate a cryptographically random token — 32 random bytes turned into
    // a 64-character hex string. This is unique enough that two students will
    // never receive the same token.
    const token = crypto.randomBytes(32).toString("hex");

    // Store the credentials mapped to this token. We close the test connection
    // below — we don't keep it open. A fresh connection is made on each Run.
    sessions.set(token, { username, password });
    console.log(`[SESSION CREATED] token: ${token.substring(0, 8)}... for ${username}`);

    conn.end(); // close the validation connection, credentials are now stored

    if (!responded) {
      responded = true;
      res.json({ success: true, token, message: "Signed in successfully" });
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

// SSH endpoint for sign-out
// Removes the student's token from the sessions Map. After this, any attempt
// to open a WebSocket with that token will be rejected.
app.post("/ssh-sign-out", (req, res) => {
  const { token } = req.body;

  if (token && sessions.has(token)) {
    const { username } = sessions.get(token);
    sessions.delete(token);
    console.log(`[SESSION REMOVED] token: ${token.substring(0, 8)}... for ${username}`);
    return res.json({ success: true, message: "Signed out successfully" });
  } else {
    return res.status(400).json({ success: false, message: "No active session found" });
  }
});

// Start HTTP server on port 3000.
// Saved to a variable so the WebSocket server can attach to the same port
// in the next step — both HTTP and WebSocket traffic share port 3000.
const httpServer = http.createServer(app);
httpServer.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});