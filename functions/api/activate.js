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

    const token = getBearerToken(context.request);

    if (!token) {
      return json(
        {
          ok: false,
          error: "TOKEN_REQUIRED",
          message: "يجب تسجيل الدخول أولًا قبل التفعيل.",
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

    const expiresMs = Date.parse(session.expires_at || "");
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();

      return json(
        {
          ok: false,
          error: "SESSION_EXPIRED",
          message: "انتهت الجلسة، سجّل الدخول مرة أخرى.",
        },
        401
      );
    }

    const body = await readJson(context.request);
    const code = normalizeCode(body.code);
    const email = normalizeEmail(session.email || body.email);
    const deviceId = normalizeDeviceId(
      context.request.headers.get("X-Device-Id") ||
      session.device_id ||
      body.deviceId ||
      body.device_id ||
      ""
    );

    if (!code) {
      return json(
        {
          ok: false,
          error: "CODE_REQUIRED",
          message: "أدخل كود التفعيل أولًا.",
        },
        400
      );
    }

    const user = await db
      .prepare(
        `SELECT email, activated, activated_code, device_id
         FROM users
         WHERE email = ?
         LIMIT 1`
      )
      .bind(email)
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

    const currentActivated = Number(user.activated || 0) === 1;
    const currentCode = normalizeCode(user.activated_code || "");

    if (currentActivated && currentCode && currentCode === code) {
      return json(
        {
          ok: true,
          token,
          email,
          activated: true,
          is_activated: true,
          isActivated: true,
          has_access: true,
          can_play: true,
          message: "اللعبة مفعّلة مسبقًا على هذا الحساب.",
        },
        200
      );
    }

    if (currentActivated && currentCode && currentCode !== code) {
      return json(
        {
          ok: false,
          error: "ALREADY_ACTIVATED",
          message: "هذا الحساب مفعّل مسبقًا بكود آخر.",
        },
        409
      );
    }

    const codeRow = await db
      .prepare(
        `SELECT code, status, email, device_id, activated_at
         FROM codes
         WHERE code = ?
         LIMIT 1`
      )
      .bind(code)
      .first();

    if (!codeRow) {
      return json(
        {
          ok: false,
          error: "CODE_NOT_FOUND",
          message: "كود التفعيل غير موجود.",
        },
        404
      );
    }

    const codeStatus = String(codeRow.status || "").trim().toUpperCase();
    const codeEmail = normalizeEmail(codeRow.email || "");

    if (codeStatus === "USED" && codeEmail && codeEmail !== email) {
      return json(
        {
          ok: false,
          error: "CODE_ALREADY_USED",
          message: "هذا الكود مستخدم مسبقًا على حساب آخر.",
        },
        409
      );
    }

    const now = new Date().toISOString();

    if (codeStatus !== "USED") {
      const updateCode = await db
        .prepare(
          `UPDATE codes
           SET status = 'USED',
               email = ?,
               device_id = ?,
               activated_at = ?
           WHERE code = ?
             AND status != 'USED'`
        )
        .bind(email, deviceId, now, code)
        .run();

      const changes = Number(updateCode?.meta?.changes || 0);

      if (changes < 1) {
        return json(
          {
            ok: false,
            error: "CODE_ALREADY_USED",
            message: "هذا الكود مستخدم مسبقًا.",
          },
          409
        );
      }
    }

    await db
      .prepare(
        `UPDATE users
         SET activated = 1,
             activated_code = ?,
             device_id = ?,
             updated_at = ?
         WHERE email = ?`
      )
      .bind(code, deviceId, now, email)
      .run();

    await db
      .prepare(
        `INSERT INTO activations (
          code,
          email,
          device_id,
          activated_at
        ) VALUES (?, ?, ?, ?)`
      )
      .bind(code, email, deviceId, now)
      .run();

    return json(
      {
        ok: true,
        token,
        email,
        activated: true,
        is_activated: true,
        isActivated: true,
        has_access: true,
        can_play: true,
        user: {
          email,
          activated: true,
          is_activated: true,
          isActivated: true,
          activated_code: code,
          device_id: deviceId,
        },
        message: "تم تفعيل اللعبة بنجاح.",
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

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (match && match[1]) {
    return String(match[1]).trim();
  }

  return "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^\w.-]/g, "").slice(0, 160);
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
