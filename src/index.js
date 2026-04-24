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
          channel: buzzChannelNameForRoom(room),
          authEndpoint: `/api/buzz/pusher/auth?room=${encodeURIComponent(room)}`
        });
      }

      if (url.pathname === "/api/game/pusher-config" && request.method === "GET") {
        const room = normalizeRoom(url.searchParams.get("room"));
        if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

        return json({
          ok: true,
          key: env.PUSHER_KEY || "",
          cluster: env.PUSHER_CLUSTER || "",
          channel: gameChannelNameForRoom(room),
          authEndpoint: `/api/game/pusher/auth?room=${encodeURIComponent(room)}`
        });
      }

      if (url.pathname === "/api/buzz/pusher/auth" && request.method === "POST") {
        const room = normalizeRoom(url.searchParams.get("room"));
        if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

        const payload = await readPusherAuthPayload(request);
        if (!payload.socketId || !payload.channelName) {
          return json({ ok: false, error: "INVALID_PUSHER_AUTH_PAYLOAD" }, 400);
        }

        const expectedChannel = buzzChannelNameForRoom(room);
        if (payload.channelName !== expectedChannel) {
          return json({ ok: false, error: "CHANNEL_ROOM_MISMATCH" }, 400);
        }

        const auth = await buildPusherChannelAuth(
          env.PUSHER_KEY,
          env.PUSHER_SECRET,
          payload.socketId,
          payload.channelName
        );

        return json({ auth });
      }

      if (url.pathname === "/api/game/pusher/auth" && request.method === "POST") {
        const room = normalizeRoom(url.searchParams.get("room"));
        if (!room) return json({ ok: false, error: "ROOM_REQUIRED" }, 400);

        const payload = await readPusherAuthPayload(request);
        if (!payload.socketId || !payload.channelName) {
          return json({ ok: false, error: "INVALID_PUSHER_AUTH_PAYLOAD" }, 400);
        }

        const expectedChannel = gameChannelNameForRoom(room);
        if (payload.channelName !== expectedChannel) {
          return json({ ok: false, error: "CHANNEL_ROOM_MISMATCH" }, 400);
        }

        const auth = await buildPusherChannelAuth(
          env.PUSHER_KEY,
          env.PUSHER_SECRET,
          payload.socketId,
          payload.channelName
        );

        return json({ auth });
      }

      const isBuzzRoute = url.pathname.startsWith("/api/buzz/");
      const isGameRoute = url.pathname.startsWith("/api/game/");

      if (!isBuzzRoute && !isGameRoute) {
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
        this.cache = state;
        return json({ ok: true, state: publicBuzzState(state) });
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

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, state: publicBuzzState(state) });
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
          return json(
            {
              ok: false,
              error: "BUZZ_DISABLED",
              state: publicBuzzState(state)
            },
            409
          );
        }

        if (state.firstBuzz) {
          return json(
            {
              ok: false,
              error: "ALREADY_BUZZED",
              state: publicBuzzState(state)
            },
            409
          );
        }

        state.firstBuzz = {
          playerId,
          name,
          team,
          at: Date.now()
        };

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, accepted: true, state: publicBuzzState(state) });
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
        state.firstBuzz = null;

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, state: publicBuzzState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/buzz/reset") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const state = await this.loadState(room);
        this.cleanupPlayers(state);

        state.firstBuzz = null;

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, state: publicBuzzState(state) });
      }

      if (request.method === "GET" && url.pathname === "/api/game/state") {
        const state = await this.loadState(url.searchParams.get("room"));
        this.cleanupPlayers(state);
        this.cache = state;
        return json({ ok: true, state: publicGameState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/game/init") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const body = await safeJson(request);

        const state = await this.loadState(room);

        const questionIndex = normalizeQuestionIndex(body.questionIndex ?? 0);
        const snapshot = createQuestionSnapshot(questionIndex);

        state.game.currentQuestionIndex = questionIndex;
        state.game.totalQuestions = QUESTIONS.length;
        state.game.phase = "idle";
        state.game.showQuestion = false;
        state.game.currentTurnTeam = "";
        state.game.confrontationWinner = "";
        state.game.stealingTeam = "";
        state.game.needsDuelChoice = false;
        state.game.questionText = snapshot.questionText;
        state.game.answers = snapshot.answers;
        state.game.roundPoints = 0;
        state.game.roundClosedAfterSteal = false;
        state.game.team1Name = normalizeTeamLabel(body.team1Name || state.game.team1Name || "الفريق الأول");
        state.game.team2Name = normalizeTeamLabel(body.team2Name || state.game.team2Name || "الفريق الثاني");
        state.game.team1Score = 0;
        state.game.team2Score = 0;
        state.game.team1Strikes = 0;
        state.game.team2Strikes = 0;
        state.game.displayErrorSeq = 0;
        state.game.displayErrorReason = "";

        state.enabled = true;
        state.firstBuzz = null;

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, state: publicGameState(state) });
      }

      if (request.method === "POST" && url.pathname === "/api/game/action") {
        const room = normalizeRoom(url.searchParams.get("room"));
        const body = await safeJson(request);
        const action = String(body.action || "").trim().toLowerCase();

        if (!action) {
          return json({ ok: false, error: "ACTION_REQUIRED" }, 400);
        }

        const state = await this.loadState(room);
        const result = applyGameAction(state, action, body);

        if (!result.ok) {
          return json(result, 400);
        }

        touchState(state);
        await this.saveState(state, true);
        return json({ ok: true, action, state: publicGameState(state) });
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
    this.cache = migrateState(stored, room);
    return this.cache;
  }

  cleanupPlayers(state) {
    const now = Date.now();
    const maxIdleMs = 1000 * 60 * 60 * 12;

    for (const [playerId, player] of Object.entries(state.players || {})) {
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

    try {
      await Promise.all([
        triggerPusherEvent(
          this.env,
          buzzChannelNameForRoom(state.room),
          "buzz-updated",
          publicBuzzState(state)
        ),
        triggerPusherEvent(
          this.env,
          gameChannelNameForRoom(state.room),
          "game-updated",
          publicGameState(state)
        )
      ]);
    } catch (error) {
      console.error("PUSHER_TRIGGER_FAILED", error);
    }
  }
}

