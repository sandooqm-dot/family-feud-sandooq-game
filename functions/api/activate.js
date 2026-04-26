export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export async function onRequestPost(context) {
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

    const body = await readJson(context.request);
    const code = normalizeCode(body.code);
    const deviceId = normalizeDeviceId(
      context.request.headers.get("X-Device-Id") ||
      body.deviceId ||
      ""
    );

    if (!code) {
      return json(
        {
          ok: false,
          error: "CODE_REQUIRED",
          message: "كود التفعيل مطلوب."
        },
        400
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

    const email = normalizeEmail(session.email);

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
      .bind(email)
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

    const codeRow = await db
      .prepare(`
        SELECT
          code,
          status,
          used_by_email,
          used_by_device,
          activated_at,
          created_at
        FROM codes
        WHERE code = ?1
        LIMIT 1
      `)
      .bind(code)
      .first();

    if (!codeRow?.code) {
      return json(
        {
          ok: false,
          error: "INVALID_CODE",
          message: "كود التفعيل غير صحيح."
        },
        404
      );
    }

    const usedByEmail = normalizeEmail(codeRow.used_by_email);
    const currentStatus = String(codeRow.status || "NEW").trim().toUpperCase();
    const now = Date.now();

    if (usedByEmail) {
      if (usedByEmail !== email) {
        return json(
          {
            ok: false,
            error: "CODE_ALREADY_USED",
            message: "هذا الكود مستخدم مسبقًا على حساب آخر."
          },
          409
        );
      }

      await db.batch([
        db.prepare(`
          UPDATE users
          SET activated = 1,
              updated_at = ?2
          WHERE email = ?1
        `).bind(email, now),

        db.prepare(`
          UPDATE sessions
          SET updated_at = ?2,
              device_id = CASE
                WHEN (?3 != '') THEN ?3
                ELSE device_id
              END
          WHERE token = ?1
        `).bind(token, now, deviceId)
      ]);

      return json({
        ok: true,
        activated: true,
        email,
        code,
        message: "تم تفعيل اللعبة مسبقًا على هذا الحساب.",
        user: {
          email,
          activated: true
        }
      });
    }

    if (currentStatus === "USED") {
      return json(
        {
          ok: false,
          error: "CODE_ALREADY_USED",
          message: "هذا الكود مستخدم مسبقًا."
        },
        409
      );
    }

    const claimResult = await db
      .prepare(`
        UPDATE codes
        SET status = 'USED',
            used_by_email = ?2,
            used_by_device = ?3,
            activated_at = ?4
        WHERE code = ?1
          AND (used_by_email IS NULL OR used_by_email = '')
          AND (status IS NULL OR status = '' OR UPPER(status) = 'NEW')
      `)
      .bind(code, email, deviceId, now)
      .run();

    const changed = Number(claimResult?.meta?.changes || 0);

    if (changed !== 1) {
      const latestCodeRow = await db
        .prepare(`
          SELECT
            code,
            status,
            used_by_email,
            used_by_device,
            activated_at
          FROM codes
          WHERE code = ?1
          LIMIT 1
        `)
        .bind(code)
        .first();

      const latestUsedByEmail = normalizeEmail(latestCodeRow?.used_by_email);

      if (latestUsedByEmail && latestUsedByEmail !== email) {
        return json(
          {
            ok: false,
            error: "CODE_ALREADY_USED",
            message: "هذا الكود مستخدم مسبقًا على حساب آخر."
          },
          409
        );
      }

      if (latestUsedByEmail === email) {
        await db.batch([
          db.prepare(`
            UPDATE users
            SET activated = 1,
                updated_at = ?2
            WHERE email = ?1
          `).bind(email, now),

          db.prepare(`
            UPDATE sessions
            SET updated_at = ?2,
                device_id = CASE
                  WHEN (?3 != '') THEN ?3
                  ELSE device_id
                END
            WHERE token = ?1
          `).bind(token, now, deviceId)
        ]);

        return json({
          ok: true,
          activated: true,
          email,
          code,
          message: "تم تفعيل اللعبة مسبقًا على هذا الحساب.",
          user: {
            email,
            activated: true
          }
        });
      }

      return json(
        {
          ok: false,
          error: "ACTIVATION_FAILED",
          message: "تعذر تفعيل الكود الآن. حاول مرة أخرى."
        },
        409
      );
    }

    await db.batch([
      db.prepare(`
        UPDATE users
        SET activated = 1,
            updated_at = ?2
        WHERE email = ?1
      `).bind(email, now),

      db.prepare(`
        UPDATE sessions
        SET updated_at = ?2,
            device_id = CASE
              WHEN (?3 != '') THEN ?3
              ELSE device_id
            END
        WHERE token = ?1
      `).bind(token, now, deviceId)
    ]);

    return json({
      ok: true,
      activated: true,
      email,
      code,
      message: "تم تفعيل اللعبة بنجاح.",
      user: {
        email,
        activated: true
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

function readBearerToken(request) {
  const auth = String(request.headers.get("Authorization") || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^\w-]/g, "").slice(0, 160);
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
