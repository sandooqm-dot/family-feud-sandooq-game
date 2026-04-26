import { FAMILY_FEUD_QUESTIONS } from "../../_shared/family-feud-questions.js";

const DEFAULT_ROOM = "family-feud-demo";

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const room = normalizeRoom(url.searchParams.get("room")) || DEFAULT_ROOM;

    const body = await readJson(request);
    const action = String(body.action || "").trim();

    const db = getDb(env);
    if (!db) {
      return jsonResponse({ ok: false, message: "لم يتم العثور على قاعدة البيانات D1." }, 500);
    }

    await ensureSchema(db);

    let state = await getRoomState(db, room);

    if (!state) {
      state = createInitialState(room);
      await saveRoomState(db, room, state);
    }

    switch (action) {
      case "set_team_names": {
        const team1Name = cleanText(body.team1Name);
        const team2Name = cleanText(body.team2Name);

        if (team1Name) state.display.team1Name = team1Name;
        if (team2Name) state.display.team2Name = team2Name;

        break;
      }

      case "init": {
        const team1Name = cleanText(body.team1Name) || "الفريق الأول";
        const team2Name = cleanText(body.team2Name) || "الفريق الثاني";
        const questionIndex = normalizeQuestionIndex(body.questionIndex, 0);

        state = createInitialState(room, {
          team1Name,
          team2Name,
          questionIndex
        });

        break;
      }

      case "show_question": {
        state.display.showQuestion = !!body.visible;
        break;
      }

      case "set_buzz_visible": {
        state.buzz.enabled = !!body.visible;

        if (state.buzz.enabled) {
          state.buzz.firstBuzz = null;
          state.control.firstBuzzName = "";
          state.control.firstBuzzTeam = "";
        }

        break;
      }

      case "next_question_bundle": {
        const team1Name = state.display.team1Name || "الفريق الأول";
        const team2Name = state.display.team2Name || "الفريق الثاني";
        const team1Score = Number(state.display.team1Score || 0);
        const team2Score = Number(state.display.team2Score || 0);

        const incomingQuestion = normalizeIncomingQuestion(body.question);
        const incomingTotal = normalizeTotalQuestions(body.totalQuestions);

        if (incomingQuestion) {
          const safeTotal = incomingTotal || FAMILY_FEUD_QUESTIONS.length || 1;
          const nextIndex = normalizeQuestionIndexByTotal(
            body.questionIndex,
            safeTotal,
            getNextQuestionIndex(state.control.currentQuestionIndex)
          );

          state = createInitialState(room, {
            team1Name,
            team2Name,
            team1Score,
            team2Score,
            questionIndex: nextIndex,
            totalQuestions: safeTotal,
            questionOverride: incomingQuestion
          });

          break;
        }

        const nextIndex = getNextQuestionIndex(state.control.currentQuestionIndex);

        state = createInitialState(room, {
          team1Name,
          team2Name,
          team1Score,
          team2Score,
          questionIndex: nextIndex
        });

        break;
      }

      case "reveal_answer": {
        const answerIndex = normalizeAnswerIndex(body.answerIndex);

        if (answerIndex === -1 || !state.display.answers[answerIndex]) {
          return jsonResponse({ ok: false, message: "الإجابة غير موجودة." }, 400);
        }

        const answer = state.display.answers[answerIndex];

        if (!answer.revealed) {
          answer.revealed = true;
          state.display.roundPoints = calculateRoundPoints(state.display.answers);
        }

        break;
      }

      case "register_error": {
        const team = normalizeTeam(body.team || state.control.currentTurnTeam);

        if (!team) {
          state.effects.displayErrorSeq = Number(state.effects.displayErrorSeq || 0) + 1;
          state.effects.displayErrorReason = "no_team";
          break;
        }

        if (team === "team1") {
          state.display.team1Strikes = Math.min(3, Number(state.display.team1Strikes || 0) + 1);

          if (state.display.team1Strikes >= 3) {
            state.control.phase = "steal_result";
            state.control.stealingTeam = "team2";
            state.control.currentTurnTeam = "";
          }
        }

        if (team === "team2") {
          state.display.team2Strikes = Math.min(3, Number(state.display.team2Strikes || 0) + 1);

          if (state.display.team2Strikes >= 3) {
            state.control.phase = "steal_result";
            state.control.stealingTeam = "team1";
            state.control.currentTurnTeam = "";
          }
        }

        state.effects.displayErrorSeq = Number(state.effects.displayErrorSeq || 0) + 1;
        state.effects.displayErrorReason = "wrong";

        break;
      }

      case "set_duel_winner": {
        const team = normalizeTeam(body.team);

        if (!team) {
          return jsonResponse({ ok: false, message: "الفريق غير صحيح." }, 400);
        }

        state.control.phase = "play_or_pass";
        state.control.confrontationWinner = team;
        state.control.currentTurnTeam = team;
        state.buzz.enabled = false;

        break;
      }

      case "choose_play_or_pass_bundle": {
        const decision = String(body.decision || "").trim();
        const winnerTeam = normalizeTeam(state.control.confrontationWinner);
        const otherTeam = getOtherTeam(winnerTeam);

        if (!winnerTeam) {
          return jsonResponse({ ok: false, message: "لا يوجد فريق فائز محدد." }, 400);
        }

        state.control.phase = "main";
        state.control.currentTurnTeam = decision === "pass" ? otherTeam : winnerTeam;
        state.control.stealingTeam = "";
        state.buzz.enabled = false;
        state.buzz.firstBuzz = null;

        break;
      }

      case "cancel_context": {
        state.control.phase = "idle";
        state.control.currentTurnTeam = "";
        state.control.confrontationWinner = "";
        state.control.stealingTeam = "";
        break;
      }

      case "cancel_duel_open_buzz": {
        state.control.phase = "idle";
        state.control.currentTurnTeam = "";
        state.control.confrontationWinner = "";
        state.control.stealingTeam = "";
        state.control.firstBuzzName = "";
        state.control.firstBuzzTeam = "";
        state.buzz.enabled = true;
        state.buzz.firstBuzz = null;
        break;
      }

      case "steal_result": {
        const result = String(body.result || "").trim();

        if (result === "success") {
          state.control.phase = "steal_pick";
          break;
        }

        if (result === "fail") {
          const stealingTeam = normalizeTeam(state.control.stealingTeam);
          const originalTeam = getOtherTeam(stealingTeam);
          const points = Number(state.display.roundPoints || 0);

          if (originalTeam === "team1") {
            state.display.team1Score = Number(state.display.team1Score || 0) + points;
          }

          if (originalTeam === "team2") {
            state.display.team2Score = Number(state.display.team2Score || 0) + points;
          }

          state.display.roundPoints = 0;
          state.control.phase = "idle";
          state.control.currentTurnTeam = "";
          state.control.confrontationWinner = "";
          state.control.stealingTeam = "";
          break;
        }

        return jsonResponse({ ok: false, message: "نتيجة السرقة غير صحيحة." }, 400);
      }

      case "award_steal": {
        const answerIndex = normalizeAnswerIndex(body.answerIndex);

        if (answerIndex === -1 || !state.display.answers[answerIndex]) {
          return jsonResponse({ ok: false, message: "الإجابة غير موجودة." }, 400);
        }

        const stealingTeam = normalizeTeam(state.control.stealingTeam);

        if (!stealingTeam) {
          return jsonResponse({ ok: false, message: "لا يوجد فريق سرقة محدد." }, 400);
        }

        const answer = state.display.answers[answerIndex];
        const answerPoints = answer.revealed ? 0 : Number(answer.points || 0);

        answer.revealed = true;

        const totalPoints = Number(state.display.roundPoints || 0) + answerPoints;

        if (stealingTeam === "team1") {
          state.display.team1Score = Number(state.display.team1Score || 0) + totalPoints;
        }

        if (stealingTeam === "team2") {
          state.display.team2Score = Number(state.display.team2Score || 0) + totalPoints;
        }

        state.display.roundPoints = 0;
        state.control.phase = "idle";
        state.control.currentTurnTeam = "";
        state.control.confrontationWinner = "";
        state.control.stealingTeam = "";

        break;
      }

      default:
        return jsonResponse({ ok: false, message: "الأمر غير معروف." }, 400);
    }

    state.updatedAt = Date.now();

    await saveRoomState(db, room, state);
    await triggerPusher(env, room, "game-updated", state);

    return jsonResponse({
      ok: true,
      state
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: error?.message || "حدث خطأ غير متوقع."
    }, 500);
  }
}

