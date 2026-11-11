const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const files = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, ".data"));
const dataFile = path.join(dataDirectory, "accounts.json");
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || "127.0.0.1";
const sessionDuration = 24 * 60 * 60 * 1000;
const passwordKeyLength = 64;
const categories = new Set(["Food", "Housing", "Transport", "Utilities", "Health", "Shopping", "Entertainment", "Other"]);
const publicFiles = new Set(["index.html", "script.js", "style.css"]);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};
const sessions = new Map();
let store = { accounts: [] };
let storeMutation = Promise.resolve();

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message, headers) {
  sendJson(response, status, { error: message }, headers);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
        tooLarge = true;
        body = "";
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(Object.assign(new Error("Request body must be a JSON object."), { status: 400 }));
        return;
      }
      resolve(parsed);
    });
    request.on("error", reject);
  });
}

async function saveStore() {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryFile, dataFile);
}

function mutateStore(update) {
  const operation = storeMutation.then(async () => {
    const rollback = update();
    try {
      await saveStore();
    } catch (error) {
      rollback();
      throw error;
    }
  });
  storeMutation = operation.catch(() => {});
  return operation;
}

function cookieOptions(request, maxAge) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function currentAccount(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("pennywise_session="))?.slice("pennywise_session=".length);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const account = store.accounts.find(item => item.id === session.accountId);
  return account ? { account, token } : null;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validBudget(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isFinite(value.income) &&
    value.income >= 0 &&
    Number.isFinite(value.target) &&
    value.target >= 0 &&
    Array.isArray(value.expenses) &&
    value.expenses.length <= 10000 &&
    value.expenses.every(expense =>
      expense &&
      typeof expense.id === "string" &&
      expense.id.length <= 100 &&
      typeof expense.description === "string" &&
      expense.description.trim().length > 0 &&
      expense.description.length <= 60 &&
      Number.isFinite(expense.amount) &&
      expense.amount > 0 &&
      categories.has(expense.category) &&
      validDate(expense.date)
    );
}

function setSession(response, request, accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  for (const [existingToken, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(existingToken);
  }
  sessions.set(token, { accountId, expiresAt: Date.now() + sessionDuration });
  response.setHeader("Set-Cookie", `pennywise_session=${token}; ${cookieOptions(request, sessionDuration / 1000)}`);
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/register" && request.method === "POST") {
    const body = await readBody(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      sendError(response, 400, "Enter a valid email address.");
      return;
    }
    if (password.length < 8 || password.length > 128) {
      sendError(response, 400, "Password must be between 8 and 128 characters.");
      return;
    }
    const budget = body.budget === undefined ? { income: 0, target: 0, expenses: [] } : body.budget;
    if (!validBudget(budget)) {
      sendError(response, 400, "The budget data is invalid.");
      return;
    }
    if (store.accounts.some(account => account.email === email)) {
      sendError(response, 409, "An account with this email already exists. Sign in instead.");
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(salt, "hex"), passwordKeyLength, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey.toString("hex"));
      });
    });
    const account = {
      id: crypto.randomUUID(),
      email,
      passwordSalt: salt,
      passwordHash: hash,
      budget
    };
    try {
      await mutateStore(() => {
        if (store.accounts.some(item => item.email === email)) {
          throw Object.assign(new Error("An account with this email already exists. Sign in instead."), { status: 409 });
        }
        store.accounts.push(account);
        return () => {
          store.accounts = store.accounts.filter(item => item.id !== account.id);
        };
      });
    } catch (error) {
      if (error.status === 409) {
        sendError(response, 409, error.message);
        return;
      }
      throw error;
    }
    setSession(response, request, account.id);
    sendJson(response, 201, { user: { email: account.email } });
    return;
  }

  if (pathname === "/api/login" && request.method === "POST") {
    const body = await readBody(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const account = store.accounts.find(item => item.email === email);
    const hash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, account ? Buffer.from(account.passwordSalt, "hex") : Buffer.alloc(16), passwordKeyLength, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    });
    const expected = account ? Buffer.from(account.passwordHash, "hex") : Buffer.alloc(passwordKeyLength);
    if (!account || expected.length !== hash.length || !crypto.timingSafeEqual(expected, hash)) {
      sendError(response, 401, "Email or password is incorrect.");
      return;
    }
    setSession(response, request, account.id);
    sendJson(response, 200, { user: { email: account.email } });
    return;
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    const session = currentAccount(request);
    if (session) sessions.delete(session.token);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": `pennywise_session=; ${cookieOptions(request, 0)}` });
    return;
  }

  if (pathname === "/api/session" && request.method === "GET") {
    const session = currentAccount(request);
    if (!session) {
      sendJson(response, 200, { user: null });
      return;
    }
    sendJson(response, 200, { user: { email: session.account.email } });
    return;
  }

  if (pathname === "/api/budget" && request.method === "GET") {
    const session = currentAccount(request);
    if (!session) {
      sendError(response, 401, "Please sign in.");
      return;
    }
    sendJson(response, 200, session.account.budget);
    return;
  }

  if (pathname === "/api/budget" && request.method === "PUT") {
    const session = currentAccount(request);
    if (!session) {
      sendError(response, 401, "Please sign in.");
      return;
    }
    const budget = await readBody(request);
    if (!validBudget(budget)) {
      sendError(response, 400, "The budget data is invalid.");
      return;
    }
    try {
      await mutateStore(() => {
        const previousBudget = session.account.budget;
        session.account.budget = budget;
        return () => {
          session.account.budget = previousBudget;
        };
      });
    } catch (error) {
      throw error;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  sendError(response, 404, "API route not found.");
}

function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url.pathname).catch(error => {
      if (response.headersSent || response.destroyed) return;
      const status = error.status || 500;
      if (status === 500) console.error("API request failed:", error.message);
      sendError(response, status, status === 500 ? "The server could not complete the request." : error.message);
    });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!publicFiles.has(fileName)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = path.join(root, fileName);
  fs.stat(filePath).then(stats => {
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)],
      "Content-Length": stats.size
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = files.createReadStream(filePath);
    stream.on("error", error => {
      console.error("Static file read failed:", error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end("Could not read file");
    });
    stream.pipe(response);
  }).catch(error => {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    console.error("Static file lookup failed:", error.message);
    response.writeHead(500);
    response.end("Could not read file");
  });
}

async function start() {
  try {
    const contents = await fs.readFile(dataFile, "utf8");
    const saved = JSON.parse(contents);
    if (!saved || !Array.isArray(saved.accounts) || saved.accounts.some(account =>
      !account ||
      typeof account.id !== "string" ||
      typeof account.email !== "string" ||
      typeof account.passwordSalt !== "string" ||
      !/^[a-f0-9]{32}$/i.test(account.passwordSalt) ||
      typeof account.passwordHash !== "string" ||
      !/^[a-f0-9]{128}$/i.test(account.passwordHash) ||
      !validBudget(account.budget)
    )) {
      throw new Error("Account database has an unexpected format.");
    }
    store = saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  http.createServer(handleRequest).listen(port, host, () => {
    console.log(`Budget Planner running at http://127.0.0.1:${port}`);
  });
}

start().catch(error => {
  console.error("Could not start the Budget Planner server:", error.message);
  process.exitCode = 1;
});
