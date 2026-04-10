// SSH-server Bridge

const express = require("express");
const { Client } = require("ssh2");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const loginAttempts = new Map(); 

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
const INACTIVITY_MS = 30 * 60 * 1000;

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

// SSH endpoint for sign-in
// Opens a live SSH connection to validate credentials and KEEPS IT OPEN for
// the lifetime of the session. The browser gets back a token that it presents
// on every subsequent operation; the server looks the token up, reuses the
// already-open ssh2.Client, and runs the new command as a fresh channel over
// the existing connection. This means we pay the ~300-800ms SSH handshake
// exactly once per sign-in instead of once per click.
app.post("/ssh-sign-in", (req, res) => {
  const { username, password } = req.body;
  const now = Date.now();

  if (!username || !password) {
    return res.json({ success: false, error: "Username or password missing" });
  }

  const key = username.trim().toLowerCase();

  const attempt = loginAttempts.get(key) || { count: 0, lockUntil: 0 };

  // 🔒 lock check
  if (attempt.lockUntil && now < attempt.lockUntil) {
    return res.json({
      success: false,
      error: `Too many failed attempts. Try again in ${Math.ceil((attempt.lockUntil - now) / 60000)} minutes`
    });
  }

  const conn = new Client();

  let responded = false;
  let hasFailed = false; // ⭐关键：防重复计数

  function failOnce(errMsg) {
    if (responded || hasFailed) return;
    hasFailed = true;
    responded = true;

    const a = loginAttempts.get(key) || { count: 0, lockUntil: 0 };

    a.count += 1;

    console.log(`[LOGIN FAIL] user=${key} count=${a.count}`);

    if (a.count >= 3) {
      a.lockUntil = Date.now() + 10 * 60 * 1000;
      a.count = 0;
      console.log(`[LOGIN LOCKED] user=${key} for 10 min`);
    }

    loginAttempts.set(key, a);

    try { conn.end(); } catch (_) {}

    return res.json({
      success: false,
      error: "SSH login failed: " + errMsg
    });
  }

  conn.on("ready", () => {
    if (responded) return;
    responded = true;

    loginAttempts.delete(key);

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      username: key,
      password,
      sshClient: conn,
      ready: true,
      tmpDir: null,
      langId: null,
      lastActivity: Date.now(),
      inactivityTimer: null,
    });

    conn.on("close", () => invalidateSession(token, "client-closed"));
    conn.on("end", () => invalidateSession(token, "client-ended"));

    return res.json({ success: true, token });
  });

  // ⭐ 所有失败入口统一
  conn.on("error", (err) => failOnce(err.message));
  conn.on("close", () => failOnce("connection closed"));
  conn.on("end", () => failOnce("connection ended"));

  conn.connect({
    host: "csci.hsutx.edu",
    port: 22,
    username,
    password,
    readyTimeout: 10000,
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

// Maps Judge0 language IDs to the filenames and shell commands needed on the
// CSCI server. compile: null means the language is interpreted — no compile
// step needed, we just write the file and mark it ready to run immediately.
const LANGUAGE_COMMANDS = {
    // Java — Judge0 lists Java under several IDs depending on the JDK version.
    // All of them compile and run identically on the CSCI server.
    62:  { file: "Main.java",  compile: "javac Main.java",       run: "java -cp . Main"  },
    91:  { file: "Main.java",  compile: "javac Main.java",       run: "java -cp . Main"  },
    27:  { file: "Main.java",  compile: "javac Main.java",       run: "java -cp . Main"  },

    // C
    103: { file: "main.c",     compile: "gcc main.c -o main",    run: "./main"           },
    4:   { file: "main.c",     compile: "gcc main.c -o main",    run: "./main"           },

    // C++
    105: { file: "main.cpp",   compile: "g++ main.cpp -o main",  run: "./main"           },
    10:  { file: "main.cpp",   compile: "g++ main.cpp -o main",  run: "./main"           },

    // Python — no compile step needed
    25:  { file: "main.py",    compile: null,                    run: "python3 main.py"  },
    70:  { file: "main.py",    compile: null,                    run: "python3 main.py"  },
    71:  { file: "main.py",    compile: null,                    run: "python3 main.py"  },

    // JavaScript (Node.js)
    102: { file: "main.js",    compile: null,                    run: "node main.js"     },
    63:  { file: "main.js",    compile: null,                    run: "node main.js"     },

    // Bash
    46:  { file: "main.sh",    compile: null,                    run: "bash main.sh"     },
};

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
  const params = new URLSearchParams(req.url.split("?")[1] || "");
  const token  = params.get("token");
  const mode   = params.get("mode");
  const langId = parseInt(params.get("lang") || "0");

  console.log(`[WS CONNECT] mode=${mode} lang=${langId} token=${token ? token.substring(0, 8) + "..." : "none"}`);

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
    const lang = LANGUAGE_COMMANDS[langId];
    if (!lang) {
      ws.send(`ERROR: Language ID ${langId} is not supported for SSH execution.\r\n`);
      ws.close(4001, "unsupported-language");
      return;
    }

    // Wait for exactly one message containing the raw source code.
    ws.once("message", (rawData) => {
      const sourceCode = rawData.toString();
      const { username } = session;

      // Each student gets a unique temp directory based on their session token.
      // Using token.substring(0,16) keeps the path short while still being unique.
      const tmpDir = `/tmp/judge0_${token.substring(0, 16)}`;

      // Base64-encode the source code in Node before sending it to the shell.
      // This means no matter what characters the student typed — quotes,
      // backslashes, dollar signs — the file is written safely without any
      // shell interpretation. printf decodes it byte-for-byte on the other end.
      const b64 = Buffer.from(sourceCode).toString("base64");

      // Build the full command string:
      // 1. Delete any previous compile attempt for this student
      // 2. Create a fresh temp directory
      // 3. Decode the base64 source into the correct filename
      // 4. If a compile command exists, run it; otherwise skip (interpreted languages)
      const compileStep = lang.compile ? ` && cd ${tmpDir} && ${lang.compile}` : "";
      const fullCmd = `rm -rf ${tmpDir} && mkdir -p ${tmpDir} && printf '%s' '${b64}' | base64 -d > ${tmpDir}/${lang.file}${compileStep}`;

      console.log(`[COMPILE] user=${username} dir=${tmpDir} lang=${langId}`);

      // exec() opens a new channel on the shared client — NOT a new connection.
      // Do NOT call sshClient.end() anywhere in this handler; the client must
      // outlive this channel so other operations can reuse it.
      sshClient.exec(fullCmd, (err, stream) => {
        if (err) {
          ws.send(`ERROR: Could not start compile: ${err.message}\r\n`);
          ws.close(4001, "exec-error");
          return;
        }

        // Stream stdout and stderr directly to the browser as they arrive.
        stream.on("data", (data) => ws.send(data.toString()));
        stream.stderr.on("data", (data) => ws.send(data.toString()));

        stream.on("close", (exitCode) => {
          if (exitCode === 0) {
            // Store the temp dir and language in the session so run() can find them.
            session.tmpDir  = tmpDir;
            session.langId  = langId;
            console.log(`[COMPILE SUCCESS] user=${username}`);
            ws.close(4000, "success"); // 4000 signals success to the browser
          } else {
            session.tmpDir = null;
            console.log(`[COMPILE FAILED] user=${username} exitCode=${exitCode}`);
            ws.close(4001, "failed");  // 4001 signals failure to the browser
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
    if (!session.tmpDir || !session.langId) {
      ws.send("ERROR: No compiled code found. Please compile before running.\r\n");
      ws.close();
      return;
    }

    const lang     = LANGUAGE_COMMANDS[session.langId];
    const { username, tmpDir } = session;

    // Build the run command using exec so that the student's program *replaces*
    // the shell process and becomes the direct owner of the PTY. This is critical
    // for interactive I/O: without exec, the program runs as a grandchild process
    // that is NOT in the PTY's foreground process group, which causes reads from
    // stdin to hang after the first input (the terminal driver sends SIGTTIN to
    // background processes attempting to read).
    //
    // Previously we used `timeout 30` here, but GNU timeout creates a new process
    // group for its child by default, which broke the PTY foreground group ownership
    // and caused Scanner/scanf/input() to freeze after the first interactive read.
    //
    //   ulimit -t 10  — CPU time limit; catches infinite loops
    //   exec          — replaces the shell with the program so it owns the PTY
    //
    // Wall-clock timeout is enforced in Node.js below (RUN_TIMEOUT_MS) instead of
    // relying on the `timeout` command, since we need the program to be the PTY
    // session leader for interactive I/O to work correctly.
    const runCmd = `ulimit -t 10 && cd ${tmpDir} && exec ${lang.run}`;

    console.log(`[RUN] user=${username} dir=${tmpDir}`);

    sshClient.exec(runCmd, { pty: { term: "xterm-256color", cols: 220, rows: 50 } }, (err, stream) => {
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

      // browser → SSH: forward every keystroke from xterm.js to the program.
      ws.on("message", (data) => {
        stream.write(data.toString());
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

    sshClient.shell({ term: "xterm-256color", cols: 220, rows: 50 }, (err, stream) => {
      if (err) {
        ws.send(`ERROR: Could not open shell: ${err.message}\r\n`);
        ws.close();
        return;
      }

      // Shell → browser
      stream.on("data", (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
      });

      // Browser keystrokes → shell
      ws.on("message", (data) => {
        stream.write(data.toString());
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

httpServer.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});