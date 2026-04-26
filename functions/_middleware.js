export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (isBypassedPath(path)) {
    return next();
  }

  if (!isProtectedPage(path)) {
    return next();
  }

  const db = getDb(env);

  if (!db) {
    return redirectToActivate(url, "db");
  }

  try {
    await ensureSchema(db);

    const token = readAuthTokenFromCookies(request);

    if (!token) {
      return redirectToActivate(url, "login");
    }

    const session = await db
      .prepare(
        `SELECT
          s.token,
          s.email,
          s.device_id,
          s.created_at,
          s.expires_at,
          u.activated
        FROM sessions s
        LEFT JOIN users u
          ON u.email = s.email
        WHERE s.token = ?
        LIMIT 1`
      )
      .bind(token)
      .first();

    if (!session || !session.email) {
      return redirectToActivate(url, "login", true);
    }

    const expiresMs = Date.parse(session.expires_at || "");

    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
      await db
        .prepare("DELETE FROM sessions WHERE token = ?")
        .bind(token)
        .run();

      return redirectToActivate(url, "expired", true);
    }

    const isActivated = Number(session.activated || 0) === 1;

    if (!isActivated) {
      return redirectToActivate(url, "activate");
    }

    return next();
  } catch (error) {
    return redirectToActivate(url, "guard");
  }
}

function isProtectedPage(path) {
  return (
    path === "/" ||
    path === "/index" ||
    path === "/index.html" ||
    path === "/game" ||
    path === "/game.html"
  );
}

function isBypassedPath(path) {
  if (
    path.startsWith("/api/") ||
    path.startsWith("/api2/") ||
    path === "/activate" ||
    path === "/activate.html" ||
    path === "/buzz" ||
    path === "/buzz.html" ||
    path === "/control" ||
    path === "/control.html"
  ) {
    return true;
  }

  return hasStaticFileExtension(path);
}

function hasStaticFileExtension(path) {
  return /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|mp3|wav|ogg|m4a|mp4|webm|woff|woff2|ttf|otf|eot|json|txt|map)$/i.test(path);
}

function normalizePath(pathname) {
  const path = String(pathname || "").trim();
  if (!path) return "/";
  return path.toLowerCase();
}

function getDb(env) {
  return (
    env.DB ||
    env.AUTH_DB ||
    env.FAMILYFEUD_DB ||
    env.FAMILY_FEUD_DB ||
    null
  );
}

async function ensureSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        device_id TEXT,
        activated INTEGER NOT NULL DEFAULT 0,
        activated_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        device_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'NEW',
        email TEXT,
        device_id TEXT,
        activated_at TEXT,
        created_at TEXT
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        email TEXT NOT NULL,
        device_id TEXT,
        activated_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email)")
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_codes_email ON codes(email)")
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_activations_email ON activations(email)")
    .run();
}

function readAuthTokenFromCookies(request) {
  const cookieHeader = String(request.headers.get("Cookie") || "");

  if (!cookieHeader) return "";

  const cookies = parseCookies(cookieHeader);

  return String(
    cookies["familyfeud_token_v1"] ||
    cookies["familyfeud_token"] ||
    cookies["sandooq_token_v1"] ||
    cookies["sandooq_token"] ||
    cookies["token"] ||
    ""
  ).trim();
}

function parseCookies(cookieHeader) {
  const out = {};
  const parts = cookieHeader.split(";");

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (!key) continue;

    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }

  return out;
}

function redirectToActivate(currentUrl, reason = "", clearToken = false) {
  const target = new URL(currentUrl.origin + "/activate.html");
  target.searchParams.set("from", currentUrl.pathname || "/");

  if (reason) {
    target.searchParams.set("reason", reason);
  }

  const headers = new Headers();
  headers.set("Location", target.toString());
  headers.set("Cache-Control", "no-store");

  if (clearToken) {
    headers.append("Set-Cookie", buildExpiredCookie("familyfeud_token_v1"));
    headers.append("Set-Cookie", buildExpiredCookie("familyfeud_token"));
    headers.append("Set-Cookie", buildExpiredCookie("sandooq_token_v1"));
    headers.append("Set-Cookie", buildExpiredCookie("sandooq_token"));
    headers.append("Set-Cookie", buildExpiredCookie("token"));
  }

  return new Response(null, {
    status: 302,
    headers
  });
}

function buildExpiredCookie(name) {
  const secure = "";
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}
