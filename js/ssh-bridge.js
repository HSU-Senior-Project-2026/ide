// SSH-server Bridge

const express = require("express");
const { Client } = require("ssh2");
const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

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

  // Auth gate — reject immediately if the token is not in the sessions Map.
  if (!token || !sessions.has(token)) {
    ws.send("ERROR: Not signed in. Please sign in before running code.\r\n");
    ws.close();
    return;
  }

  if (mode !== "compile" && mode !== "run" && mode !== "shell") {
    ws.send("ERROR: Invalid mode. Must be 'compile', 'run', or 'shell'.\r\n");
    ws.close();
    return;
  }

  const session = sessions.get(token);

  // ─────────────────────────────────────────────────────────────────────────
  // COMPILE MODE
  // The browser sends source code as the first WebSocket message.
  // We SSH to the CSCI server, write the file, run the compiler, and stream
  // all output back. When done we close the WebSocket with code 4000 (success)
  // or 4001 (failure). The browser checks this code to decide whether to
  // enable the Run button.
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
      const { username, password } = session;

      // Each student gets a unique temp directory based on their session token.
      // Using token.substring(0,16) keeps the path short while still being unique.
      const tmpDir = `/tmp/judge0_${token.substring(0, 16)}`;

      const conn = new Client();

      conn.on("ready", () => {
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

        conn.exec(fullCmd, (err, stream) => {
          if (err) {
            ws.send(`ERROR: Could not start compile: ${err.message}\r\n`);
            ws.close(4001, "exec-error");
            conn.end();
            return;
          }

          // Stream stdout and stderr directly to the browser as they arrive.
          stream.on("data", (data) => ws.send(data.toString()));
          stream.stderr.on("data", (data) => ws.send(data.toString()));

          stream.on("close", (exitCode) => {
            conn.end();
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

      conn.on("error", (err) => {
        console.log(`[COMPILE SSH ERROR] ${err.message}`);
        ws.send(`SSH ERROR: ${err.message}\r\n`);
        ws.close(4001, "ssh-error");
      });

      conn.connect({ host: "csci.hsutx.edu", port: 22, username, password, readyTimeout: 10000 });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RUN MODE
  // We SSH to the CSCI server and exec the run command with a PTY so the
  // program behaves exactly like it would in a real terminal — scanf/Scanner
  // prompts appear immediately, the cursor works, etc.
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
    const { username, password, tmpDir } = session;

    const conn = new Client();

    conn.on("ready", () => {
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

      conn.exec(runCmd, { pty: { term: "xterm-256color", cols: 220, rows: 50 } }, (err, stream) => {
        if (err) {
          ws.send(`ERROR: Could not start program: ${err.message}\r\n`);
          ws.close();
          conn.end();
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
          stream.close();
          conn.end();
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
          conn.end();
        });

        // Browser closed the tab or clicked something that killed the connection.
        // Kill the remote process too so it doesn't linger on the server.
        ws.on("close", () => {
          clearTimeout(runTimer);
          console.log(`[RUN ABORTED] user=${username}`);
          stream.close();
          conn.end();
        });
      });
    });

    conn.on("error", (err) => {
      console.log(`[RUN SSH ERROR] ${err.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`SSH ERROR: ${err.message}\r\n`);
        ws.close();
      }
    });

    conn.connect({ host: "csci.hsutx.edu", port: 22, username, password, readyTimeout: 10000 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SHELL MODE
  // Opens a full interactive login shell on the CSCI server. The student can
  // run any command — ls, git, vim, gcc, etc. — just like a normal SSH session.
  // Data flows bidirectionally between xterm.js and the shell for the lifetime
  // of the connection.
  // ─────────────────────────────────────────────────────────────────────────
  if (mode === "shell") {
    const { username, password } = session;
    const conn = new Client();

    conn.on("ready", () => {
      console.log(`[SHELL] user=${username}`);

      conn.shell({ term: "xterm-256color", cols: 220, rows: 50 }, (err, stream) => {
        if (err) {
          ws.send(`ERROR: Could not open shell: ${err.message}\r\n`);
          ws.close();
          conn.end();
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

        // Shell exited (student typed "exit" or the connection dropped).
        stream.on("close", () => {
          console.log(`[SHELL CLOSED] user=${username}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("\r\n[Shell session ended]\r\n");
            ws.close();
          }
          conn.end();
        });

        // Browser disconnected — tear down the SSH connection.
        ws.on("close", () => {
          console.log(`[SHELL ABORTED] user=${username}`);
          stream.close();
          conn.end();
        });
      });
    });

    conn.on("error", (err) => {
      console.log(`[SHELL SSH ERROR] ${err.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`SSH ERROR: ${err.message}\r\n`);
        ws.close();
      }
    });

    conn.connect({ host: "csci.hsutx.edu", port: 22, username, password, readyTimeout: 10000 });
  }

  ws.on("close", () => {
    console.log(`[WS DISCONNECT] mode=${mode} token=${token.substring(0, 8)}...`);
  });
});

httpServer.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});