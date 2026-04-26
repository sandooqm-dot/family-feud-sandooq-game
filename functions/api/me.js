export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export async function onRequestGet(context) {
  try {
    const db = getDb(context.env);
    if (!db) {
      return json(
        {
          ok: false,
          error: "DB_BINDING_MISSING",
          message: "لم يتم العثور على ربط قاعدة البيانات D1."
        },
        500
      );
    }

    await ensureSchema(db);

    const token = readBearerToken(context.request);
    if (!token) {
      return json(
        {
          ok: false,
          error: "TOKEN_REQUIRED",
          message: "يجب تسجيل الدخول أولًا."
        },
        401
      );
    }

    const session = await db
      .prepare(`
        SELECT
          token,
          email,
          device_id,
          created_at,
          updated_at
        FROM sessions
        WHERE token = ?1
        LIMIT 1
      `)
      .bind(token)
      .first();

    if (!session?.email) {
      return json(
        {
          ok: false,
          error: "INVALID_TOKEN",
          message: "الجلسة غير صالحة أو منتهية."
        },
        401
      );
    }

    const user = await db
      .prepare(`
        SELECT
          email,
          activated,
          created_at,
          updated_at
        FROM users
        WHERE email = ?1
        LIMIT 1
      `)
      .bind(String(session.email))
      .first();

    if (!user?.email) {
      return json(
        {
          ok: false,
          error: "USER_NOT_FOUND",
          message: "الحساب غير موجود."
        },
        404
      );
    }

    const now = Date.now();

    await db
      .prepare(`
        UPDATE sessions
        SET updated_at = ?2
        WHERE token = ?1
      `)
      .bind(token, now)
      .run();

    return json({
      ok: true,
      email: String(user.email),
      activated: Number(user.activated || 0) === 1,
      is_activated: Number(user.activated || 0) === 1,
      needs_activation: Number(user.activated || 0) !== 1,
      session: {
        token: String(session.token),
        email: String(session.email),
        device_id: String(session.device_id || ""),
        created_at: Number(session.created_at || 0),
        updated_at: now
      },
      user: {
        email: String(user.email),
        activated: Number(user.activated || 0) === 1,
        is_activated: Number(user.activated || 0) === 1,
        created_at: Number(user.created_at || 0),
        updated_at: Number(user.updated_at || 0)
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "SERVER_ERROR",
        message: error instanceof Error ? error.message : String(error)
      },
      500
    );
  }
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

    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
  `);
}

function readBearerToken(request) {
  const auth = String(request.headers.get("Authorization") || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}