/* =========================
   Question bank
========================= */

const QUESTIONS = [
  {
    question: "اذكر شيئًا يستخدمه الناس يوميًا",
    answers: [
      { text: "الجوال", points: 32 },
      { text: "المفاتيح", points: 18 },
      { text: "الماء", points: 14 },
      { text: "السيارة", points: 10 },
      { text: "المحفظة", points: 8 },
      { text: "النظارة", points: 6 }
    ]
  },
  {
    question: "اذكر شيئًا تجده في شنطة أي امرأة؟",
    answers: [
      { text: "روج / مكياج", points: 40 },
      { text: "عطر", points: 25 },
      { text: "محفظة فلوس", points: 15 },
      { text: "مناديل", points: 10 },
      { text: "مفاتيح", points: 10 },
      { text: "جوال", points: 8 }
    ]
  },
  {
    question: "اذكر شيئًا يوجد في المطبخ",
    answers: [
      { text: "الثلاجة", points: 28 },
      { text: "الفرن", points: 20 },
      { text: "الصحون", points: 16 },
      { text: "الملاعق", points: 12 },
      { text: "الكاسات", points: 9 },
      { text: "القدر", points: 7 }
    ]
  },
  {
    question: "اذكر شيئًا يحمله الطالب معه",
    answers: [
      { text: "الحقيبة", points: 30 },
      { text: "القلم", points: 18 },
      { text: "الدفتر", points: 16 },
      { text: "الكتب", points: 14 },
      { text: "المقلمة", points: 8 },
      { text: "الآيباد", points: 6 }
    ]
  },
  {
    question: "اذكر شيئًا يستخدم في السفر",
    answers: [
      { text: "جواز السفر", points: 34 },
      { text: "الشنطة", points: 22 },
      { text: "التذكرة", points: 16 },
      { text: "الملابس", points: 12 },
      { text: "الفلوس", points: 9 },
      { text: "الجوال", points: 7 }
    ]
  }
];

