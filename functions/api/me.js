export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet(context) {
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

    const token = getBearerToken(context.request);

    if (!token) {
      return json(
        {
          ok: false,
          error: "TOKEN_REQUIRED",
          message: "يجب تسجيل الدخول أولًا.",
        },
        401
      );
    }

    const session = await db
      .prepare(
        `SELECT token, email, device_id, expires_at
         FROM sessions
         WHERE token = ?
         LIMIT 1`
      )
      .bind(token)
      .first();

    if (!session) {
      return json(
        {
          ok: false,
          error: "INVALID_TOKEN",
          message: "انتهت الجلسة، سجّل الدخول مرة أخرى.",
        },
        401
      );
    }

    const nowMs = Date.now();
    const expiresMs = Date.parse(session.expires_at || "");

    if (Number.isFinite(expiresMs) && expiresMs < nowMs) {
      await db
        .prepare("DELETE FROM sessions WHERE token = ?")
        .bind(token)
        .run();

      return json(
        {
          ok: false,
          error: "SESSION_EXPIRED",
          message: "انتهت الجلسة، سجّل الدخول مرة أخرى.",
        },
        401
      );
    }

    const user = await db
      .prepare(
        `SELECT email, activated, activated_code, device_id, created_at, updated_at
         FROM users
         WHERE email = ?
         LIMIT 1`
      )
      .bind(session.email)
      .first();

    if (!user) {
      return json(
        {
          ok: false,
          error: "USER_NOT_FOUND",
          message: "الحساب غير موجود.",
        },
        404
      );
    }

    const deviceId = normalizeDeviceId(
      context.request.headers.get("X-Device-Id") || ""
    );

    const activated = Number(user.activated || 0) === 1;
    const accountHasActivation = !!user.activated_code;
    const deviceLocked =
      activated &&
      !!user.device_id &&
      !!deviceId &&
      String(user.device_id) !== String(deviceId);

    return json(
      {
        ok: true,
        email: user.email,
        activated,
        is_activated: activated,
        isActivated: activated,
        has_access: activated,
        can_play: activated,
        needs_activation: !activated,
        device_locked: deviceLocked,
        deviceLocked,
        account_has_activation: accountHasActivation,
        accountHasActivation: accountHasActivation,
        user: {
          email: user.email,
          activated,
          is_activated: activated,
          isActivated: activated,
          activated_code: user.activated_code || "",
          device_id: user.device_id || "",
          created_at: user.created_at || "",
          updated_at: user.updated_at || "",
        },
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

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (match && match[1]) {
    return String(match[1]).trim();
  }

  return "";
}

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^\w.-]/g, "").slice(0, 160);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
