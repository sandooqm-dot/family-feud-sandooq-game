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

  const newSystemAccess = await checkNewSystemAccess(request, url);

  if (newSystemAccess.blocked) {
    return newSystemAccess.response;
  }

  if (newSystemAccess.allowed) {
    if (newSystemAccess.redirectCleanUrl) {
      return redirectToCleanUrl(url, newSystemAccess.cookies || []);
    }

    const response = await next();
    return appendSetCookies(response, newSystemAccess.cookies || []);
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

const NEW_AUTH_API_BASE = "https://sandooq-games-api.sandooq-m.workers.dev";
const NEW_GAME_ID = "family-feud";
const NEW_TOKEN_COOKIE = "sandooq_site_token_v1";
const NEW_DEVICE_COOKIE = "sandooq_site_device_v1";
const NEW_TOKEN_QUERY_KEYS = ["sg_token", "sandooq_token", "access_token", "token"];
const NEW_DEVICE_QUERY_KEYS = ["sg_device", "device_token", "device"];

async function checkNewSystemAccess(request, currentUrl) {
  const cookieHeader = String(request.headers.get("Cookie") || "");
  const cookies = cookieHeader ? parseCookies(cookieHeader) : {};

  const tokenFromQuery = readFirstQueryValue(currentUrl, NEW_TOKEN_QUERY_KEYS);
  const tokenFromCookie = String(
    cookies[NEW_TOKEN_COOKIE] ||
    cookies["sandooq_auth_token_v1"] ||
    ""
  ).trim();

  const token = tokenFromQuery || tokenFromCookie;

  if (!token) {
    return { allowed: false, blocked: false };
  }

  const isTemporary = isTemporaryRequest(currentUrl);
  const queryDevice = readFirstQueryValue(currentUrl, NEW_DEVICE_QUERY_KEYS);
  const cookieDevice = String(cookies[NEW_DEVICE_COOKIE] || "").trim();
  const generatedDevice = (!queryDevice && !cookieDevice && !isTemporary) ? createNewDeviceToken() : "";

  const deviceToken = isTemporary
    ? (queryDevice || createTemporaryDeviceToken())
    : (queryDevice || cookieDevice || generatedDevice);

  const cookiesToSet = [];

  if (tokenFromQuery && !isTemporary) {
    cookiesToSet.push(buildCookie(NEW_TOKEN_COOKIE, token, currentUrl, 60 * 60 * 24 * 180));
  }

  if ((queryDevice || generatedDevice) && !isTemporary && deviceToken) {
    cookiesToSet.push(buildCookie(NEW_DEVICE_COOKIE, deviceToken, currentUrl, 60 * 60 * 24 * 365));
  }

  try {
    const apiResponse = await fetch(`${NEW_AUTH_API_BASE}/api/game/access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        game_id: NEW_GAME_ID,
        device_token: deviceToken,
        device_name: "Family Feud Web",
        is_temporary: isTemporary
      }),
      cache: "no-store"
    });

    let data = {};
    try {
      data = await apiResponse.json();
    } catch (_) {}

    if (apiResponse.ok && data && data.allowed === true) {
      return {
        allowed: true,
        blocked: false,
        cookies: cookiesToSet,
        temporaryMode: isTemporary,
        // مهم: الجلسة المؤقتة لا نخزنها في كوكي ولا ننظف الرابط،
        // لأن تنظيف الرابط يحذف sg_token و sg_temp ثم ترجع الصفحة بدون صلاحية.
        // لذلك المتصفح الخفي يفتح مباشرة من نفس الطلب، وإذا أغلق الصفحة يدخل من الموقع مرة أخرى.
        redirectCleanUrl: !isTemporary && hasNewAccessQuery(currentUrl)
      };
    }

    if (data && data.error === "DEVICE_LIMIT_REACHED") {
      return {
        allowed: false,
        blocked: true,
        response: deviceLimitResponse(data)
      };
    }

    return { allowed: false, blocked: false };
  } catch (_) {
    return { allowed: false, blocked: false };
  }
}

function readFirstQueryValue(url, keys) {
  for (const key of keys) {
    const value = String(url.searchParams.get(key) || "").trim();
    if (value) return value;
  }

  return "";
}

function hasNewAccessQuery(url) {
  const keys = [
    ...NEW_TOKEN_QUERY_KEYS,
    ...NEW_DEVICE_QUERY_KEYS,
    "sg_temp",
    "sg_private",
    "private",
    "temporary",
    "is_temporary"
  ];

  return keys.some(key => url.searchParams.has(key));
}

function isTemporaryRequest(url) {
  const value = String(
    url.searchParams.get("sg_temp") ||
    url.searchParams.get("sg_private") ||
    url.searchParams.get("private") ||
    url.searchParams.get("temporary") ||
    url.searchParams.get("is_temporary") ||
    ""
  ).trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes";
}

function createNewDeviceToken() {
  try {
    if (crypto.randomUUID) return "ffdev_" + crypto.randomUUID();
  } catch (_) {}

  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return "ffdev_" + Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch (_) {}

  return "ffdev_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function createTemporaryDeviceToken() {
  try {
    if (crypto.randomUUID) return "fftemp_" + crypto.randomUUID();
  } catch (_) {}

  return "fftemp_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function buildCookie(name, value, currentUrl, maxAgeSeconds) {
  const secure = currentUrl.protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

function redirectToCleanUrl(currentUrl, cookies = []) {
  const target = new URL(currentUrl.toString());

  [
    ...NEW_TOKEN_QUERY_KEYS,
    ...NEW_DEVICE_QUERY_KEYS,
    "sg_temp",
    "sg_private",
    "private",
    "temporary",
    "is_temporary"
  ].forEach(key => target.searchParams.delete(key));

  const headers = new Headers();
  headers.set("Location", target.toString());
  headers.set("Cache-Control", "no-store");
  cookies.forEach(cookie => headers.append("Set-Cookie", cookie));

  return new Response(null, {
    status: 302,
    headers
  });
}

function appendSetCookies(response, cookies = []) {
  if (!cookies.length) return response;

  const headers = new Headers(response.headers);
  cookies.forEach(cookie => headers.append("Set-Cookie", cookie));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function deviceLimitResponse(data = {}) {
  const gameName = data?.game?.name || "هذه اللعبة";
  const message = data?.message || "وصلت للحد المسموح من الأجهزة لهذه اللعبة.";

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>حد الأجهزة | صندوق المسابقات</title>
  <style>
    *{box-sizing:border-box}
    body{
      margin:0;
      min-height:100dvh;
      display:grid;
      place-items:center;
      background:#075c82;
      color:#111827;
      font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;
      padding:22px;
    }
    .card{
      width:min(560px,100%);
      background:#fff;
      border:5px solid #151515;
      border-radius:28px;
      padding:24px;
      text-align:center;
      box-shadow:0 10px 0 rgba(0,0,0,.18);
    }
    h1{margin:0 0 12px;font-size:28px;font-weight:950}
    p{margin:0;color:#394354;font-size:17px;font-weight:800;line-height:1.8}
    .game{
      margin:14px auto 0;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      background:#f7b638;
      border:3px solid #151515;
      border-radius:999px;
      padding:8px 14px;
      font-weight:950;
    }
    a{
      margin-top:18px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:48px;
      padding:8px 18px;
      border-radius:999px;
      background:#2faf72;
      color:#fff;
      text-decoration:none;
      font-weight:950;
      border:3px solid #151515;
      box-shadow:0 5px 0 rgba(0,0,0,.16);
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>وصلت للحد المسموح من الأجهزة</h1>
    <p>${escapeHtml(message)}</p>
    <div class="game">${escapeHtml(gameName)}</div>
    <br />
    <a href="https://sandooq-games.com/support.html">التواصل مع الدعم</a>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 409,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