/* =========================
   Game actions
========================= */

function applyGameAction(state, action, body) {
  switch (action) {
    case "show_question":
    case "set_question_visibility": {
      if (typeof body.visible !== "boolean") {
        return { ok: false, error: "VISIBLE_BOOLEAN_REQUIRED" };
      }
      state.game.showQuestion = body.visible;
      return { ok: true };
    }

    case "set_team_names": {
      if (body.team1Name !== undefined) {
        state.game.team1Name = normalizeTeamLabel(body.team1Name || state.game.team1Name);
      }
      if (body.team2Name !== undefined) {
        state.game.team2Name = normalizeTeamLabel(body.team2Name || state.game.team2Name);
      }
      return { ok: true };
    }

    case "set_buzz_visible": {
      if (typeof body.visible !== "boolean") {
        return { ok: false, error: "VISIBLE_BOOLEAN_REQUIRED" };
      }

      state.enabled = body.visible;
      state.firstBuzz = null;

      if (!body.visible) {
        state.game.phase = state.game.phase || "idle";
      }

      return { ok: true };
    }

    case "clear_first_buzz": {
      state.firstBuzz = null;
      return { ok: true };
    }

    case "next_question":
    case "next_question_bundle": {
      return applyNextQuestionBundle(state);
    }

    case "previous_question": {
      let prevIndex = normalizeQuestionIndex(state.game.currentQuestionIndex - 1);
      if (state.game.currentQuestionIndex === 0) prevIndex = QUESTIONS.length - 1;
      loadQuestionIntoRound(state, prevIndex, { preserveScores: true, preserveNames: true });
      return { ok: true };
    }

    case "set_question_index": {
      if (body.questionIndex === undefined || body.questionIndex === null) {
        return { ok: false, error: "QUESTION_INDEX_REQUIRED" };
      }

      const index = normalizeQuestionIndex(body.questionIndex);
      loadQuestionIntoRound(state, index, { preserveScores: true, preserveNames: true });
      return { ok: true };
    }

    case "reveal_answer": {
      const answerIndex = normalizeAnswerIndex(body.answerIndex);
      if (answerIndex === -1) {
        return { ok: false, error: "ANSWER_INDEX_INVALID" };
      }

      const answer = state.game.answers[answerIndex];
      if (!answer) {
        return { ok: false, error: "ANSWER_NOT_FOUND" };
      }

      if (state.game.roundClosedAfterSteal) {
        if (!answer.revealed) {
          answer.revealed = true;
        }
        return { ok: true };
      }

      if (!answer.revealed) {
        answer.revealed = true;
        updateRoundPoints(state);
      }

      if (state.game.phase === "steal_pick") {
        const stealTeam = normalizeTeam(state.game.stealingTeam);
        if (!stealTeam) {
          return { ok: false, error: "STEALING_TEAM_NOT_SET" };
        }

        awardRoundToTeam(state, stealTeam, { closeRoundAfterSteal: true });
        return { ok: true };
      }

      const currentTurnTeam = normalizeTeam(state.game.currentTurnTeam);
      const hasFirstBuzz = !!state.firstBuzz && !!normalizeTeam(state.firstBuzz.team);

      if (!currentTurnTeam) {
        if (state.game.needsDuelChoice) {
          state.game.phase = "duel_select";
          return { ok: true };
        }

        if (hasFirstBuzz && answerIndex === 0) {
          state.game.confrontationWinner = state.firstBuzz.team;
          state.game.phase = "play_or_pass";
          return { ok: true };
        }

        state.game.needsDuelChoice = true;
        state.game.phase = "duel_select";
        return { ok: true };
      }

      if (allAnswersRevealed(state.game)) {
        awardRoundToTeam(state, currentTurnTeam);
      }

      return { ok: true };
    }

    case "hide_answer": {
      const answerIndex = normalizeAnswerIndex(body.answerIndex);
      if (answerIndex === -1) {
        return { ok: false, error: "ANSWER_INDEX_INVALID" };
      }

      state.game.answers[answerIndex].revealed = false;
      updateRoundPoints(state);
      return { ok: true };
    }

    case "set_duel_winner": {
      const team = normalizeTeam(body.team);
      if (!team) {
        return { ok: false, error: "TEAM_REQUIRED" };
      }

      state.game.confrontationWinner = team;
      state.game.needsDuelChoice = false;
      state.game.phase = "play_or_pass";
      return { ok: true };
    }

    case "cancel_duel":
    case "cancel_context": {
      if (state.game.phase === "play_or_pass") {
        state.game.phase = "duel_select";
      } else if (state.game.phase === "duel_select") {
        state.game.phase = "idle";
        state.game.needsDuelChoice = true;
      } else {
        state.game.phase = "idle";
      }

      return { ok: true };
    }

    case "cancel_duel_open_buzz": {
      return applyCancelDuelOpenBuzz(state);
    }

    case "clear_duel": {
      state.game.phase = "idle";
      state.game.needsDuelChoice = false;
      state.game.confrontationWinner = "";
      return { ok: true };
    }

    case "choose_play_or_pass":
    case "choose_play_or_pass_bundle": {
      const decision = String(body.decision || "").trim().toLowerCase();
      return applyChoosePlayOrPassDecision(state, decision);
    }

    case "register_error": {
      let team = normalizeTeam(body.team);

      if (!team) {
        team = normalizeTeam(state.game.currentTurnTeam);
      }

      if (!team) {
        return { ok: false, error: "CURRENT_TURN_TEAM_REQUIRED" };
      }

      if (team === "team1") {
        state.game.team1Strikes = Math.min(3, state.game.team1Strikes + 1);

        if (state.game.team1Strikes >= 3) {
          state.game.stealingTeam = "team2";
          state.game.phase = "steal_result";
          state.enabled = false;
          state.firstBuzz = null;
        }
      } else {
        state.game.team2Strikes = Math.min(3, state.game.team2Strikes + 1);

        if (state.game.team2Strikes >= 3) {
          state.game.stealingTeam = "team1";
          state.game.phase = "steal_result";
          state.enabled = false;
          state.firstBuzz = null;
        }
      }

      return { ok: true };
    }

    case "steal_result": {
      const result = String(body.result || "").trim().toLowerCase();

      if (result !== "success" && result !== "fail") {
        return { ok: false, error: "STEAL_RESULT_INVALID" };
      }

      if (result === "fail") {
        const originalTeam = normalizeTeam(state.game.currentTurnTeam);

        if (!originalTeam) {
          return { ok: false, error: "CURRENT_TURN_TEAM_REQUIRED" };
        }

        bumpDisplayErrorEffect(state, "steal_fail");
        awardRoundToTeam(state, originalTeam, { closeRoundAfterSteal: true });
        return { ok: true };
      }

      const stealingTeam = normalizeTeam(state.game.stealingTeam);
      if (!stealingTeam) {
        return { ok: false, error: "STEALING_TEAM_NOT_SET" };
      }

      state.game.phase = "steal_pick";
      return { ok: true };
    }

    case "award_steal": {
      const stealTeam = normalizeTeam(state.game.stealingTeam);
      if (!stealTeam) {
        return { ok: false, error: "STEALING_TEAM_NOT_SET" };
      }

      const answerIndex = normalizeAnswerIndex(body.answerIndex);
      if (answerIndex === -1) {
        return { ok: false, error: "ANSWER_INDEX_INVALID" };
      }

      if (!state.game.answers[answerIndex].revealed) {
        state.game.answers[answerIndex].revealed = true;
        updateRoundPoints(state);
      }

      awardRoundToTeam(state, stealTeam, { closeRoundAfterSteal: true });
      return { ok: true };
    }

    case "award_round": {
      const team = normalizeTeam(body.team);
      if (!team) {
        return { ok: false, error: "TEAM_REQUIRED" };
      }

      awardRoundToTeam(state, team);
      return { ok: true };
    }

    case "reset_round": {
      resetRoundState(state, { preserveScores: true, preserveNames: true });
      return { ok: true };
    }

    case "reset_scores": {
      state.game.team1Score = 0;
      state.game.team2Score = 0;
      return { ok: true };
    }

    case "reset_all": {
      const team1Name = state.game.team1Name || "الفريق الأول";
      const team2Name = state.game.team2Name || "الفريق الثاني";

      loadQuestionIntoRound(state, 0, { preserveScores: false, preserveNames: false });

      state.game.team1Name = team1Name;
      state.game.team2Name = team2Name;
      state.game.team1Score = 0;
      state.game.team2Score = 0;
      state.game.displayErrorSeq = 0;
      state.game.displayErrorReason = "";
      state.game.roundClosedAfterSteal = false;
      state.enabled = true;
      state.firstBuzz = null;

      return { ok: true };
    }

    default:
      return { ok: false, error: "ACTION_NOT_SUPPORTED" };
  }
}

