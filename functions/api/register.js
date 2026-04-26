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

    const body = await readJson(context.request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "").trim();
    const deviceId = normalizeDeviceId(
      context.request.headers.get("X-Device-Id") ||
      body.deviceId ||
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
      .prepare(`SELECT email FROM users WHERE email = ?1 LIMIT 1`)
      .bind(email)
      .first();

    if (existing?.email) {
      return json(
        { ok: false, error: "EMAIL_ALREADY_EXISTS", message: "هذا البريد مستخدم من قبل." },
        409
      );
    }

    const { saltB64, hashB64 } = await hashPassword(password);
    const now = Date.now();
    const token = generateToken();

    await db.batch([
      db.prepare(`
        INSERT INTO users (
          email,
          password_hash,
          salt_b64,
          activated,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4)
      `).bind(email, hashB64, saltB64, now),

      db.prepare(`
        INSERT INTO sessions (
          token,
          email,
          device_id,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)
      `).bind(token, email, deviceId, now)
    ]);

    return json({
      ok: true,
      token,
      email,
      activated: false,
      user: {
        email,
        activated: false
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/unique/i.test(message) || /constraint/i.test(message)) {
      return json(
        { ok: false, error: "EMAIL_ALREADY_EXISTS", message: "هذا البريد مستخدم من قبل." },
        409
      );
    }

    return json(
      {
        ok: false,
        error: "SERVER_ERROR",
        message
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^\w-]/g, "").slice(0, 160);
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 150000,
      hash: "SHA-256"
    },
    key,
    256
  );

  return {
    saltB64: bytesToBase64(salt),
    hashB64: bytesToBase64(new Uint8Array(bits))
  };
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