function createInitialState(room, options = {}) {
  const questionIndex = options.questionOverride
    ? normalizeQuestionIndexByTotal(
        options.questionIndex,
        Number(options.totalQuestions || FAMILY_FEUD_QUESTIONS.length || 1),
        0
      )
    : normalizeQuestionIndex(options.questionIndex, 0);

  const question = options.questionOverride || FAMILY_FEUD_QUESTIONS[questionIndex] || FAMILY_FEUD_QUESTIONS[0] || {
    question: "نص السؤال",
    answers: []
  };

  const totalQuestions = Number(options.totalQuestions || FAMILY_FEUD_QUESTIONS.length || 0);

  return {
    room,
    updatedAt: Date.now(),

    display: {
      showQuestion: false,
      question: cleanText(question.question) || "نص السؤال",
      team1Name: options.team1Name || "الفريق الأول",
      team2Name: options.team2Name || "الفريق الثاني",
      team1Score: Number(options.team1Score || 0),
      team2Score: Number(options.team2Score || 0),
      team1Strikes: 0,
      team2Strikes: 0,
      roundPoints: 0,
      answers: normalizeQuestionAnswers(question.answers)
    },

    control: {
      currentQuestionIndex: questionIndex,
      totalQuestions,
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

function normalizeIncomingQuestion(value) {
  if (!value || typeof value !== "object") return null;

  const question = cleanText(value.question);
  const answers = normalizeQuestionAnswers(value.answers);

  if (!question || !answers.length) return null;

  return {
    question,
    answers
  };
}

function normalizeQuestionAnswers(answers) {
  if (!Array.isArray(answers)) return [];

  return answers
    .filter((answer) => cleanText(answer?.text))
    .slice(0, 6)
    .map((answer) => ({
      text: cleanText(answer.text),
      points: Math.max(0, Number(answer.points || 0)),
      revealed: false
    }))
    .filter((answer) => answer.text && answer.points > 0);
}

async function getRoomState(db, room) {
  const row = await db
    .prepare("SELECT state_json FROM game_rooms WHERE room = ?1 LIMIT 1")
    .bind(room)
    .first();

  if (!row?.state_json) return null;

  try {
    return JSON.parse(row.state_json);
  } catch (_) {
    return null;
  }
}

async function saveRoomState(db, room, state) {
  const now = Date.now();

  await db
    .prepare(`
      INSERT INTO game_rooms (room, state_json, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(room) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `)
    .bind(room, JSON.stringify(state), now)
    .run();
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS game_rooms (
      room TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function calculateRoundPoints(answers) {
  if (!Array.isArray(answers)) return 0;

  return answers.reduce((sum, answer) => {
    if (!answer?.revealed) return sum;
    return sum + Number(answer.points || 0);
  }, 0);
}

function normalizeTotalQuestions(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const safe = Math.floor(n);
  return safe > 0 ? safe : 0;
}

function normalizeQuestionIndex(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;

  const total = FAMILY_FEUD_QUESTIONS.length || 1;
  const safe = Math.floor(n);

  if (safe < 0) return 0;
  if (safe >= total) return 0;

  return safe;
}

function normalizeQuestionIndexByTotal(value, total, fallback = 0) {
  const n = Number(value);
  const safeTotal = Number(total || 0);

  if (!Number.isFinite(n) || !Number.isFinite(safeTotal) || safeTotal <= 0) {
    return fallback;
  }

  const safe = Math.floor(n);
  return ((safe % safeTotal) + safeTotal) % safeTotal;
}

function getNextQuestionIndex(currentIndex) {
  const total = FAMILY_FEUD_QUESTIONS.length || 1;
  const current = normalizeQuestionIndex(currentIndex, 0);
  return (current + 1) % total;
}

function normalizeAnswerIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;

  const index = Math.floor(n);
  if (index < 0 || index > 5) return -1;

  return index;
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

function getOtherTeam(team) {
  if (team === "team1") return "team2";
  if (team === "team2") return "team1";
  return "";
}

function cleanText(value) {
  return String(value || "").trim();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

function getDb(env) {
  return (
    env.DB ||
    env.AUTH_DB ||
    env.FAMILYFEUD_DB ||
    env.FAMILY_FEUD_DB ||
    null
  );
}

async function triggerPusher(env, room, eventName, payload) {
  try {
    const key = env.PUSHER_KEY;
    const secret = env.PUSHER_SECRET;
    const appId = env.PUSHER_APP_ID;
    const cluster = env.PUSHER_CLUSTER || "ap2";

    if (!key || !secret || !appId || !cluster) return false;

    const channel = `private-family-feud-${room}`;
    const body = JSON.stringify({
      name: eventName,
      channel,
      data: JSON.stringify(payload)
    });

    const path = `/apps/${appId}/events`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyMd5 = await md5Hex(body);

    const params = new URLSearchParams({
      auth_key: key,
      auth_timestamp: timestamp,
      auth_version: "1.0",
      body_md5: bodyMd5
    });

    const stringToSign = [
      "POST",
      path,
      params.toString()
    ].join("\n");

    const signature = await hmacSha256Hex(secret, stringToSign);
    params.set("auth_signature", signature);

    const response = await fetch(`https://api-${cluster}.pusher.com${path}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    });

    return response.ok;
  } catch (_) {
    return false;
  }
}

async function md5Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return bufferToHex(hash);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return bufferToHex(signature);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id",
    "Cache-Control": "no-store"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}