function applyNextQuestionBundle(state) {
  const nextIndex = normalizeQuestionIndex(state.game.currentQuestionIndex + 1);
  loadQuestionIntoRound(state, nextIndex, { preserveScores: true, preserveNames: true });
  state.game.showQuestion = false;
  state.game.displayErrorReason = "";
  state.game.roundClosedAfterSteal = false;
  state.enabled = true;
  state.firstBuzz = null;
  return { ok: true };
}

function applyChoosePlayOrPassDecision(state, decision) {
  const winner = normalizeTeam(state.game.confrontationWinner);

  if (!winner) {
    return { ok: false, error: "CONFRONTATION_WINNER_NOT_SET" };
  }

  if (decision !== "play" && decision !== "pass") {
    return { ok: false, error: "DECISION_INVALID" };
  }

  state.game.currentTurnTeam = decision === "play" ? winner : getOtherTeam(winner);
  state.game.phase = "main";
  state.game.needsDuelChoice = false;
  state.enabled = false;
  state.firstBuzz = null;

  return { ok: true };
}

function applyCancelDuelOpenBuzz(state) {
  state.game.phase = "idle";
  state.game.needsDuelChoice = true;
  state.game.confrontationWinner = "";
  state.game.currentTurnTeam = "";
  state.enabled = true;
  state.firstBuzz = null;
  return { ok: true };
}

