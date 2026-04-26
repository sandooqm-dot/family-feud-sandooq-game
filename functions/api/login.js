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

    if (!password) {
      return json(
        { ok: false, error: "PASSWORD_REQUIRED", message: "كلمة المرور مطلوبة." },
        400
      );
    }

    const user = await db
      .prepare(
        `SELECT email, password_hash, salt, device_id, activated, activated_code
         FROM users
         WHERE email = ?
         LIMIT 1`
      )
      .bind(email)
      .first();

    if (!user) {
      return json(
        { ok: false, error: "USER_NOT_FOUND", message: "هذا الحساب غير موجود." },
        404
      );
    }

    const passwordHash = await sha256(`${user.salt}:${password}`);

    if (passwordHash !== user.password_hash) {
      return json(
        { ok: false, error: "INVALID_CREDENTIALS", message: "بيانات الدخول غير صحيحة." },
        401
      );
    }

    const now = new Date().toISOString();
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

    const activated = Number(user.activated || 0) === 1;

    return json(
      {
        ok: true,
        token,
        email,
        activated,
        is_activated: activated,
        isActivated: activated,
        has_access: activated,
        can_play: activated,
        needs_activation: !activated,
        user: {
          email,
          activated,
          is_activated: activated,
          isActivated: activated,
          activated_code: user.activated_code || "",
          device_id: user.device_id || "",
        },
        message: "تم تسجيل الدخول بنجاح.",
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
