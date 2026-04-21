export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/buzz/pusher-config" && request.method === "GET") {
        const room = normalizeRoom(url.searchParams.get("room"));
        if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

        return json({
          ok: true,
          key: env.PUSHER_KEY || "",
          cluster: env.PUSHER_CLUSTER || "",
          channel: channelNameForRoom(room),
          authEndpoint: `/api/buzz/pusher/auth?room=${encodeURIComponent(room)}`
        });
      }

      if (url.pathname === "/api/buzz/pusher/auth" && request.method === "POST") {
        const room = normalizeRoom(url.searchParams.get("room"));
        if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

        const contentType = request.headers.get("content-type") || "";
        let socketId = "";
        let channelName = "";

        if (contentType.includes("application/json")) {
          const body = await request.json().catch(() => ({}));
          socketId = String(body.socket_id || "");
          channelName = String(body.channel_name || "");
        } else {
          const form = await request.formData().catch(() => null);
          socketId = String(form?.get("socket_id") || "");
          channelName = String(form?.get("channel_name") || "");
        }

        if (!socketId || !channelName) {
          return json({ ok: false, error: "INVALID_PUSHER_AUTH_PAYLOAD" }, 400);
        }

        const expectedChannel = channelNameForRoom(room);
        if (channelName !== expectedChannel) {
          return json({ ok: false, error: "CHANNEL_ROOM_MISMATCH" }, 400);
        }

        const auth = await buildPusherChannelAuth(
          env.PUSHER_KEY,
          env.PUSHER_SECRET,
          socketId,
          channelName
        );

        return json({ auth });
      }

      if (!url.pathname.startsWith("/api/buzz/")) {
        return json({ ok: false, error: "NOT_FOUND" }, 404);
      }

      const room = normalizeRoom(url.searchParams.get("room"));
      if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

      const id = env.BUZZ_ROOMS.idFromName(`buzz:${room}`);
      const stub = env.BUZZ_ROOMS.get(id);

      const doUrl = new URL(request.url);
      doUrl.searchParams.set("room", room);

      return await stub.fetch(new Request(doUrl.toString(), request));
    } catch (error) {
      return json(
        {
          ok: false,
          error: "SERVER_ERROR",
          details: error instanceof Error ? error.message : String(error)
        },
        500
      );
    }
  }
};