function bumpDisplayErrorEffect(state, reason = "general") {
  state.game.displayErrorSeq = Math.max(0, normalizeNumber(state.game.displayErrorSeq, 0)) + 1;
  state.game.displayErrorReason = normalizeEffectReason(reason);
}

function awardRoundToTeam(state, team, options = {}) {
  const closeRoundAfterSteal = options.closeRoundAfterSteal === true;

  updateRoundPoints(state);
  const awardedPoints = Math.max(0, normalizeNumber(state.game.roundPoints, 0));

  if (team === "team1") {
    state.game.team1Score += awardedPoints;
  } else if (team === "team2") {
    state.game.team2Score += awardedPoints;
  }

  state.game.phase = "idle";
  state.game.currentTurnTeam = "";
  state.game.confrontationWinner = "";
  state.game.stealingTeam = "";
  state.game.needsDuelChoice = false;
  state.game.team1Strikes = 0;
  state.game.team2Strikes = 0;
  state.game.roundClosedAfterSteal = closeRoundAfterSteal;

  if (closeRoundAfterSteal) {
    state.game.roundPoints = 0;
  }

  state.enabled = false;
  state.firstBuzz = null;
}

function resetRoundState(state, options = {}) {
  const preserveScores = !!options.preserveScores;
  const preserveNames = !!options.preserveNames;

  const currentIndex = normalizeQuestionIndex(state.game.currentQuestionIndex);
  const snapshot = createQuestionSnapshot(currentIndex);

  const team1Name = preserveNames ? state.game.team1Name : "الفريق الأول";
  const team2Name = preserveNames ? state.game.team2Name : "الفريق الثاني";
  const team1Score = preserveScores ? state.game.team1Score : 0;
  const team2Score = preserveScores ? state.game.team2Score : 0;

  state.game.currentQuestionIndex = currentIndex;
  state.game.totalQuestions = QUESTIONS.length;
  state.game.phase = "idle";
  state.game.showQuestion = false;
  state.game.team1Name = team1Name;
  state.game.team2Name = team2Name;
  state.game.team1Score = team1Score;
  state.game.team2Score = team2Score;
  state.game.team1Strikes = 0;
  state.game.team2Strikes = 0;
  state.game.currentTurnTeam = "";
  state.game.confrontationWinner = "";
  state.game.stealingTeam = "";
  state.game.needsDuelChoice = false;
  state.game.questionText = snapshot.questionText;
  state.game.answers = snapshot.answers;
  state.game.roundPoints = 0;
  state.game.roundClosedAfterSteal = false;
  state.game.displayErrorReason = "";

  state.enabled = true;
  state.firstBuzz = null;
}

