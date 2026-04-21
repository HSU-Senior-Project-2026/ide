// SSH-server Bridge

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const { Client } = require("ssh2");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const SSH_HOST = process.env.SSH_HOST || "localhost";
const SSH_PORT = parseInt(process.env.SSH_PORT, 10) || 22;
const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 3000;
const SERVER_BIND = process.env.SERVER_BIND || "0.0.0.0";

const app = express();

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

// Map of session tokens → {
//   username, password,          ← credentials (password kept for potential future reconnect)
//   sshClient,                   ← live ssh2.Client, opened at sign-in and reused
//   ready,                       ← false if the client has died/closed
//   tmpDir, langId,              ← populated by compile; consumed by run
//   lastActivity, inactivityTimer ← idle-reaping bookkeeping
// }
//
// Layer 1 model: one live SSH connection per signed-in student. Compile, run,
// shell, and (future) file ops all multiplex new channels over that single
// connection, so we only pay the SSH handshake once per session instead of
// once per click. Connections are torn down on explicit sign-out, on idle
// timeout, or when the underlying ssh2.Client emits 'close'/'error'.
const sessions = new Map();

// Idle timeout — if a student takes no action for this long, we reap their
// SSH connection. They'll be forced to sign in again on their next action.
// 30 minutes is generous for classroom use (lecture pauses, student walks away)
// but short enough that abandoned tabs don't hold server connections forever.
const INACTIVITY_MS = 10 * 60 * 1000;

// Mark a session as recently active and (re)arm its idle-reap timer.
// Called from sign-in and from every WS handler entry. Safe to call on a
// missing/invalidated session — it just no-ops.
function touchSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  session.lastActivity = Date.now();
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
  session.inactivityTimer = setTimeout(() => {
    console.log(`[SESSION IDLE TIMEOUT] token: ${token.substring(0, 8)}... user=${session.username}`);
    invalidateSession(token, "idle-timeout");
  }, INACTIVITY_MS);
}

// Tear down a session: end the SSH client (best-effort), clear its idle timer,
// and remove it from the map. Used for explicit sign-out, idle timeout, and
// unexpected client death ('close'/'error' on the ssh2.Client). Reason is
// logged for debugging. Safe to call on an already-missing token.
function invalidateSession(token, reason) {
  const session = sessions.get(token);
  if (!session) return;
  console.log(`[SESSION INVALIDATED] token: ${token.substring(0, 8)}... user=${session.username} reason=${reason}`);
  session.ready = false;
  if (session.inactivityTimer) {
    clearTimeout(session.inactivityTimer);
    session.inactivityTimer = null;
  }
  if (session.sshClient) {
    try { session.sshClient.end(); } catch (_) { /* already closed — ignore */ }
    session.sshClient = null;
  }
  sessions.delete(token);
}

// Get the active session for a token sent by the frontend.
// Returns null if the token is missing, invalid, or the SSH client is no longer ready.
function getSessionFromToken(token) {
  if (!token || !sessions.has(token)) return null;

  const session = sessions.get(token);
  if (!session || !session.ready || !session.sshClient) return null;

  return session;
}

// Resolve a requested path and ensure it stays inside the signed-in user's home directory.
async function validatePathForToken(token, inputPath) {
  const session = getSessionFromToken(token);

  if (!session) {
    throw new Error("Invalid or expired session");
  }

  if (!session.homeDir) {
    throw new Error("Home directory not resolved");
  }

  let resolved = inputPath.replace(/^~/, session.homeDir);

  try {
    resolved = (await sshExecForToken(
      token,
      `realpath -m ${JSON.stringify(resolved)}`
    )).trim();
  } catch {
    resolved = path.posix.normalize(resolved);
  }

  if (resolved !== session.homeDir && !resolved.startsWith(session.homeDir + "/")) {
    throw new Error("Access denied: path is outside your home directory");
  }

  return resolved;
}