export class BuzzRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cache = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/buzz/state") {
        const state = await this.loadState(url.searchParams.get("room"));
        this.cleanupPlayers(state);
        await this.saveState(state, false);
        return json({ ok: true, state: publicState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/buzz/join") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const body = await safeJson(request);

        const playerId = normalizeId(body.playerId);
        const name = normalizePlayerName(body.name);
        const team = normalizeTeam(body.team);

        if (!playerId) return json({ ok: false, error: "PLAYER_ID_REQUIRED" }, 400);
        if (!name) return json({ ok: false, error: "PLAYER_NAME_REQUIRED" }, 400);
        if (!team) return json({ ok: false, error: "TEAM_REQUIRED" }, 400);

        const state = await this.loadState(room);
        this.cleanupPlayers(state);

        state.players[playerId] = {
          id: playerId,
          name,
          team,
          lastSeenAt: Date.now()
        };

        state.updatedAt = Date.now();
        state.version += 1;

        await this.saveState(state, true);
        return json({ ok: true, state: publicState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/buzz/press") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const body = await safeJson(request);

        const playerId = normalizeId(body.playerId);
        const name = normalizePlayerName(body.name);
        const team = normalizeTeam(body.team);

        if (!playerId) return json({ ok: false, error: "PLAYER_ID_REQUIRED" }, 400);
        if (!name) return json({ ok: false, error: "PLAYER_NAME_REQUIRED" }, 400);
        if (!team) return json({ ok: false, error: "TEAM_REQUIRED" }, 400);

        const state = await this.loadState(room);
        this.cleanupPlayers(state);

        state.players[playerId] = {
          id: playerId,
          name,
          team,
          lastSeenAt: Date.now()
        };

        if (!state.enabled) {
          return json({
            ok: false,
            error: "BUZZ_DISABLED",
            state: publicState(state)
          }, 409);
        }

        if (state.firstBuzz) {
          return json({
            ok: false,
            error: "ALREADY_BUZZED",
            state: publicState(state)
          }, 409);
        }

        state.firstBuzz = {
          playerId,
          name,
          team,
          at: Date.now()
        };

        state.updatedAt = Date.now();
        state.version += 1;

        await this.saveState(state, true);
        return json({ ok: true, accepted: true, state: publicState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/buzz/toggle") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const body = await safeJson(request);

        if (typeof body.enabled !== "boolean") {
          return json({ ok: false, error: "ENABLED_BOOLEAN_REQUIRED" }, 400);
        }

        const state = await this.loadState(room);
        this.cleanupPlayers(state);

        state.enabled = body.enabled;

        // حسب الاتفاق:
        // الأحمر = تجميد + تصفير
        // الأخضر = فتح جرس جديد نظيف
        state.firstBuzz = null;

        state.updatedAt = Date.now();
        state.version += 1;

        await this.saveState(state, true);
        return json({ ok: true, state: publicState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/buzz/reset") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const state = await this.loadState(room);
        this.cleanupPlayers(state);

        state.firstBuzz = null;
        state.updatedAt = Date.now();
        state.version += 1;

        await this.saveState(state, true);
        return json({ ok: true, state: publicState(state) });
      }

      return json({ ok: false, error: "NOT_FOUND" }, 404);
    } catch (error) {
      return json(
        {
          ok: false,
          error: "DO_SERVER_ERROR",
          details: error instanceof Error ? error.message : String(error)
        },
        500
      );
    }
  }

  async loadState(room) {
    if (this.cache) return this.cache;

    const stored = await this.state.storage.get("state");
    if (stored) {
      this.cache = stored;
      return this.cache;
    }

    this.cache = {
      room: normalizeRoom(room) || "default",
      enabled: true,
      firstBuzz: null,
      players: {},
      updatedAt: Date.now(),
      version: 1
    };

    await this.state.storage.put("state", this.cache);
    return this.cache;
  }

  cleanupPlayers(state) {
    const now = Date.now();
    const maxIdleMs = 1000 * 60 * 60 * 12; // 12 hours

    for (const [playerId, player] of Object.entries(state.players)) {
      if (!player?.lastSeenAt || now - player.lastSeenAt > maxIdleMs) {
        delete state.players[playerId];
      }
    }
  }

  async saveState(state, shouldBroadcast) {
    this.cache = state;
    await this.state.storage.put("state", state);

    if (shouldBroadcast) {
      await this.broadcastState(state);
    }
  }

  async broadcastState(state) {
    if (!this.env.PUSHER_APP_ID || !this.env.PUSHER_KEY || !this.env.PUSHER_SECRET || !this.env.PUSHER_CLUSTER) {
      return;
    }

    const channel = channelNameForRoom(state.room);
    const eventName = "buzz-updated";
    const payload = publicState(state);

    try {
      await triggerPusherEvent(this.env, channel, eventName, payload);
    } catch (error) {
      console.error("PUSHER_TRIGGER_FAILED", error);
    }
  }
}

/* =========================
   Helpers
========================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
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

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeRoom(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  return v.replace(/[^a-z0-9_-]/g, "").slice(0, 64);
}

function normalizeId(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return v.replace(/[^\w-]/g, "").slice(0, 80);
}

function normalizePlayerName(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return v.slice(0, 60);
}

function normalizeTeam(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "team1" || v === "team2") return v;
  return "";
}

function publicState(state) {
  return {
    room: state.room,
    enabled: !!state.enabled,
    firstBuzz: state.firstBuzz
      ? {
          playerId: state.firstBuzz.playerId,
          name: state.firstBuzz.name,
          team: state.firstBuzz.team,
          at: state.firstBuzz.at
        }
      : null,
    players: Object.values(state.players || {}).map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team
    })),
    updatedAt: state.updatedAt,
    version: state.version
  };
}

function channelNameForRoom(room) {
  return `private-buzz-${room}`;
}

/* =========================
   Pusher Auth + Trigger
========================= */

async function buildPusherChannelAuth(key, secret, socketId, channelName) {
  const stringToSign = `${socketId}:${channelName}`;
  const signature = await hmacSha256Hex(secret, stringToSign);
  return `${key}:${signature}`;
}

async function triggerPusherEvent(env, channel, eventName, payload) {
  const path = `/apps/${env.PUSHER_APP_ID}/events`;
  const bodyObject = {
    name: eventName,
    channel,
    data: JSON.stringify(payload)
  };

  const body = JSON.stringify(bodyObject);
  const bodyMd5 = md5Hex(body);

  const params = {
    auth_key: env.PUSHER_KEY,
    auth_timestamp: Math.floor(Date.now() / 1000).toString(),
    auth_version: "1.0",
    body_md5: bodyMd5
  };

  const sortedQuery = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");

  const stringToSign = `POST\n${path}\n${sortedQuery}`;
  const signature = await hmacSha256Hex(env.PUSHER_SECRET, stringToSign);

  const url = new URL(`https://api-${env.PUSHER_CLUSTER}.pusher.com${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("auth_signature", signature);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pusher trigger failed: ${res.status} ${text}`);
  }
}

async function hmacSha256Hex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/* =========================
   MD5 (for Pusher REST auth)
========================= */

function md5Hex(str) {
  return binl2hex(core_md5(str2binl(unescape(encodeURIComponent(str))), str.length * 8));
}

function core_md5(x, len) {
  x[len >> 5] |= 0x80 << (len % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < x.length; i += 16) {
    const olda = a;
    const oldb = b;
    const oldc = c;
    const oldd = d;

    a = md5_ff(a, b, c, d, x[i + 0], 7, -680876936);
    d = md5_ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = md5_ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = md5_ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5_ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = md5_ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = md5_ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = md5_ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5_ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = md5_ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = md5_ff(c, d, a, b, x[i + 10], 17, -42063);
    b = md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5_ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = md5_ff(b, c, d, a, x[i + 15], 22, 1236535329);

    a = md5_gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = md5_gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = md5_gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = md5_gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = md5_gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = md5_gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = md5_gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5_gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = md5_gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = md5_gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = md5_gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5_gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = md5_gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = md5_gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = md5_hh(a, b, c, d, x[i + 5], 4, -378558);
    d = md5_hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = md5_hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5_hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = md5_hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = md5_hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5_hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = md5_hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = md5_hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = md5_hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5_hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = md5_hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = md5_hh(b, c, d, a, x[i + 2], 23, -995338651);

    a = md5_ii(a, b, c, d, x[i + 0], 6, -198630844);
    d = md5_ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = md5_ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5_ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = md5_ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = md5_ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5_ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = md5_ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = md5_ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5_ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = md5_ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = md5_ii(b, c, d, a, x[i + 9], 21, -343485551);

    a = safe_add(a, olda);
    b = safe_add(b, oldb);
    c = safe_add(c, oldc);
    d = safe_add(d, oldd);
  }

  return [a, b, c, d];
}

function md5_cmn(q, a, b, x, s, t) {
  return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b);
}
function md5_ff(a, b, c, d, x, s, t) {
  return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
}
function md5_gg(a, b, c, d, x, s, t) {
  return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
}
function md5_hh(a, b, c, d, x, s, t) {
  return md5_cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5_ii(a, b, c, d, x, s, t) {
  return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
}

function safe_add(x, y) {
  const lsw = (x & 0xffff) + (y & 0xffff);
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
}

function bit_rol(num, cnt) {
  return (num << cnt) | (num >>> (32 - cnt));
}

function str2binl(str) {
  const bin = [];
  const mask = 255;
  for (let i = 0; i < str.length * 8; i += 8) {
    bin[i >> 5] |= (str.charCodeAt(i / 8) & mask) << (i % 32);
  }
  return bin;
}

function binl2hex(binarray) {
  const hex_tab = "0123456789abcdef";
  let str = "";
  for (let i = 0; i < binarray.length * 4; i++) {
    str +=
      hex_tab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0x0f) +
      hex_tab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0x0f);
  }
  return str;
}