function loadQuestionIntoRound(state, questionIndex, options = {}) {
  const preserveScores = !!options.preserveScores;
  const preserveNames = !!options.preserveNames;

  const team1Name = preserveNames ? state.game.team1Name : "الفريق الأول";
  const team2Name = preserveNames ? state.game.team2Name : "الفريق الثاني";
  const team1Score = preserveScores ? state.game.team1Score : 0;
  const team2Score = preserveScores ? state.game.team2Score : 0;

  state.game.currentQuestionIndex = normalizeQuestionIndex(questionIndex);
  state.game.totalQuestions = QUESTIONS.length;
  state.game.phase = "idle";
  state.game.showQuestion = false;
  state.game.team1Name = team1Name;
  state.game.team2Name = team2Name;
  state.game.team1Score = team1Score;
  state.game.team2Score = team2Score;
  state.game.team1Strikes = 0;
  state.game.team2Strikes = 0;
  state.game.currentTurnTeam = "";
  state.game.confrontationWinner = "";
  state.game.stealingTeam = "";
  state.game.needsDuelChoice = false;

  const snapshot = createQuestionSnapshot(state.game.currentQuestionIndex);
  state.game.questionText = snapshot.questionText;
  state.game.answers = snapshot.answers;
  state.game.roundPoints = 0;
  state.game.roundClosedAfterSteal = false;
  state.game.displayErrorReason = "";

  state.enabled = true;
  state.firstBuzz = null;
}

/* =========================
   State creation / migration
========================= */

function createQuestionSnapshot(index) {
  const safeIndex = normalizeQuestionIndex(index);
  const question = QUESTIONS[safeIndex] || QUESTIONS[0];

  return {
    questionText: String(question.question || "").trim(),
    answers: Array.from({ length: 6 }, (_, i) => {
      const answer = question.answers[i] || { text: "", points: 0 };
      return {
        text: String(answer.text || "").trim(),
        points: Math.max(0, normalizeNumber(answer.points, 0)),
        revealed: false
      };
    })
  };
}

function createDefaultGameState() {
  const snapshot = createQuestionSnapshot(0);

  return {
    currentQuestionIndex: 0,
    totalQuestions: QUESTIONS.length,
    phase: "idle",
    showQuestion: false,
    team1Name: "الفريق الأول",
    team2Name: "الفريق الثاني",
    team1Score: 0,
    team2Score: 0,
    team1Strikes: 0,
    team2Strikes: 0,
    currentTurnTeam: "",
    confrontationWinner: "",
    stealingTeam: "",
    needsDuelChoice: false,
    questionText: snapshot.questionText,
    answers: snapshot.answers,
    roundPoints: 0,
    roundClosedAfterSteal: false,
    displayErrorSeq: 0,
    displayErrorReason: ""
  };
}

function createDefaultState(room) {
  return {
    room: normalizeRoom(room) || "default",
    enabled: true,
    firstBuzz: null,
    players: {},
    game: createDefaultGameState(),
    updatedAt: Date.now(),
    version: 1
  };
}