// Run a command over the existing SSH connection for a signed-in user.
function sshExecForToken(token, command) {
  return new Promise((resolve, reject) => {
    const session = getSessionFromToken(token);

    if (!session) {
      return reject(new Error("Invalid or expired session"));
    }

    touchSession(token);

    session.sshClient.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = "";
      let stderr = "";

      stream.on("data", (data) => {
        stdout += data.toString();
      });

      stream.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      stream.on("close", (code) => {
        if (code !== 0) {
          return reject(new Error(stderr.trim() || `Exit code ${code}`));
        }
        resolve(stdout);
      });
    });
  });
}

// ===== Login rate limiting =====
// Tracks failed attempts per IP. After MAX_LOGIN_ATTEMPTS failures within the
// lockout window, the IP is blocked for LOCKOUT_MS before it can try again.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes
const loginAttempts = new Map(); // ip → { count, lockedUntil }

function getLoginState(ip) {
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { count: 0, lockedUntil: 0 });
  }
  return loginAttempts.get(ip);
}

function recordFailedLogin(ip) {
  const state = getLoginState(ip);
  state.count += 1;
  if (state.count >= MAX_LOGIN_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    console.log(`[RATE LIMIT] IP ${ip} locked out for ${LOCKOUT_MS / 1000}s after ${state.count} failed attempts`);
  }
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// ===== Validate an existing session (used by the frontend on page reload) =====
app.post("/ssh-validate-session", (req, res) => {
  const { token } = req.body;
  const session = getSessionFromToken(token);
  if (session) {
    touchSession(token);
    return res.json({ success: true, username: session.username });
  }
  return res.json({ success: false });
});

// SSH endpoint for sign-in
// Opens a live SSH connection to validate credentials and KEEPS IT OPEN for
// the lifetime of the session. The browser gets back a token that it presents
// on every subsequent operation; the server looks the token up, reuses the
// already-open ssh2.Client, and runs the new command as a fresh channel over
// the existing connection. This means we pay the ~300-800ms SSH handshake
// exactly once per sign-in instead of once per click.
app.post("/ssh-sign-in", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, error: "Username or password missing" });
  }

  // Rate-limit check
  const ip = req.ip;
  const loginState = getLoginState(ip);
  if (loginState.lockedUntil > Date.now()) {
    const remainMs = loginState.lockedUntil - Date.now();
    const remainMin = Math.ceil(remainMs / 60000);
    return res.status(429).json({
      success: false,
      error: `Too many failed attempts. Try again in ${remainMin} minute${remainMin === 1 ? "" : "s"}.`,
      lockedUntil: loginState.lockedUntil,
      retryAfterMs: remainMs
    });
  }

  console.log(`[SSH LOGIN ATTEMPT] From ${ip}`);

  const conn = new Client();
  let responded = false;

  /*conn.on("ready", () => {
    console.log(`[SSH LOGIN SUCCESS] username: ${username}`);

    // Generate a cryptographically random token — 32 random bytes turned into
    // a 64-character hex string. This is unique enough that two students will
    // never receive the same token.
    const token = crypto.randomBytes(32).toString("hex");

    conn.exec("echo $HOME", (err, stream) => {
      if (err) {
        console.error("[SSH HOME ERROR]", err.message);
        return;
      } else {
        let stdout = "";
        let stderr = "";

        stream.on("data", (data) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        stream.on("close", (code) => {
          if (code === 0) {
            const session = sessions.get(token);
            if (session) {
              session.homeDir = stdout.trim();
              console.log(`[SSH HOME] user=${username} home=${session.homeDir}`);
            }
          } else {
            console.error("[SSH HOME ERROR]", stderr.trim() || `Exit code ${code}`);
          }
        });
      }
    });

    const homeDir = stdout.trim();

    // Store the LIVE client in the session — do not call conn.end() here.
    // This connection will be reused by every compile/run/shell/file-op until
    // the user signs out, the session goes idle, or the client dies.
    sessions.set(token, {
      username,
      password,
      sshClient: conn,
      ready: true,
      homeDir,
      tmpDir: null,
      langId: null,
      lastActivity: Date.now(),
      inactivityTimer: null,
    });
    console.log(`[SESSION CREATED] token: ${token.substring(0, 8)}... for ${username}`);
    console.log(`[SSH HOME] user=${username} home=${homeDir}`);

    // Arm the idle-reap timer. Every WS handler entry touches the session,
    // which resets this — so an active user never gets reaped mid-lesson.
    touchSession(token);

    // Attach long-lived listeners for unexpected death AFTER the validation
    // response goes out. The 'responded' flag below guarantees the validation
    // 'error' handler can't double-respond if the connection dies later.
    conn.on("close", () => {
      console.log(`[SSH CLIENT CLOSED] user=${username} token=${token.substring(0, 8)}...`);
      invalidateSession(token, "client-closed");
    });
    conn.on("end", () => {
      console.log(`[SSH CLIENT ENDED] user=${username} token=${token.substring(0, 8)}...`);
      // 'end' usually precedes 'close'; invalidate is idempotent so double-calls are safe.
      invalidateSession(token, "client-ended");
    });

    if (!responded) {
      responded = true;
      res.json({ success: true, token, message: "Signed in successfully" });
    }
  }); */

  conn.on("ready", () => {
    console.log(`[SSH LOGIN SUCCESS] username: ${username}`);

    const token = crypto.randomBytes(32).toString("hex");

    conn.exec("echo $HOME", (err, stream) => {
      if (err) {
        console.error("[SSH HOME ERROR]", err.message);
        if (!responded) {
          responded = true;
          return res.status(500).json({
            success: false,
            error: "Could not resolve home directory"
          });
        }
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (data) => {
        stdout += data.toString();
      });

      stream.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      stream.on("close", (code) => {
        if (code !== 0) {
          console.error("[SSH HOME ERROR]", stderr.trim() || `Exit code ${code}`);
          if (!responded) {
            responded = true;
            return res.status(500).json({
              success: false,
              error: "Could not resolve home directory"
            });
          }
          return;
        }

        const homeDir = stdout.trim();

        sessions.set(token, {
          username,
          password,
          sshClient: conn,
          ready: true,
          homeDir,
          tmpDir: null,
          langId: null,
          lastActivity: Date.now(),
          inactivityTimer: null,
        });

        console.log(`[SSH HOME] user=${username} home=${homeDir}`);
        console.log(`[SESSION CREATED] token=${token.substring(0, 8)}...`);

        touchSession(token);

        conn.on("close", () => {
          invalidateSession(token, "client-closed");
        });

        conn.on("end", () => {
          invalidateSession(token, "client-ended");
        });

        // SEND RESPONSE HERE (after homeDir is ready)
        resetLoginAttempts(ip);
        if (!responded) {
          responded = true;
          res.json({
            success: true,
            token,
            message: "Signed in successfully"
          });
        }
      });
    });
  });



  conn.on("error", (err) => {
    console.log(`[SSH ERROR] ${err.message}`);
    if (!responded) {
      // Validation-phase failure — tell the browser login failed.
      recordFailedLogin(ip);
      const state = getLoginState(ip);
      const attemptsLeft = Math.max(0, MAX_LOGIN_ATTEMPTS - state.count);
      responded = true;
      res.json({
        success: false,
        error: "SSH connection failed: " + err.message,
        attemptsLeft,
        lockedUntil: state.lockedUntil > Date.now() ? state.lockedUntil : undefined,
        retryAfterMs: state.lockedUntil > Date.now() ? state.lockedUntil - Date.now() : undefined
      });
    } else {
      // Post-validation failure — the live connection died out from under us.
      // Find the token for this client and invalidate. O(n) in sessions count,
      // but n is small (one per signed-in student) so this is fine.
      for (const [token, session] of sessions.entries()) {
        if (session.sshClient === conn) {
          invalidateSession(token, "client-error: " + err.message);
          break;
        }
      }
    }
  });

  conn.connect({
    host: SSH_HOST,
    port: SSH_PORT,
    username,
    password,
    readyTimeout: 10000,
    // Send an SSH keepalive packet every 30s and drop the connection if the
    // server fails to respond to 3 in a row (~90s). Prevents NAT devices and
    // sshd's ClientAliveInterval from silently killing idle connections.
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  });
});

