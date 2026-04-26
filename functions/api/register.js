export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json(
        {
          ok: false,
          error: "DB_BINDING_MISSING",
          message: "لم يتم العثور على ربط قاعدة البيانات D1.",
        },
        500
      );
    }

    await ensureSchema(db);

    const body = await readJson(context.request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "").trim();
    const deviceId = normalizeDeviceId(
      context.request.headers.get("X-Device-Id") ||
      body.deviceId ||
      body.device_id ||
      ""
    );

    if (!email) {
      return json(
        { ok: false, error: "EMAIL_REQUIRED", message: "البريد الإلكتروني مطلوب." },
        400
      );
    }

    if (!isValidEmail(email)) {
      return json(
        { ok: false, error: "INVALID_EMAIL", message: "البريد الإلكتروني غير صحيح." },
        400
      );
    }

    if (!password) {
      return json(
        { ok: false, error: "PASSWORD_REQUIRED", message: "كلمة المرور مطلوبة." },
        400
      );
    }

    if (password.length < 6) {
      return json(
        { ok: false, error: "PASSWORD_TOO_SHORT", message: "كلمة المرور يجب أن تكون 6 أحرف أو أكثر." },
        400
      );
    }

    const existing = await db
      .prepare("SELECT email FROM users WHERE email = ? LIMIT 1")
      .bind(email)
      .first();

    if (existing) {
      return json(
        { ok: false, error: "EMAIL_ALREADY_EXISTS", message: "هذا البريد مستخدم من قبل." },
        409
      );
    }

    const salt = randomToken(24);
    const passwordHash = await sha256(`${salt}:${password}`);
    const now = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO users (
          email,
          password_hash,
          salt,
          device_id,
          activated,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(email, passwordHash, salt, deviceId, 0, now, now)
      .run();

    const token = randomToken(48);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    await db
      .prepare(
        `INSERT INTO sessions (
          token,
          email,
          device_id,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(token, email, deviceId, now, expiresAt)
      .run();

    return json(
      {
        ok: true,
        token,
        email,
        user: {
          email,
          activated: false,
          is_activated: false,
        },
        message: "تم إنشاء الحساب بنجاح.",
      },
      200
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: "SERVER_ERROR",
        message: error?.message || "حدث خطأ في الخادم.",
      },
      500
    );
  }
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

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^\w.-]/g, "").slice(0, 160);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(length = 48) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);

  let out = "";
  for (const value of values) {
    out += chars[value % chars.length];
  }

  return out;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}