function migrateState(stored, room) {
  const base = createDefaultState(room);

  if (!stored || typeof stored !== "object") {
    return base;
  }

  const currentQuestionIndex = normalizeQuestionIndex(
    stored?.game?.currentQuestionIndex ?? base.game.currentQuestionIndex
  );
  const snapshot = createQuestionSnapshot(currentQuestionIndex);

  const game = {
    ...base.game,
    currentQuestionIndex,
    totalQuestions: QUESTIONS.length,
    phase: normalizeGamePhase(stored?.game?.phase),
    showQuestion: typeof stored?.game?.showQuestion === "boolean" ? stored.game.showQuestion : base.game.showQuestion,
    team1Name: normalizeTeamLabel(stored?.game?.team1Name || base.game.team1Name),
    team2Name: normalizeTeamLabel(stored?.game?.team2Name || base.game.team2Name),
    team1Score: Math.max(0, normalizeNumber(stored?.game?.team1Score, base.game.team1Score)),
    team2Score: Math.max(0, normalizeNumber(stored?.game?.team2Score, base.game.team2Score)),
    team1Strikes: normalizeStrikeCount(stored?.game?.team1Strikes),
    team2Strikes: normalizeStrikeCount(stored?.game?.team2Strikes),
    currentTurnTeam: normalizeTeam(stored?.game?.currentTurnTeam) || "",
    confrontationWinner: normalizeTeam(stored?.game?.confrontationWinner) || "",
    stealingTeam: normalizeTeam(stored?.game?.stealingTeam) || "",
    needsDuelChoice: !!stored?.game?.needsDuelChoice,
    questionText: normalizeQuestionText(stored?.game?.questionText || snapshot.questionText),
    answers: mergeAnswers(stored?.game?.answers, snapshot.answers),
    roundPoints: Math.max(0, normalizeNumber(stored?.game?.roundPoints, 0)),
    roundClosedAfterSteal: !!stored?.game?.roundClosedAfterSteal,
    displayErrorSeq: Math.max(0, normalizeNumber(stored?.game?.displayErrorSeq, 0)),
    displayErrorReason: normalizeEffectReason(stored?.game?.displayErrorReason)
  };

  const merged = {
    ...base,
    room: normalizeRoom(stored.room) || normalizeRoom(room) || base.room,
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : base.enabled,
    firstBuzz: normalizeFirstBuzz(stored.firstBuzz),
    players: normalizePlayers(stored.players),
    game,
    updatedAt: Math.max(0, normalizeNumber(stored.updatedAt, base.updatedAt)),
    version: Math.max(1, normalizeNumber(stored.version, base.version))
  };

  updateRoundPoints(merged);
  return merged;
}

function mergeAnswers(incoming, fallback) {
  const answers = Array.isArray(incoming) ? incoming : [];

  return Array.from({ length: 6 }, (_, i) => {
    const answer = answers[i];
    const fallbackAnswer = fallback[i] || { text: "", points: 0, revealed: false };

    return {
      text: normalizeAnswerText(answer?.text || fallbackAnswer.text),
      points: Math.max(0, normalizeNumber(answer?.points, fallbackAnswer.points)),
      revealed: !!answer?.revealed
    };
  });
}

function touchState(state) {
  updateRoundPoints(state);
  state.updatedAt = Date.now();
  state.version = Math.max(1, normalizeNumber(state.version, 0) + 1);
}

/* =========================
   Public state
========================= */

function publicBuzzState(state) {
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

function publicGameState(state) {
  return {
    room: state.room,
    updatedAt: state.updatedAt,
    version: state.version,

    buzz: {
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
      }))
    },

    control: {
      currentQuestionIndex: state.game.currentQuestionIndex,
      totalQuestions: state.game.totalQuestions,
      phase: state.game.phase,
      currentTurnTeam: state.game.currentTurnTeam,
      confrontationWinner: state.game.confrontationWinner,
      stealingTeam: state.game.stealingTeam,
      needsDuelChoice: !!state.game.needsDuelChoice
    },

    display: {
      showQuestion: !!state.game.showQuestion,
      question: state.game.questionText,
      team1Name: state.game.team1Name,
      team2Name: state.game.team2Name,
      team1Score: state.game.team1Score,
      team2Score: state.game.team2Score,
      team1Strikes: state.game.team1Strikes,
      team2Strikes: state.game.team2Strikes,
      roundPoints: state.game.roundPoints,
      roundClosedAfterSteal: !!state.game.roundClosedAfterSteal,
      answers: state.game.answers.map((a) => ({
        text: a.text,
        points: a.points,
        revealed: !!a.revealed
      }))
    },

    effects: {
      displayErrorSeq: Math.max(0, normalizeNumber(state.game.displayErrorSeq, 0)),
      displayErrorReason: normalizeEffectReason(state.game.displayErrorReason)
    }
  };
}