// SSH endpoint for sign-out
// Tears down the live SSH connection and removes the session. After this,
// any attempt to open a WebSocket with the same token hits the auth gate in
// the WS handler and is rejected. Also called via navigator.sendBeacon from
// the browser's 'beforeunload' event so closing the tab drops the connection
// instead of waiting for the idle-reap timer.
app.post("/ssh-sign-out", (req, res) => {
  const { token } = req.body;

  if (token && sessions.has(token)) {
    const { username } = sessions.get(token);
    invalidateSession(token, "sign-out");
    console.log(`[SESSION REMOVED] token: ${token.substring(0, 8)}... for ${username}`);
    return res.json({ success: true, message: "Signed out successfully" });
  } else {
    return res.status(400).json({ success: false, message: "No active session found" });
  }
});

// Read a file from the signed-in user's home directory.
app.post("/ssh-read", async (req, res) => {
  const { token, path: filePath } = req.body;

  if (!token) {
    return res.status(401).json({ success: false, error: "Missing session token" });
  }

  if (!filePath) {
    return res.status(400).json({ success: false, error: "File path is required" });
  }

  try {
    const resolvedPath = await validatePathForToken(token, filePath);
    const content = await sshExecForToken(token, `cat ${JSON.stringify(resolvedPath)}`);

    res.json({
      success: true,
      path: resolvedPath,
      content
    });
  } catch (err) {
    console.error("[SSH-READ ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Write content to a file in the signed-in user's home directory.
app.post("/ssh-write", async (req, res) => {
  const { token, path: filePath, content } = req.body;

  if (!token) {
    return res.status(401).json({ success: false, error: "Missing session token" });
  }

  if (!filePath) {
    return res.status(400).json({ success: false, error: "File path is required" });
  }

  try {
    const resolvedPath = await validatePathForToken(token, filePath);
    const encoded = Buffer.from(content || "").toString("base64");

    await sshExecForToken(
      token,
      `echo ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(resolvedPath)}`
    );

    res.json({
      success: true,
      path: resolvedPath,
      message: "File saved successfully"
    });
  } catch (err) {
    console.error("[SSH-WRITE ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// List files and folders in the signed-in user's home directory.
// Uses the existing token-based SSH session and prevents access
// outside the user's home directory.
app.post("/ssh-ls", async (req, res) => {
  const { token, path: dirPath } = req.body;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Missing session token"
    });
  }

  // Default to the user's home directory if no path is provided
  const requestedPath = dirPath || "~";

  try {
    const session = getSessionFromToken(token);

    if (!session) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired session"
      });
    }

    const resolvedDir = await validatePathForToken(token, requestedPath);
    const isHome = resolvedDir === session.homeDir;

    // ls -laF gives:
    // - hidden files
    // - file/folder indicators
    // - permissions
    const output = await sshExecForToken(
      token,
      `ls -F ${JSON.stringify(resolvedDir)}`
    );

    const lines = output.split("\n").filter(Boolean);
    const entries = [];

    /*for (const line of lines) {
      // Skip "total N"
      if (line.startsWith("total ")) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const permStr = parts[0];
      const rawName = parts.slice(8).join(" ");

      // Skip current directory entry
      if (rawName === "./" || rawName === ".") continue;

      // Allow going up one level only if not already at home
      if (rawName === "../" || rawName === "..") {
        if (!isHome) {
          entries.unshift({
            name: "..",
            type: "directory",
            readable: true,
            writable: false
          });
        }
        continue;
      }

      const isDir = rawName.endsWith("/");
      const name = rawName.replace(/[/*@=|]$/, "");

      entries.push({
        name,
        type: isDir ? "directory" : "file",
        readable: permStr.charAt(1) === "r",
        writable: permStr.charAt(2) === "w"
      });
    }*/

    if (!isHome) {
      entries.push({
        name: "..",
        type: "directory",
        readable: true,
        writable: true
      });
    }

    for (const line of lines) {
      const isDir = line.endsWith("/");
      const name = line.replace(/[/*@=|]$/, "");

      entries.push({
        name,
        type: isDir ? "directory" : "file",
        readable: true,
        writable: true
      });
    }

    return res.json({
      success: true,
      path: resolvedDir,
      isHome,
      entries
    });
  } catch (err) {
    console.error("[SSH-LS ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    return res.status(status).json({
      success: false,
      error: err.message
    });
  }
});

// Create a new directory in the signed-in user's current workspace
app.post("/ssh-mkdir", async (req, res) => {
  const { token, path: dirPath } = req.body;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Missing session token"
    });
  }

  if (!dirPath) {
    return res.status(400).json({
      success: false,
      error: "Directory path is required"
    });
  }

  try {
    const resolvedPath = await validatePathForToken(token, dirPath);

    await sshExecForToken(
      token,
      `mkdir ${JSON.stringify(resolvedPath)}`
    );

    return res.json({
      success: true,
      path: resolvedPath,
      message: "Folder created successfully"
    });
  } catch (err) {
    console.error("[SSH-MKDIR ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    return res.status(status).json({
      success: false,
      error: err.message
    });
  }
});

// Rename or move a file/folder in the signed-in user's workspace
app.post("/ssh-mv", async (req, res) => {
  const { token, from, to } = req.body;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Missing session token"
    });
  }

  if (!from || !to) {
    return res.status(400).json({
      success: false,
      error: "Both 'from' and 'to' paths are required"
    });
  }

  try {
    const resolvedFrom = await validatePathForToken(token, from);
    const resolvedTo = await validatePathForToken(token, to);

    await sshExecForToken(
      token,
      `mv ${JSON.stringify(resolvedFrom)} ${JSON.stringify(resolvedTo)}`
    );

    return res.json({
      success: true,
      from: resolvedFrom,
      to: resolvedTo,
      message: "Rename successful"
    });
  } catch (err) {
    console.error("[SSH-MV ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    return res.status(status).json({
      success: false,
      error: err.message
    });
  }
});

// Delete a file or an empty directory in the signed-in user's workspace
app.post("/ssh-rm", async (req, res) => {
  const { token, path: targetPath } = req.body;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Missing session token"
    });
  }

  if (!targetPath) {
    return res.status(400).json({
      success: false,
      error: "Path is required"
    });
  }

  try {
    const resolvedPath = await validatePathForToken(token, targetPath);

    // Check whether target is a directory
    const fileType = (await sshExecForToken(
      token,
      `stat -c %F ${JSON.stringify(resolvedPath)}`
    )).trim();

    if (fileType === "directory") {
      // Only removes empty directories
      await sshExecForToken(token, `rmdir ${JSON.stringify(resolvedPath)}`);
    } else {
      await sshExecForToken(token, `rm ${JSON.stringify(resolvedPath)}`);
    }

    return res.json({
      success: true,
      path: resolvedPath,
      message: "Delete successful"
    });
  } catch (err) {
    console.error("[SSH-RM ERROR]", err.message);
    const status = err.message.includes("Access denied") ? 403 : 500;
    return res.status(status).json({
      success: false,
      error: err.message
    });
  }
});

// Maps Judge0 language IDs to the filenames and shell commands needed on the
// CSCI server. compile: null means the language is interpreted — no compile
// step needed, we just write the file and mark it ready to run immediately.
// Maps Judge0 language IDs to their language type. The actual filenames and
// compile/run commands are derived at runtime from the filename the student
// has open in the editor, so that e.g. `HelloWorld.java` compiles as
// `javac HelloWorld.java` and runs as `java -cp . HelloWorld`.
const LANGUAGE_TYPES = {
    62: "java", 91: "java", 27: "java",
    103: "c",   4:  "c",
    105: "cpp", 10: "cpp",
    25: "py",   70: "py",   71: "py",
    102: "js",  63: "js",
    46: "sh",
};

// Default filenames per language type — used when the client doesn't send one.
const DEFAULT_FILES = {
    java: "Main.java", c: "main.c", cpp: "main.cpp",
    py: "main.py", js: "main.js", sh: "main.sh",
};

// Build compile and run commands from the actual filename and language type.
// For Java the filename is critical (must match public class name); for others
// it only matters that we use a consistent name for write → compile → run.
function getCommandsForFile(langType, sourceFile) {
    const base = sourceFile.replace(/\.[^.]+$/, ""); // strip extension
    switch (langType) {
        case "java":
            return { file: sourceFile, compile: `javac ${sourceFile}`, run: `java -cp . ${base}` };
        case "c":
            return { file: sourceFile, compile: `gcc ${sourceFile} -o main`, run: "./main" };
        case "cpp":
            return { file: sourceFile, compile: `g++ ${sourceFile} -o main`, run: "./main" };
        case "py":
            return { file: sourceFile, compile: null, run: `python3 ${sourceFile}` };
        case "js":
            return { file: sourceFile, compile: null, run: `node ${sourceFile}` };
        case "sh":
            return { file: sourceFile, compile: null, run: `bash ${sourceFile}` };
        default:
            return null;
    }
}

// Start HTTP server on port 3000.
// Saved to a variable so the WebSocket server can attach to the same port —
// both HTTP and WebSocket traffic share port 3000.
const httpServer = http.createServer(app);

// Attach the WebSocket server to the same HTTP server.
// When a browser connects with ws:// instead of http://, the ws library
// intercepts that "upgrade" request and hands it to this handler.
// HTTP requests continue going to Express as normal — same port, two protocols.
const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, req) => {
  const params   = new URLSearchParams(req.url.split("?")[1] || "");
  const token    = params.get("token");
  const mode     = params.get("mode");
  const langId   = parseInt(params.get("lang") || "0");
  const fileName = params.get("file") || "";   // actual filename from the editor tab
  const cols     = Math.max(10, Math.min(500, parseInt(params.get("cols") || "80")));
  const rows     = Math.max(5,  Math.min(100, parseInt(params.get("rows") || "24")));

  console.log(`[WS CONNECT] mode=${mode} lang=${langId} file=${fileName} cols=${cols} rows=${rows} token=${token ? token.substring(0, 8) + "..." : "none"}`);

  // Auth gate — reject immediately if the token is not in the sessions Map,
  // or if the underlying ssh2.Client has died since sign-in. Either case forces
  // the student to sign in again, which opens a fresh connection.
  if (!token || !sessions.has(token)) {
    ws.send("ERROR: Not signed in. Please sign in before running code.\r\n");
    ws.close();
    return;
  }

  const session = sessions.get(token);

  if (!session.ready || !session.sshClient) {
    ws.send("ERROR: Your SSH connection has expired. Please sign in again.\r\n");
    ws.close();
    return;
  }

  if (mode !== "compile" && mode !== "run" && mode !== "shell") {
    ws.send("ERROR: Invalid mode. Must be 'compile', 'run', or 'shell'.\r\n");
    ws.close();
    return;
  }

  // Any successful WS connection counts as activity — reset the idle-reap timer.
  touchSession(token);

  // One shared ssh2.Client is reused across compile/run/shell/file-ops.
  // ssh2 multiplexes channels natively, so opening exec() or shell() on this
  // client creates an independent channel without a new TCP/SSH handshake.
  const sshClient = session.sshClient;

  // ─────────────────────────────────────────────────────────────────────────
  // COMPILE MODE
  // The browser sends source code as the first WebSocket message.
  // We open an exec channel on the shared client, write the file, run the
  // compiler, and stream all output back. When done we close the WebSocket
  // with code 4000 (success) or 4001 (failure). The browser checks this code
  // to decide whether to enable the Run button.
  // ─────────────────────────────────────────────────────────────────────────
  if (mode === "compile") {
    const langType = LANGUAGE_TYPES[langId];
    if (!langType) {
      ws.send(`ERROR: Language ID ${langId} is not supported for SSH execution.\r\n`);
      ws.close(4001, "unsupported-language");
      return;
    }

    // Derive the source filename: prefer the actual name from the editor tab,
    // fall back to the default for this language type. This is critical for Java
    // where the filename must match the public class name.
    const sourceFile = fileName || DEFAULT_FILES[langType];
    const lang = getCommandsForFile(langType, sourceFile);

    // Wait for exactly one message containing the raw source code.
    ws.once("message", (rawData) => {
      const sourceCode = rawData.toString();
      const { username } = session;

      const tmpDir = `/tmp/judge0_${token.substring(0, 16)}`;
      const b64 = Buffer.from(sourceCode).toString("base64");

      const compileStep = lang.compile ? ` && cd ${tmpDir} && ${lang.compile}` : "";
      const fullCmd = `rm -rf ${tmpDir} && mkdir -p ${tmpDir} && printf '%s' '${b64}' | base64 -d > ${tmpDir}/${lang.file}${compileStep}`;

      console.log(`[COMPILE] user=${username} dir=${tmpDir} file=${lang.file} lang=${langId}`);

      sshClient.exec(fullCmd, (err, stream) => {
        if (err) {
          ws.send(`ERROR: Could not start compile: ${err.message}\r\n`);
          ws.close(4001, "exec-error");
          return;
        }

        stream.on("data", (data) => ws.send(data.toString()));
        stream.stderr.on("data", (data) => ws.send(data.toString()));

        stream.on("close", (exitCode) => {
          if (exitCode === 0) {
            // Store the temp dir, language, AND the run command in the session
            // so the run handler uses the correct filename-derived command.
            session.tmpDir  = tmpDir;
            session.langId  = langId;
            session.runCmd  = lang.run;
            console.log(`[COMPILE SUCCESS] user=${username}`);
            ws.close(4000, "success");
          } else {
            session.tmpDir = null;
            console.log(`[COMPILE FAILED] user=${username} exitCode=${exitCode}`);
            ws.close(4001, "failed");
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RUN MODE
  // We open an exec channel on the shared client with a PTY so the program
  // behaves exactly like it would in a real terminal — scanf/Scanner prompts
  // appear immediately, the cursor works, etc.
  // Data flows in both directions for the lifetime of the connection:
  //   SSH stdout → WebSocket → xterm.js
  //   xterm.js keystrokes → WebSocket → SSH stdin
  // ─────────────────────────────────────────────────────────────────────────
  if (mode === "run") {
    if (!session.tmpDir || !session.runCmd) {
      ws.send("ERROR: No compiled code found. Please compile before running.\r\n");
      ws.close();
      return;
    }

    const { username, tmpDir } = session;

    // exec replaces the shell with the program so it owns the PTY directly.
    // session.runCmd was set by the compile handler using the actual filename
    // (e.g. "java -cp . HelloWorld" instead of hardcoded "java -cp . Main").
    const runCmd = `ulimit -t 10 && cd ${tmpDir} && exec ${session.runCmd}`;

    console.log(`[RUN] user=${username} dir=${tmpDir}`);

    sshClient.exec(runCmd, { pty: { term: "xterm-256color", cols, rows } }, (err, stream) => {
      if (err) {
        ws.send(`ERROR: Could not start program: ${err.message}\r\n`);
        ws.close();
        return;
      }

      // Wall-clock timeout — kills the program if it runs longer than 30 seconds.
      // This replaces the GNU `timeout` command that we can no longer use (see above).
      const RUN_TIMEOUT_MS = 30000;
      const runTimer = setTimeout(() => {
        console.log(`[RUN TIMEOUT] user=${username} — killed after ${RUN_TIMEOUT_MS / 1000}s`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n[Program killed: exceeded 30 second time limit]\r\n");
          ws.close();
        }
        // Close only this channel — the shared client keeps running for other ops.
        stream.close();
      }, RUN_TIMEOUT_MS);

      // SSH → browser: forward every byte of program output to the terminal.
      stream.on("data", (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
      });

      // browser → SSH: forward keystrokes to stdin, or resize the PTY.
      // The client sends JSON { type: "resize", cols, rows } when the
      // golden-layout panel is resized; everything else is raw keystroke data.
      ws.on("message", (data) => {
        const str = data.toString();
        if (str.charAt(0) === "{") {
          try {
            const msg = JSON.parse(str);
            if (msg.type === "resize" && msg.cols && msg.rows) {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
              return;
            }
          } catch (_) { /* not JSON — fall through to write */ }
        }
        stream.write(str);
      });

      // Program finished normally.
      stream.on("close", () => {
        clearTimeout(runTimer);
        console.log(`[RUN FINISHED] user=${username}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n[Program exited]\r\n");
          ws.close();
        }
      });

      // Browser closed this WS (tab closed, user clicked stop, etc.). Kill only
      // this channel so the program stops — do NOT tear down the shared client.
      ws.on("close", () => {
        clearTimeout(runTimer);
        console.log(`[RUN ABORTED] user=${username}`);
        stream.close();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SHELL MODE
  // Opens a full interactive login shell on the CSCI server as a new channel
  // on the shared client. The student can run any command — ls, git, vim,
  // gcc, etc. — just like a normal SSH session. Data flows bidirectionally
  // between xterm.js and the shell for the lifetime of the WebSocket.
  // ─────────────────────────────────────────────────────────────────────────
  if (mode === "shell") {
    const { username } = session;

    console.log(`[SHELL] user=${username}`);

    sshClient.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
      if (err) {
        ws.send(`ERROR: Could not open shell: ${err.message}\r\n`);
        ws.close();
        return;
      }

      // Suppress zsh's PROMPT_EOL_MARK (the '%' character that appears at
      // the end of every partial line). This is invisible to the user — it
      // runs before the prompt appears and the command itself is hidden by
      // the trailing \n which triggers a fresh prompt redraw.
      stream.write('export PROMPT_EOL_MARK="" 2>/dev/null\n');

      // Shell → browser
      stream.on("data", (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
      });

      // Browser keystrokes → shell, with resize support.
      ws.on("message", (data) => {
        const str = data.toString();
        if (str.charAt(0) === "{") {
          try {
            const msg = JSON.parse(str);
            if (msg.type === "resize" && msg.cols && msg.rows) {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
              return;
            }
          } catch (_) { /* not JSON — fall through to write */ }
        }
        stream.write(str);
      });

      // Shell exited (student typed "exit" or the channel dropped).
      stream.on("close", () => {
        console.log(`[SHELL CLOSED] user=${username}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n[Shell session ended]\r\n");
          ws.close();
        }
      });

      // Browser disconnected — close only this channel. The shared client
      // stays alive for future compile/run/shell operations.
      ws.on("close", () => {
        console.log(`[SHELL ABORTED] user=${username}`);
        stream.close();
      });
    });
  }

  ws.on("close", () => {
    console.log(`[WS DISCONNECT] mode=${mode} token=${token.substring(0, 8)}...`);
  });
});

httpServer.listen(SERVER_PORT, SERVER_BIND, () => {
  console.log(`Server running on http://${SERVER_BIND}:${SERVER_PORT}`);
});