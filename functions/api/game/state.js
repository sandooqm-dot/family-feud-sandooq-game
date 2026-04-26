const DEFAULT_ROOM = "family-feud-demo";

const EMPTY_QUESTION = {
  question: "نص السؤال",
  answers: []
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const db = getDb(env);
    if (!db) {
      return jsonResponse({
        ok: false,
        error: "لم يتم العثور على قاعدة البيانات D1."
      }, 500);
    }

    await ensureSchema(db);

    const url = new URL(request.url);
    const room = normalizeRoom(url.searchParams.get("room")) || DEFAULT_ROOM;

    let row = await db
      .prepare(`
        SELECT state_json
        FROM game_rooms
        WHERE room = ?1
        LIMIT 1
      `)
      .bind(room)
      .first();

    if (!row?.state_json) {
      const initialState = buildInitialState(room);

      await db
        .prepare(`
          INSERT OR REPLACE INTO game_rooms
            (room, state_json, updated_at)
          VALUES
            (?1, ?2, ?3)
        `)
        .bind(
          room,
          JSON.stringify(initialState),
          Date.now()
        )
        .run();

      return jsonResponse({
        ok: true,
        room,
        state: initialState
      });
    }

    const parsedState = safeParse(row.state_json);
    const state = normalizeState(parsedState, room);

    return jsonResponse({
      ok: true,
      room,
      state
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message || String(error)
    }, 500);
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
    CREATE TABLE IF NOT EXISTS game_rooms (
      room TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_game_rooms_updated_at
      ON game_rooms(updated_at);
  `);
}

function buildInitialState(room) {
  return {
    room,
    updatedAt: Date.now(),

    display: {
      showQuestion: false,
      question: EMPTY_QUESTION.question,
      team1Name: "الفريق الأول",
      team2Name: "الفريق الثاني",
      team1Score: 0,
      team2Score: 0,
      team1Strikes: 0,
      team2Strikes: 0,
      roundPoints: 0,
      answers: []
    },

    control: {
      currentQuestionIndex: 0,
      totalQuestions: 0,
      phase: "idle",
      currentTurnTeam: "",
      confrontationWinner: "",
      stealingTeam: "",
      firstBuzzName: "",
      firstBuzzTeam: ""
    },

    buzz: {
      enabled: true,
      firstBuzz: null
    },

    effects: {
      displayErrorSeq: 0,
      displayErrorReason: ""
    }
  };
}

function normalizeState(raw, room) {
  const fallback = buildInitialState(room);
  const source = raw && typeof raw === "object" ? raw : fallback;

  const display = source.display || {};
  const control = source.control || {};
  const buzz = source.buzz || {};
  const effects = source.effects || {};

  return {
    room,
    updatedAt: toSafeNumber(source.updatedAt) || Date.now(),

    display: {
      showQuestion: typeof display.showQuestion === "boolean" ? display.showQuestion : false,
      question: cleanText(display.question) || "نص السؤال",
      team1Name: cleanText(display.team1Name) || "الفريق الأول",
      team2Name: cleanText(display.team2Name) || "الفريق الثاني",
      team1Score: toSafeNumber(display.team1Score),
      team2Score: toSafeNumber(display.team2Score),
      team1Strikes: clampStrike(display.team1Strikes),
      team2Strikes: clampStrike(display.team2Strikes),
      roundPoints: toSafeNumber(display.roundPoints),
      answers: normalizeAnswers(display.answers)
    },

    control: {
      currentQuestionIndex: toSafeNumber(control.currentQuestionIndex),
      totalQuestions: toSafeNumber(control.totalQuestions),
      phase: cleanText(control.phase || "idle") || "idle",
      currentTurnTeam: normalizeTeam(control.currentTurnTeam),
      confrontationWinner: normalizeTeam(control.confrontationWinner),
      stealingTeam: normalizeTeam(control.stealingTeam),
      firstBuzzName: cleanText(control.firstBuzzName),
      firstBuzzTeam: normalizeTeam(control.firstBuzzTeam)
    },

    buzz: {
      enabled: typeof buzz.enabled === "boolean" ? buzz.enabled : true,
      firstBuzz: normalizeFirstBuzz(buzz.firstBuzz)
    },

    effects: {
      displayErrorSeq: toSafeNumber(effects.displayErrorSeq),
      displayErrorReason: cleanText(effects.displayErrorReason)
    }
  };
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) return [];

  return answers
    .slice(0, 6)
    .map((answer) => ({
      text: cleanText(answer?.text),
      points: toSafeNumber(answer?.points),
      revealed: answer?.revealed === true
    }))
    .filter((answer) => answer.text);
}

function normalizeFirstBuzz(firstBuzz) {
  if (!firstBuzz || typeof firstBuzz !== "object") return null;

  const name = cleanText(firstBuzz.name);
  const team = normalizeTeam(firstBuzz.team);

  if (!name && !team) return null;

  return {
    name,
    team
  };
}

function normalizeRoom(value) {
  const room = String(value || "").trim().toLowerCase();
  if (!room) return "";

  return room.replace(/[^a-z0-9_-]/g, "").slice(0, 64);
}

function normalizeTeam(value) {
  const team = String(value || "").trim().toLowerCase();
  if (team === "team1" || team === "team2") return team;
  return "";
}

function clampStrike(value) {
  const n = toSafeNumber(value);
  return Math.max(0, Math.min(3, n));
}

function toSafeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function cleanText(value) {
  return String(value || "").trim();
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id, Cache-Control, Pragma"
  };
}