/* =========================
   Helpers
========================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Cache-Control, Pragma"
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

async function readPusherAuthPayload(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return {
      socketId: String(body.socket_id || ""),
      channelName: String(body.channel_name || "")
    };
  }

  const form = await request.formData().catch(() => null);

  return {
    socketId: String(form?.get("socket_id") || ""),
    channelName: String(form?.get("channel_name") || "")
  };
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

function normalizeTeamLabel(value) {
  const v = String(value || "").trim();
  return v.slice(0, 60) || "الفريق";
}

function normalizeQuestionText(value) {
  const v = String(value || "").trim();
  return v.slice(0, 180);
}

function normalizeAnswerText(value) {
  const v = String(value || "").trim();
  return v.slice(0, 80);
}

function normalizeEffectReason(value) {
  return String(value || "").trim().toLowerCase().slice(0, 40);
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStrikeCount(value) {
  return Math.max(0, Math.min(3, normalizeNumber(value, 0)));
}

function normalizeAnswerIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return -1;
  if (n < 0 || n > 5) return -1;
  return n;
}

function normalizeQuestionIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  if (QUESTIONS.length <= 0) return 0;
  if (n < 0) return 0;
  if (n >= QUESTIONS.length) return n % QUESTIONS.length;
  return n;
}

function normalizeGamePhase(value) {
  const allowed = new Set([
    "idle",
    "duel_select",
    "play_or_pass",
    "main",
    "steal_result",
    "steal_pick"
  ]);

  const v = String(value || "").trim().toLowerCase();
  return allowed.has(v) ? v : "idle";
}

function normalizeFirstBuzz(firstBuzz) {
  if (!firstBuzz || typeof firstBuzz !== "object") return null;

  const playerId = normalizeId(firstBuzz.playerId);
  const name = normalizePlayerName(firstBuzz.name);
  const team = normalizeTeam(firstBuzz.team);
  const at = Math.max(0, normalizeNumber(firstBuzz.at, 0));

  if (!playerId || !name || !team) return null;

  return { playerId, name, team, at };
}

function normalizePlayers(players) {
  const source = players && typeof players === "object" ? players : {};
  const result = {};

  for (const [key, value] of Object.entries(source)) {
    const playerId = normalizeId(key || value?.id);
    const name = normalizePlayerName(value?.name);
    const team = normalizeTeam(value?.team);
    const lastSeenAt = Math.max(0, normalizeNumber(value?.lastSeenAt, 0));

    if (!playerId || !name || !team) continue;

    result[playerId] = {
      id: playerId,
      name,
      team,
      lastSeenAt
    };
  }

  return result;
}

function updateRoundPoints(state) {
  if (state?.game?.roundClosedAfterSteal) {
    state.game.roundPoints = 0;
    return;
  }

  state.game.roundPoints = state.game.answers.reduce((sum, answer) => {
    return sum + (answer.revealed ? Math.max(0, normalizeNumber(answer.points, 0)) : 0);
  }, 0);
}

function allAnswersRevealed(game) {
  return game.answers.every((answer) => !!answer.revealed);
}

function getOtherTeam(team) {
  return team === "team1" ? "team2" : "team1";
}

function buzzChannelNameForRoom(room) {
  return `private-buzz-${room}`;
}

function gameChannelNameForRoom(room) {
  return `private-game-${room}`;
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
   MD5
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
