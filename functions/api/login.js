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
        {
          ok: false,
          error: "EMAIL_REQUIRED",
          message: "البريد الإلكتروني مطلوب."
        },
        400
      );
    }

    if (!isValidEmail(email)) {
      return json(
        {
          ok: false,
          error: "INVALID_EMAIL",
          message: "البريد الإلكتروني غير صحيح."
        },
        400
      );
    }

    if (!password) {
      return json(
        {
          ok: false,
          error: "PASSWORD_REQUIRED",
          message: "كلمة المرور مطلوبة."
        },
        400
      );
    }

    const user = await db
      .prepare(`
        SELECT
          email,
          password_hash,
          salt_b64,
          activated
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
          error: "INVALID_CREDENTIALS",
          message: "بيانات الدخول غير صحيحة."
        },
        401
      );
    }

    const passwordOk = await verifyPassword(
      password,
      String(user.password_hash || ""),
      String(user.salt_b64 || "")
    );

    if (!passwordOk) {
      return json(
        {
          ok: false,
          error: "INVALID_CREDENTIALS",
          message: "بيانات الدخول غير صحيحة."
        },
        401
      );
    }

    const token = generateToken();
    const now = Date.now();

    await db.batch([
      db.prepare(`
        INSERT INTO sessions (
          token,
          email,
          device_id,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)
      `).bind(token, email, deviceId, now),

      db.prepare(`
        UPDATE users
        SET updated_at = ?2
        WHERE email = ?1
      `).bind(email, now)
    ]);

    return json({
      ok: true,
      token,
      email,
      activated: Number(user.activated || 0) === 1,
      user: {
        email,
        activated: Number(user.activated || 0) === 1
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

async function verifyPassword(password, savedHashB64, savedSaltB64) {
  if (!password || !savedHashB64 || !savedSaltB64) return false;

  const enc = new TextEncoder();
  const salt = base64ToBytes(savedSaltB64);

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

  const calculatedHashB64 = bytesToBase64(new Uint8Array(bits));
  return timingSafeEqual(calculatedHashB64, savedHashB64);
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

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function timingSafeEqual(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");

  if (aa.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }

  return diff === 0;
}
