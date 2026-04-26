import { FAMILY_FEUD_QUESTIONS } from "../../_shared/family-feud-questions.js";

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
    const room = normalizeRoom(url.searchParams.get("room"));

    if (!room) {
      return jsonResponse({
        ok: false,
        error: "رقم الغرفة غير موجود."
      }, 400);
    }

    let row = await db
      .prepare(`
        SELECT state_json
        FROM game_rooms
        WHERE room_id = ?1
        LIMIT 1
      `)
      .bind(room)
      .first();

    if (!row?.state_json) {
      const initialState = buildInitialState(room);

      await db
        .prepare(`
          INSERT OR REPLACE INTO game_rooms
            (room_id, state_json, created_at, updated_at)
          VALUES
            (?1, ?2, ?3, ?4)
        `)
        .bind(
          room,
          JSON.stringify(initialState),
          Date.now(),
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
      room_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_game_rooms_updated_at
      ON game_rooms(updated_at);
  `);
}

function buildInitialState(room) {
  const questionIndex = 0;
  const question = getQuestionByIndex(questionIndex);

  return {
    room,
    display: {
      showQuestion: false,
      question: question.question,
      team1Name: "الفريق الأول",
      team2Name: "الفريق الثاني",
      team1Score: 0,
      team2Score: 0,
      team1Strikes: 0,
      team2Strikes: 0,
      roundPoints: 0,
      answers: normalizeAnswers(question.answers)
    },
    control: {
      currentQuestionIndex: questionIndex,
      totalQuestions: FAMILY_FEUD_QUESTIONS.length,
      phase: "idle",
      currentTurnTeam: "",
      confrontationWinner: "",
      stealingTeam: ""
    },
    buzz: {
      enabled: true,
      firstBuzz: {
        name: "",
        team: "",
        at: 0
      }
    },
    effects: {
      displayErrorSeq: 0,
      displayErrorReason: ""
    },
    meta: {
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  };
}

function normalizeState(raw, room) {
  const fallback = buildInitialState(room);
  const source = raw && typeof raw === "object" ? raw : fallback;

  const control = source.control || {};
  const questionIndex = clampQuestionIndex(control.currentQuestionIndex);
  const question = getQuestionByIndex(questionIndex);

  const display = source.display || {};
  const buzz = source.buzz || {};
  const effects = source.effects || {};
  const firstBuzz = buzz.firstBuzz || {};

  return {
    room,
    display: {
      showQuestion: typeof display.showQuestion === "boolean" ? display.showQuestion : false,
      question: String(display.question || question.question || "").trim(),
      team1Name: String(display.team1Name || "الفريق الأول").trim(),
      team2Name: String(display.team2Name || "الفريق الثاني").trim(),
      team1Score: toSafeNumber(display.team1Score),
      team2Score: toSafeNumber(display.team2Score),
      team1Strikes: clampStrike(display.team1Strikes),
      team2Strikes: clampStrike(display.team2Strikes),
      roundPoints: toSafeNumber(display.roundPoints),
      answers: normalizeAnswers(
        Array.isArray(display.answers) && display.answers.length
          ? display.answers
          : question.answers
      )
    },
    control: {
      currentQuestionIndex: questionIndex,
      totalQuestions: FAMILY_FEUD_QUESTIONS.length,
      phase: String(control.phase || control.stage || "idle").trim(),
      currentTurnTeam: normalizeTeam(control.currentTurnTeam),
      confrontationWinner: normalizeTeam(control.confrontationWinner),
      stealingTeam: normalizeTeam(control.stealingTeam)
    },
    buzz: {
      enabled: typeof buzz.enabled === "boolean" ? buzz.enabled : true,
      firstBuzz: {
        name: String(firstBuzz.name || "").trim(),
        team: normalizeTeam(firstBuzz.team),
        at: toSafeNumber(firstBuzz.at)
      }
    },
    effects: {
      displayErrorSeq: toSafeNumber(effects.displayErrorSeq),
      displayErrorReason: String(effects.displayErrorReason || "").trim()
    },
    meta: {
      createdAt: toSafeNumber(source.meta?.createdAt),
      updatedAt: toSafeNumber(source.meta?.updatedAt) || Date.now()
    }
  };
}

function getQuestionByIndex(index) {
  if (!Array.isArray(FAMILY_FEUD_QUESTIONS) || FAMILY_FEUD_QUESTIONS.length === 0) {
    return {
      question: "نص السؤال",
      answers: []
    };
  }

  const safeIndex = clampQuestionIndex(index);
  return FAMILY_FEUD_QUESTIONS[safeIndex] || FAMILY_FEUD_QUESTIONS[0];
}

function clampQuestionIndex(value) {
  const total = Array.isArray(FAMILY_FEUD_QUESTIONS) ? FAMILY_FEUD_QUESTIONS.length : 0;
  const n = toSafeNumber(value);

  if (total <= 0) return 0;
  if (n < 0) return 0;
  if (n >= total) return 0;

  return n;
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) return [];

  return answers
    .filter((answer) => {
      const text = String(answer?.text || "").trim();
      return text.length > 0;
    })
    .slice(0, 6)
    .map((answer) => ({
      text: String(answer.text || "").trim(),
      points: toSafeNumber(answer.points),
      revealed: answer.revealed === true
    }));
}

function normalizeRoom(value) {
  const room = String(value || "").trim().toLowerCase();
  if (!room) return "";

  return room
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
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
