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
      .prepare(`
        SELECT
          s.token,
          s.email,
          s.device_id,
          s.created_at,
          s.updated_at,
          u.activated
        FROM sessions s
        LEFT JOIN users u
          ON u.email = s.email
        WHERE s.token = ?1
        LIMIT 1
      `)
      .bind(token)
      .first();

    if (!session?.email) {
      return redirectToActivate(url, "login", true);
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
  return path === "/" ||
    path === "/index" ||
    path === "/index.html" ||
    path === "/game" ||
    path === "/game.html";
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
    env.BDON_KALAM_AUTH ||
    null
  );
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt_b64 TEXT NOT NULL,
      activated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      status TEXT DEFAULT 'NEW',
      used_by_email TEXT,
      used_by_device TEXT,
      activated_at INTEGER,
      created_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
    CREATE INDEX IF NOT EXISTS idx_codes_used_by_email ON codes(used_by_email);
  `);
}

function readAuthTokenFromCookies(request) {
  const cookieHeader = String(request.headers.get("Cookie") || "");
  if (!cookieHeader) return "";

  const cookies = parseCookies(cookieHeader);

  return (
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

  const headers = {
    Location: target.toString(),
    "Cache-Control": "no-store"
  };

  if (clearToken) {
    const expired = [
      buildExpiredCookie("familyfeud_token_v1"),
      buildExpiredCookie("familyfeud_token"),
      buildExpiredCookie("sandooq_token_v1"),
      buildExpiredCookie("sandooq_token"),
      buildExpiredCookie("token")
    ];
    headers["Set-Cookie"] = expired[0];
    return new Response(null, {
      status: 302,
      headers: appendExtraSetCookies(headers, expired.slice(1))
    });
  }

  return new Response(null, {
    status: 302,
    headers
  });
}

function buildExpiredCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function appendExtraSetCookies(headers, cookies) {
  const responseHeaders = new Headers(headers);
  for (const cookie of cookies) {
    responseHeaders.append("Set-Cookie", cookie);
  }
  return responseHeaders;
}
