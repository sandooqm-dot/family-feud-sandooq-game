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
        const result = initializeGameState(state, body);

        if (!result.ok) {
          return json(result, 400);
        }

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
    "question": "إضافة شعبية تنحط مع الشاي الأحمر لتعطيه نكهة؟",
    "answers": [
      {
        "text": "نعناع",
        "points": 40
      },
      {
        "text": "حبق",
        "points": 30
      },
      {
        "text": "سكر زيادة",
        "points": 15
      },
      {
        "text": "ليمون",
        "points": 10
      },
      {
        "text": "قرنفل / مسمار",
        "points": 5
      }
    ]
  },
  {
    "question": "أكلة تعتبر الخيار الأول للضيافة في العزايم الكبيرة؟",
    "answers": [
      {
        "text": "مفطح / كبسة لحم",
        "points": 31
      },
      {
        "text": "مندي",
        "points": 22
      },
      {
        "text": "مظبي",
        "points": 17
      },
      {
        "text": "مثلوثة",
        "points": 13
      },
      {
        "text": "حاشي",
        "points": 10
      },
      {
        "text": "سليق",
        "points": 7
      }
    ]
  },
  {
    "question": "أكمل الفراغ في هذه الجملة الشهيرة: يا زين...",
    "answers": [
      {
        "text": "الجو",
        "points": 31
      },
      {
        "text": "النوم",
        "points": 22
      },
      {
        "text": "العافية",
        "points": 17
      },
      {
        "text": "البرد / الشتاء",
        "points": 13
      },
      {
        "text": "أيام زمان",
        "points": 10
      },
      {
        "text": "الصمت / السكوت",
        "points": 7
      }
    ]
  },
  {
    "question": "لعبة تلعبها العائلة في الجمعات والاستراحات؟",
    "answers": [
      {
        "text": "بلوت",
        "points": 40
      },
      {
        "text": "أونو",
        "points": 25
      },
      {
        "text": "جاكارو",
        "points": 15
      },
      {
        "text": "كيرم",
        "points": 10
      },
      {
        "text": "لودو ستار",
        "points": 10
      }
    ]
  },
  {
    "question": "عذر مشهور تقوله عشان تعتذر عن عزيمة أو طلعة؟",
    "answers": [
      {
        "text": "مريض / تعبان",
        "points": 35
      },
      {
        "text": "عندي شغل / دوام",
        "points": 30
      },
      {
        "text": "الأهل محتاجيني",
        "points": 15
      },
      {
        "text": "سيارتي خربانة",
        "points": 10
      },
      {
        "text": "نمت وراحت علي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء دائماً يضيع أو تلخبط فيه في العزائم والمناسبات العائلية الكبيرة؟",
    "answers": [
      {
        "text": "النعال / الجزم",
        "points": 31
      },
      {
        "text": "الجوال",
        "points": 22
      },
      {
        "text": "الشواحن",
        "points": 17
      },
      {
        "text": "الأطفال",
        "points": 13
      },
      {
        "text": "الملاعق / الفناجيل",
        "points": 10
      },
      {
        "text": "المفاتيح",
        "points": 7
      }
    ]
  },
  {
    "question": "شيء تراه في السماء ليلاً؟",
    "answers": [
      {
        "text": "القمر",
        "points": 40
      },
      {
        "text": "النجوم",
        "points": 30
      },
      {
        "text": "الطائرات",
        "points": 15
      },
      {
        "text": "الغيوم",
        "points": 10
      },
      {
        "text": "الشهب",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء تشوفه غالباً في محطة البنزين على الطريق السريع؟",
    "answers": [
      {
        "text": "بقالة / تموينات",
        "points": 35
      },
      {
        "text": "كوفي شوب درايف ثرو",
        "points": 25
      },
      {
        "text": "صراف آلي",
        "points": 20
      },
      {
        "text": "مسجد / دورات مياه",
        "points": 10
      },
      {
        "text": "بنشر / ورشة إطارات",
        "points": 10
      }
    ]
  },
  {
    "question": "تصرف يسويه الشخص إذا عصب أو تنرفز؟",
    "answers": [
      {
        "text": "يرفع صوته / يصارخ",
        "points": 35
      },
      {
        "text": "يسكت ويقفل على نفسه",
        "points": 25
      },
      {
        "text": "يتعوذ من إبليس / يستغفر",
        "points": 20
      },
      {
        "text": "يطلع من المكان",
        "points": 10
      },
      {
        "text": "يكسر أو يرمي شيء",
        "points": 10
      }
    ]
  },
  {
    "question": "عضو من أعضاء الوجه؟",
    "answers": [
      {
        "text": "العين",
        "points": 40
      },
      {
        "text": "الأنف / الخشم",
        "points": 25
      },
      {
        "text": "الفم",
        "points": 15
      },
      {
        "text": "الأذن",
        "points": 10
      },
      {
        "text": "الحاجب",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تلبسه في قدمك؟",
    "answers": [
      {
        "text": "حذاء / جزمة",
        "points": 40
      },
      {
        "text": "جوارب / شرابات",
        "points": 30
      },
      {
        "text": "شبشب / نعال",
        "points": 15
      },
      {
        "text": "بوت أمان",
        "points": 10
      },
      {
        "text": "صندل",
        "points": 5
      }
    ]
  },
  {
    "question": "لون طبيعي لشعر الإنسان؟",
    "answers": [
      {
        "text": "أسود",
        "points": 40
      },
      {
        "text": "بني",
        "points": 30
      },
      {
        "text": "أشقر",
        "points": 15
      },
      {
        "text": "أبيض / شيب",
        "points": 10
      },
      {
        "text": "أحمر",
        "points": 5
      }
    ]
  },
  {
    "question": "إضافة تطلبها غالباً مع وجبة البروستد؟",
    "answers": [
      {
        "text": "ثوم",
        "points": 40
      },
      {
        "text": "بطاطس زيادة",
        "points": 25
      },
      {
        "text": "حمص",
        "points": 15
      },
      {
        "text": "مشروب غازي",
        "points": 10
      },
      {
        "text": "خبز زيادة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء أساسي ومطلوب لفتح حساب بنكي جديد؟",
    "answers": [
      {
        "text": "الهوية الوطنية",
        "points": 40
      },
      {
        "text": "رقم جوال مسجل باسمك",
        "points": 30
      },
      {
        "text": "حساب أبشر",
        "points": 15
      },
      {
        "text": "العنوان الوطني",
        "points": 10
      },
      {
        "text": "البريد الإلكتروني",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء تستخدمه لمعرفة الوقت؟",
    "answers": [
      {
        "text": "ساعة اليد",
        "points": 40
      },
      {
        "text": "الجوال",
        "points": 30
      },
      {
        "text": "ساعة الحائط",
        "points": 15
      },
      {
        "text": "الشمس / الظل",
        "points": 10
      },
      {
        "text": "راديو السيارة",
        "points": 5
      }
    ]
  },
  {
    "question": "نوع مشهور من أنواع التمور في السعودية؟",
    "answers": [
      {
        "text": "خلاص",
        "points": 40
      },
      {
        "text": "سكري",
        "points": 25
      },
      {
        "text": "عجوة",
        "points": 15
      },
      {
        "text": "صقعي",
        "points": 10
      },
      {
        "text": "برحي",
        "points": 10
      }
    ]
  },
  {
    "question": "فاكهة الناس تأكلها بقشرها؟",
    "answers": [
      {
        "text": "تفاح",
        "points": 40
      },
      {
        "text": "عنب",
        "points": 25
      },
      {
        "text": "خوخ",
        "points": 15
      },
      {
        "text": "كمثرى",
        "points": 10
      },
      {
        "text": "تين",
        "points": 10
      }
    ]
  },
  {
    "question": "مشروب ساخن يفضله الناس مع وجبة الإفطار؟",
    "answers": [
      {
        "text": "الشاي",
        "points": 40
      },
      {
        "text": "القهوة",
        "points": 30
      },
      {
        "text": "الحليب",
        "points": 15
      },
      {
        "text": "الكرك",
        "points": 10
      },
      {
        "text": "النسكافيه",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء يخليك تعرق بشكل كبير؟",
    "answers": [
      {
        "text": "الجو الحار / شمس الصيف",
        "points": 40
      },
      {
        "text": "الرياضة / الركض",
        "points": 30
      },
      {
        "text": "الأكل الحار / السبايسي",
        "points": 15
      },
      {
        "text": "الخوف / التوتر",
        "points": 10
      },
      {
        "text": "شرب شيء حار جداً",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء يخرب عليك الطلعة والتمشية في الحديقة أو المنتزه؟",
    "answers": [
      {
        "text": "الحر / الغبار",
        "points": 40
      },
      {
        "text": "الزحمة",
        "points": 30
      },
      {
        "text": "الذباب / النامس",
        "points": 15
      },
      {
        "text": "إزعاج الأطفال",
        "points": 10
      },
      {
        "text": "الأكل يكب أو يخرب",
        "points": 5
      }
    ]
  },
  {
    "question": "مكان تذهب إليه لشراء ملابس جديدة؟",
    "answers": [
      {
        "text": "المول / السوق",
        "points": 40
      },
      {
        "text": "المحلات التجارية / البوتيك",
        "points": 25
      },
      {
        "text": "المواقع الإلكترونية",
        "points": 15
      },
      {
        "text": "الخياط",
        "points": 10
      },
      {
        "text": "حراج أو أسواق شعبية",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تكرهه أو يزعجك في السفر بالسيارة؟",
    "answers": [
      {
        "text": "طول الطريق / الملل",
        "points": 40
      },
      {
        "text": "نقاط التفتيش",
        "points": 25
      },
      {
        "text": "المطبات والحفر",
        "points": 15
      },
      {
        "text": "دورات المياه على الطريق",
        "points": 10
      },
      {
        "text": "حرارة الجو",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يتلف أو يخرب تماماً إذا طاح في الموية؟",
    "answers": [
      {
        "text": "الجوال / الإلكترونيات",
        "points": 40
      },
      {
        "text": "الأوراق / الدفاتر",
        "points": 25
      },
      {
        "text": "السكر / الملح",
        "points": 15
      },
      {
        "text": "الخبز / البسكويت",
        "points": 10
      },
      {
        "text": "الحديد يصدي",
        "points": 10
      }
    ]
  },
  {
    "question": "اذكر سلاحاً قديماً يُستخدم للمواجهة أو الحماية؟",
    "answers": [
      {
        "text": "السيف",
        "points": 50
      },
      {
        "text": "الرمح",
        "points": 20
      },
      {
        "text": "الدرع",
        "points": 15
      },
      {
        "text": "القوس والنشاب",
        "points": 10
      },
      {
        "text": "الخنجر",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء أساسي تلقاه في شنطة أي شخص يروح النادي باستمرار؟",
    "answers": [
      {
        "text": "مطارة موية",
        "points": 31
      },
      {
        "text": "منشفة",
        "points": 22
      },
      {
        "text": "ملابس غيار",
        "points": 17
      },
      {
        "text": "سماعات",
        "points": 13
      },
      {
        "text": "مزيج البروتين",
        "points": 10
      },
      {
        "text": "مزيل عرق",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر ركناً من أركان الإسلام؟",
    "answers": [
      {
        "text": "الصلاة",
        "points": 40
      },
      {
        "text": "الحج",
        "points": 25
      },
      {
        "text": "الزكاة",
        "points": 15
      },
      {
        "text": "صوم رمضان",
        "points": 10
      },
      {
        "text": "الشهادتان",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تلقاه دائماً في الشنطة الخلفية للسيارة؟",
    "answers": [
      {
        "text": "كفر استبنة / سبير",
        "points": 40
      },
      {
        "text": "عدة سيارة / مفكات",
        "points": 25
      },
      {
        "text": "عفش / شناط",
        "points": 15
      },
      {
        "text": "موية رديتر / زيت",
        "points": 10
      },
      {
        "text": "عزبة بر أو حطب",
        "points": 10
      }
    ]
  },
  {
    "question": "مناسبة تحتفل بها وتشتري لها كيكة؟",
    "answers": [
      {
        "text": "يوم ميلاد",
        "points": 40
      },
      {
        "text": "نجاح / تخرج",
        "points": 25
      },
      {
        "text": "ذكرى زواج",
        "points": 15
      },
      {
        "text": "ترقية بالعمل",
        "points": 10
      },
      {
        "text": "سلامة مريض",
        "points": 10
      }
    ]
  },
  {
    "question": "مادة أو أداة تستخدم لإطفاء النار؟",
    "answers": [
      {
        "text": "الماء",
        "points": 40
      },
      {
        "text": "طفاية الحريق",
        "points": 30
      },
      {
        "text": "البطانية / القماش",
        "points": 15
      },
      {
        "text": "الرمل / التراب",
        "points": 10
      },
      {
        "text": "الرغوة",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء أساسي تلقاه في شنطة أي امرأة؟",
    "answers": [
      {
        "text": "روج / مكياج",
        "points": 40
      },
      {
        "text": "عطر",
        "points": 25
      },
      {
        "text": "محفظة فلوس",
        "points": 15
      },
      {
        "text": "مناديل",
        "points": 10
      },
      {
        "text": "مفاتيح",
        "points": 10
      }
    ]
  },
  {
    "question": "كلمة دائماً نقولها للشخص اللي توه طالع من الحلاق أو متروش؟",
    "answers": [
      {
        "text": "نعيماً",
        "points": 31
      },
      {
        "text": "ما شاء الله",
        "points": 22
      },
      {
        "text": "وش هالزين",
        "points": 17
      },
      {
        "text": "مبروك الحلاقة",
        "points": 13
      },
      {
        "text": "عشت",
        "points": 10
      },
      {
        "text": "منور",
        "points": 7
      }
    ]
  },
  {
    "question": "مكان عام يطلب منك فيه التزام الهدوء وعدم رفع الصوت؟",
    "answers": [
      {
        "text": "المسجد",
        "points": 40
      },
      {
        "text": "المستشفى / العيادة",
        "points": 25
      },
      {
        "text": "المكتبة",
        "points": 15
      },
      {
        "text": "قاعة الامتحان",
        "points": 10
      },
      {
        "text": "العزاء",
        "points": 10
      }
    ]
  },
  {
    "question": "حشوة أساسية تطلبها في سندويتش الفطور؟",
    "answers": [
      {
        "text": "جبن",
        "points": 40
      },
      {
        "text": "بيض",
        "points": 25
      },
      {
        "text": "كبدة",
        "points": 15
      },
      {
        "text": "فلافل",
        "points": 10
      },
      {
        "text": "تونة",
        "points": 10
      }
    ]
  },
  {
    "question": "حيوان يشتهر بأنه بطيء جداً؟",
    "answers": [
      {
        "text": "السلحفاة",
        "points": 40
      },
      {
        "text": "الحلزون",
        "points": 30
      },
      {
        "text": "الكسلان",
        "points": 15
      },
      {
        "text": "الدودة",
        "points": 10
      },
      {
        "text": "التمساح",
        "points": 5
      }
    ]
  },
  {
    "question": "مهنة تتطلب مجهوداً وتعباً بدنياً كبيراً؟",
    "answers": [
      {
        "text": "عامل بناء / مقاولات",
        "points": 40
      },
      {
        "text": "حداد",
        "points": 25
      },
      {
        "text": "نجار",
        "points": 15
      },
      {
        "text": "سباك",
        "points": 10
      },
      {
        "text": "مزارع",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء في غرفتك مصنوع من الخشب؟",
    "answers": [
      {
        "text": "السرير",
        "points": 40
      },
      {
        "text": "الدولاب",
        "points": 25
      },
      {
        "text": "الطاولة",
        "points": 15
      },
      {
        "text": "الكرسي",
        "points": 10
      },
      {
        "text": "الباب",
        "points": 10
      }
    ]
  },
  {
    "question": "رياضة أو هواية منتشرة بين الشباب في السعودية؟",
    "answers": [
      {
        "text": "كرة القدم",
        "points": 40
      },
      {
        "text": "البادل",
        "points": 30
      },
      {
        "text": "البلايستيشن / الألعاب",
        "points": 15
      },
      {
        "text": "الحديد / كمال الأجسام",
        "points": 10
      },
      {
        "text": "التطعيس / البر",
        "points": 5
      }
    ]
  },
  {
    "question": "فاكهة طعمها حامض؟",
    "answers": [
      {
        "text": "الليمون",
        "points": 40
      },
      {
        "text": "البرتقال",
        "points": 25
      },
      {
        "text": "الكيوي",
        "points": 15
      },
      {
        "text": "الرمان",
        "points": 10
      },
      {
        "text": "الفراولة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تسويه أول ما تركب الطيارة وتجلس في مقعدك؟",
    "answers": [
      {
        "text": "أربط حزام الأمان",
        "points": 31
      },
      {
        "text": "أحط وضع الطيران",
        "points": 22
      },
      {
        "text": "أدور دعاء السفر",
        "points": 17
      },
      {
        "text": "أنام",
        "points": 13
      },
      {
        "text": "أقرأ المجلة / الشاشة",
        "points": 10
      },
      {
        "text": "أصور من النافذة",
        "points": 7
      }
    ]
  },
  {
    "question": "صنف من المخبوزات تشتريه من المخبز؟",
    "answers": [
      {
        "text": "خبز مفرود",
        "points": 40
      },
      {
        "text": "صامولي",
        "points": 25
      },
      {
        "text": "فطائر / معجنات",
        "points": 15
      },
      {
        "text": "كيك",
        "points": 10
      },
      {
        "text": "شابورة",
        "points": 10
      }
    ]
  },
  {
    "question": "سمّ حيواناً ضخماً؟",
    "answers": [
      {
        "text": "الفيل",
        "points": 45
      },
      {
        "text": "الحوت",
        "points": 20
      },
      {
        "text": "النعامة",
        "points": 15
      },
      {
        "text": "وحيد القرن",
        "points": 10
      },
      {
        "text": "الزرافة",
        "points": 10
      }
    ]
  },
  {
    "question": "صنف أو نوع من الأفلام يجذب الناس لمتابعته أكثر من غيره؟",
    "answers": [
      {
        "text": "الأكشن / الإثارة",
        "points": 31
      },
      {
        "text": "الكوميدي",
        "points": 22
      },
      {
        "text": "الرعب",
        "points": 17
      },
      {
        "text": "الغموض / الجريمة",
        "points": 13
      },
      {
        "text": "الدراما / قصص واقعية",
        "points": 10
      },
      {
        "text": "الخيال العلمي",
        "points": 7
      }
    ]
  },
  {
    "question": "مشروب ساخن يطلبه الناس في الكافيهات غير الشاي والقهوة؟",
    "answers": [
      {
        "text": "كاكاو ساخن / هوت تشوكلت",
        "points": 40
      },
      {
        "text": "حليب بالزنجبيل",
        "points": 25
      },
      {
        "text": "سحلب",
        "points": 15
      },
      {
        "text": "نعناع / يانسون",
        "points": 10
      },
      {
        "text": "كرك",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء أساسي تحطه في السلطة الخضراء؟",
    "answers": [
      {
        "text": "طماطم",
        "points": 31
      },
      {
        "text": "خيار",
        "points": 22
      },
      {
        "text": "ملفوف",
        "points": 17
      },
      {
        "text": "خس",
        "points": 13
      },
      {
        "text": "ليمون / زيت زيتون",
        "points": 10
      },
      {
        "text": "جزر",
        "points": 7
      }
    ]
  },
  {
    "question": "أول ردة فعل لك إذا شفت حشرة أو صرصور في الغرفة؟",
    "answers": [
      {
        "text": "أصرخ / أهرب",
        "points": 35
      },
      {
        "text": "أجيب بف باف / مبيد حشري",
        "points": 30
      },
      {
        "text": "أضربه بالنعال",
        "points": 15
      },
      {
        "text": "أطلع وأقفل الباب",
        "points": 10
      },
      {
        "text": "أنادي أحد يقتله",
        "points": 10
      }
    ]
  },
  {
    "question": "رياضة شهيرة يتم لعبها باستخدام الكرة؟",
    "answers": [
      {
        "text": "كرة القدم",
        "points": 31
      },
      {
        "text": "كرة السلة",
        "points": 22
      },
      {
        "text": "الكرة الطائرة",
        "points": 17
      },
      {
        "text": "بيسبول",
        "points": 13
      },
      {
        "text": "التنس",
        "points": 10
      },
      {
        "text": "البلياردو",
        "points": 7
      }
    ]
  },
  {
    "question": "دولة خليجية يكثر سفر السعوديين لها في الإجازات القصيرة؟",
    "answers": [
      {
        "text": "البحرين",
        "points": 40
      },
      {
        "text": "الإمارات / دبي",
        "points": 30
      },
      {
        "text": "الكويت",
        "points": 15
      },
      {
        "text": "قطر",
        "points": 10
      },
      {
        "text": "عمان",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء تعطيه للطفل الصغير ليجعله يفرح فوراً؟",
    "answers": [
      {
        "text": "لعبة",
        "points": 40
      },
      {
        "text": "حلاوة / شوكولاتة",
        "points": 30
      },
      {
        "text": "فلوس / عيدية",
        "points": 15
      },
      {
        "text": "آيس كريم",
        "points": 10
      },
      {
        "text": "جوال / آيباد",
        "points": 5
      }
    ]
  },
  {
    "question": "غرض تضعه في الحقيبة إذا كنت ذاهباً للبحر؟",
    "answers": [
      {
        "text": "منشفة / فوطة",
        "points": 40
      },
      {
        "text": "ملابس سباحة",
        "points": 25
      },
      {
        "text": "واقي شمس",
        "points": 15
      },
      {
        "text": "شبشب / حذاء بحر",
        "points": 10
      },
      {
        "text": "نظارة غوص",
        "points": 10
      }
    ]
  },
  {
    "question": "تصرف يرفع ضغطك من السائقين في الشارع؟",
    "answers": [
      {
        "text": "يلف بدون دق إشارة",
        "points": 31
      },
      {
        "text": "يسوق ببطء باليسار",
        "points": 22
      },
      {
        "text": "يسقط عليك",
        "points": 17
      },
      {
        "text": "يستخدم الجوال",
        "points": 13
      },
      {
        "text": "يوقف بمكان ممنوع",
        "points": 10
      },
      {
        "text": "يضرب بوري باستمرار",
        "points": 7
      }
    ]
  },
  {
    "question": "رسالة تجيك على الجوال تخليك تبتسم لا شعورياً؟",
    "answers": [
      {
        "text": "إيداع الراتب / حوالة",
        "points": 31
      },
      {
        "text": "تم توصيل طلبك",
        "points": 22
      },
      {
        "text": "رسالة من شخص غالي",
        "points": 17
      },
      {
        "text": "خصم / إعفاء من رسوم",
        "points": 13
      },
      {
        "text": "إلغاء موعد / تعليق الدوام",
        "points": 10
      },
      {
        "text": "رسالة تفعيل / كود",
        "points": 7
      }
    ]
  },
  {
    "question": "وسيلة تسلية تستخدمها لتمضية الوقت في رحلة طيران طويلة؟",
    "answers": [
      {
        "text": "أتابع فيلم أو مسلسل",
        "points": 35
      },
      {
        "text": "أنام",
        "points": 30
      },
      {
        "text": "أقرأ كتاب",
        "points": 15
      },
      {
        "text": "ألعب ألعاب في الجوال أو الشاشة",
        "points": 10
      },
      {
        "text": "أستمع لمقاطع صوتية / بودكاست",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء موجود دائماً في الدرج الأمامي للسيارة؟",
    "answers": [
      {
        "text": "مناديل",
        "points": 40
      },
      {
        "text": "استمارة وأوراق السيارة",
        "points": 25
      },
      {
        "text": "سلك أو شاحن إضافي",
        "points": 15
      },
      {
        "text": "عطر أو بخور",
        "points": 10
      },
      {
        "text": "نظارة شمسية",
        "points": 10
      }
    ]
  },
  {
    "question": "سبب يخلي الطفل الرضيع يبكي باستمرار؟",
    "answers": [
      {
        "text": "جوعان / يبي حليب",
        "points": 40
      },
      {
        "text": "يبي ينام",
        "points": 25
      },
      {
        "text": "يحتاج تغيير حفاظة",
        "points": 15
      },
      {
        "text": "ممغوص / بطنه يوجعه",
        "points": 10
      },
      {
        "text": "يسنن",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء لونه أبيض وموجود في أغلب الثلاجات؟",
    "answers": [
      {
        "text": "لبن / حليب",
        "points": 31
      },
      {
        "text": "جبن كاسات",
        "points": 22
      },
      {
        "text": "بيض",
        "points": 17
      },
      {
        "text": "مايونيز",
        "points": 13
      },
      {
        "text": "قشطة",
        "points": 10
      },
      {
        "text": "زبادي",
        "points": 7
      }
    ]
  },
  {
    "question": "شيء تدهن به شريحة الخبز التوست؟",
    "answers": [
      {
        "text": "جبن سائل",
        "points": 40
      },
      {
        "text": "قشطة",
        "points": 25
      },
      {
        "text": "مربى",
        "points": 15
      },
      {
        "text": "زبدة الفول السوداني",
        "points": 10
      },
      {
        "text": "نوتيلا / شوكولاتة",
        "points": 10
      }
    ]
  },
  {
    "question": "منتج يكثر شراؤه واستخدامه في فصل الصيف؟",
    "answers": [
      {
        "text": "آيس كريم / بارد",
        "points": 40
      },
      {
        "text": "واقي شمس",
        "points": 25
      },
      {
        "text": "نظارة شمسية",
        "points": 15
      },
      {
        "text": "ملابس بحر / سباحة",
        "points": 10
      },
      {
        "text": "مزيل عرق",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يفعله الناس عادة عندما ينزل المطر؟",
    "answers": [
      {
        "text": "الدعاء",
        "points": 40
      },
      {
        "text": "التصوير بالجوال",
        "points": 25
      },
      {
        "text": "الخروج للتمشية",
        "points": 15
      },
      {
        "text": "شرب مشروب دافئ",
        "points": 10
      },
      {
        "text": "شم رائحة المطر",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء غالباً يضيع ويطيح بين مخدات الكنب؟",
    "answers": [
      {
        "text": "ريموت التلفزيون",
        "points": 40
      },
      {
        "text": "هللات / فلوس خردة",
        "points": 25
      },
      {
        "text": "الجوال",
        "points": 15
      },
      {
        "text": "مفاتيح",
        "points": 10
      },
      {
        "text": "ألعاب أطفال صغيرة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تضعه داخل أذنك؟",
    "answers": [
      {
        "text": "سماعات",
        "points": 40
      },
      {
        "text": "أعواد قطن للتنظيف",
        "points": 25
      },
      {
        "text": "قطرة طبية",
        "points": 15
      },
      {
        "text": "سدادات أذن",
        "points": 10
      },
      {
        "text": "سماعة طبيب",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء موجود في غرفة الانتظار في العيادات أو المستشفيات؟",
    "answers": [
      {
        "text": "كراسي / كنب",
        "points": 40
      },
      {
        "text": "شاشة تلفزيون",
        "points": 25
      },
      {
        "text": "مجلات / بروشورات",
        "points": 15
      },
      {
        "text": "برادة موية",
        "points": 10
      },
      {
        "text": "لوحة الأرقام",
        "points": 10
      }
    ]
  },
  {
    "question": "اذكر شيئاً لونه أصفر؟",
    "answers": [
      {
        "text": "الشمس",
        "points": 40
      },
      {
        "text": "الليمون",
        "points": 25
      },
      {
        "text": "الموز",
        "points": 15
      },
      {
        "text": "الذهب",
        "points": 10
      },
      {
        "text": "صفار البيض",
        "points": 10
      }
    ]
  },
  {
    "question": "حيوان يعيش في البيئة الصحراوية؟",
    "answers": [
      {
        "text": "الجمل / البعير",
        "points": 40
      },
      {
        "text": "الضب",
        "points": 25
      },
      {
        "text": "الثعبان",
        "points": 15
      },
      {
        "text": "العقرب",
        "points": 10
      },
      {
        "text": "الثعلب",
        "points": 10
      }
    ]
  },
  {
    "question": "تخصص جامعي له شعبية كبيرة ومطلوب في سوق العمل؟",
    "answers": [
      {
        "text": "علوم حاسب / أمن سيبراني",
        "points": 40
      },
      {
        "text": "طب بشري",
        "points": 25
      },
      {
        "text": "هندسة",
        "points": 15
      },
      {
        "text": "إدارة أعمال / مالية",
        "points": 10
      },
      {
        "text": "قانون",
        "points": 10
      }
    ]
  },
  {
    "question": "تصرف روتيني تسويه قبل ما تنام مباشرة؟",
    "answers": [
      {
        "text": "أضبط المنبه",
        "points": 40
      },
      {
        "text": "أقرأ أذكار النوم",
        "points": 25
      },
      {
        "text": "أقلب في الجوال",
        "points": 15
      },
      {
        "text": "أطفي النور",
        "points": 10
      },
      {
        "text": "أشرب موية",
        "points": 10
      }
    ]
  },
  {
    "question": "اسم ولد سعودي يتكون من ٣ حروف؟",
    "answers": [
      {
        "text": "فهد",
        "points": 40
      },
      {
        "text": "سعد",
        "points": 25
      },
      {
        "text": "عمر",
        "points": 15
      },
      {
        "text": "علي",
        "points": 10
      },
      {
        "text": "بدر",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يخلي الأب يهاوش العيال في البيت؟",
    "answers": [
      {
        "text": "الإزعاج / الصراخ",
        "points": 31
      },
      {
        "text": "السهر لوقت متأخر",
        "points": 22
      },
      {
        "text": "اللعب في الجوال كثير",
        "points": 17
      },
      {
        "text": "ترك اللمبات شغالة",
        "points": 13
      },
      {
        "text": "المضاربات بين الإخوان",
        "points": 10
      },
      {
        "text": "عدم حل الواجبات",
        "points": 7
      }
    ]
  },
  {
    "question": "تطبيق في الجوال مستحيل يمر يوم بدون ما تفتحه وتستخدمه؟",
    "answers": [
      {
        "text": "واتساب",
        "points": 31
      },
      {
        "text": "تيك توك",
        "points": 22
      },
      {
        "text": "تويتر / إكس",
        "points": 17
      },
      {
        "text": "سناب شات",
        "points": 13
      },
      {
        "text": "انستقرام",
        "points": 10
      },
      {
        "text": "تطبيق البنك",
        "points": 7
      }
    ]
  },
  {
    "question": "مهنة تتطلب لبس زي رسمي موحد؟",
    "answers": [
      {
        "text": "عسكري / شرطي",
        "points": 40
      },
      {
        "text": "دكتور / ممرض",
        "points": 25
      },
      {
        "text": "طيار",
        "points": 15
      },
      {
        "text": "حارس أمن",
        "points": 10
      },
      {
        "text": "كاشير أو بائع",
        "points": 10
      }
    ]
  },
  {
    "question": "أكلة سريعة مشهورة تطلبها إذا كنت جوعان ومستعجل؟",
    "answers": [
      {
        "text": "شاورما",
        "points": 40
      },
      {
        "text": "برجر",
        "points": 30
      },
      {
        "text": "بروستد",
        "points": 15
      },
      {
        "text": "فلافل / طعمية",
        "points": 10
      },
      {
        "text": "بيتزا",
        "points": 5
      }
    ]
  },
  {
    "question": "هدية شائعة تقدم لشخص بمناسبة التخرج؟",
    "answers": [
      {
        "text": "فلوس / كاش / حوالة",
        "points": 40
      },
      {
        "text": "باقة ورد",
        "points": 25
      },
      {
        "text": "ساعة فخمة",
        "points": 15
      },
      {
        "text": "جوال جديد",
        "points": 10
      },
      {
        "text": "شوكولاتة / كيكة",
        "points": 10
      }
    ]
  },
  {
    "question": "مهنة أو حرفة تستخدم المقص بشكل أساسي؟",
    "answers": [
      {
        "text": "حلاق",
        "points": 40
      },
      {
        "text": "خياط",
        "points": 30
      },
      {
        "text": "طبيب جراح",
        "points": 15
      },
      {
        "text": "مزارع",
        "points": 10
      },
      {
        "text": "طباخ",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء تضعه في الثلاجة حتى لا يفسد؟",
    "answers": [
      {
        "text": "الحليب والألبان",
        "points": 40
      },
      {
        "text": "اللحم أو الدجاج",
        "points": 25
      },
      {
        "text": "الخضروات",
        "points": 15
      },
      {
        "text": "الفواكه",
        "points": 10
      },
      {
        "text": "الأدوية",
        "points": 10
      }
    ]
  },
  {
    "question": "اذكر شخصاً يمكنك أن تسلمه سرك وأنت مرتاح؟",
    "answers": [
      {
        "text": "أمي",
        "points": 40
      },
      {
        "text": "صديقي المقرب",
        "points": 20
      },
      {
        "text": "زوجتي / زوجي",
        "points": 15
      },
      {
        "text": "أختي",
        "points": 15
      },
      {
        "text": "أخوي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تأخذه معك للمستشفى إذا بتزور مريض؟",
    "answers": [
      {
        "text": "ورد",
        "points": 40
      },
      {
        "text": "شوكولاتة",
        "points": 25
      },
      {
        "text": "عصير",
        "points": 15
      },
      {
        "text": "قهوة",
        "points": 10
      },
      {
        "text": "مبلغ مالي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تقدمه المطاعم البحرية كطبق جانبي مع السمك؟",
    "answers": [
      {
        "text": "رز صيادية",
        "points": 40
      },
      {
        "text": "طحينة",
        "points": 25
      },
      {
        "text": "سلطة حمر / دقوس",
        "points": 15
      },
      {
        "text": "بطاطس مقلي",
        "points": 10
      },
      {
        "text": "جرجير / خبز",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يصحيك من النوم فجأة غير المنبه؟",
    "answers": [
      {
        "text": "أحد يدخل الغرفة / يناديك",
        "points": 35
      },
      {
        "text": "صوت الباب أو الجرس",
        "points": 25
      },
      {
        "text": "ريحة أكل أو قهوة",
        "points": 15
      },
      {
        "text": "نور الشمس أو اللمبة",
        "points": 15
      },
      {
        "text": "حلم مزعج / كابوس",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يخاف منه السائق وهو ماسك خط سفر طويل؟",
    "answers": [
      {
        "text": "كاميرات ساهر / الرادار",
        "points": 40
      },
      {
        "text": "الجمال والحيوانات السائبة",
        "points": 25
      },
      {
        "text": "ينفجر الكفر / بنشر",
        "points": 15
      },
      {
        "text": "ينام أو ينعس على الدركسون",
        "points": 10
      },
      {
        "text": "يخلص البنزين",
        "points": 10
      }
    ]
  },
  {
    "question": "جهاز إلكتروني يحتوي على شاشة؟",
    "answers": [
      {
        "text": "الجوال الذكي",
        "points": 40
      },
      {
        "text": "التلفزيون",
        "points": 30
      },
      {
        "text": "اللابتوب / الكمبيوتر",
        "points": 15
      },
      {
        "text": "الآيباد / التابلت",
        "points": 10
      },
      {
        "text": "الساعة الذكية",
        "points": 5
      }
    ]
  },
  {
    "question": "أداة تستخدمها لتناول الطعام؟",
    "answers": [
      {
        "text": "الملعقة",
        "points": 40
      },
      {
        "text": "الشوكة",
        "points": 25
      },
      {
        "text": "السكين",
        "points": 15
      },
      {
        "text": "اليد",
        "points": 10
      },
      {
        "text": "عيدان الأكل",
        "points": 10
      }
    ]
  },
  {
    "question": "عذر مشهور يقوله الطالب للمدير أو المعلم إذا تأخر عن طابور الصباح؟",
    "answers": [
      {
        "text": "زحمة الطريق",
        "points": 31
      },
      {
        "text": "السيارة خربت",
        "points": 22
      },
      {
        "text": "راحت علي نومة",
        "points": 17
      },
      {
        "text": "السواق تأخر",
        "points": 13
      },
      {
        "text": "أخوي تأخر",
        "points": 10
      },
      {
        "text": "ما لقيت موقف",
        "points": 7
      }
    ]
  },
  {
    "question": "شيء يخليك تصحصح وتركز في الصباح؟",
    "answers": [
      {
        "text": "القهوة",
        "points": 40
      },
      {
        "text": "شاور / ترويشة باردة",
        "points": 25
      },
      {
        "text": "الشاي",
        "points": 15
      },
      {
        "text": "غسيل الوجه بموية باردة",
        "points": 10
      },
      {
        "text": "الفطور",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تسويه إذا حسيت بالملل الشديد في البيت؟",
    "answers": [
      {
        "text": "أفتح السوشيال ميديا",
        "points": 35
      },
      {
        "text": "أتابع مسلسل أو فيلم",
        "points": 25
      },
      {
        "text": "أنام",
        "points": 20
      },
      {
        "text": "أروح أفتح الثلاجة آكل",
        "points": 10
      },
      {
        "text": "أكلم أحد من أخوياي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يخليك تقفل المتجر الإلكتروني أو الموقع فوراً بدون ما تشتري؟",
    "answers": [
      {
        "text": "الأسعار مبالغ فيها",
        "points": 31
      },
      {
        "text": "رسوم التوصيل مرتفعة",
        "points": 22
      },
      {
        "text": "الموقع يعلق / بطيء",
        "points": 17
      },
      {
        "text": "يطلب تسجيل إجباري",
        "points": 13
      },
      {
        "text": "تصميم الموقع سيء",
        "points": 10
      },
      {
        "text": "ما فيه أبل باي",
        "points": 7
      }
    ]
  },
  {
    "question": "شيء ممكن تستعيره أو تطلبه من جيرانك؟",
    "answers": [
      {
        "text": "بصل / طماطم",
        "points": 35
      },
      {
        "text": "خبز",
        "points": 25
      },
      {
        "text": "سكر / ملح",
        "points": 20
      },
      {
        "text": "دلة أو صحون عزيمة",
        "points": 10
      },
      {
        "text": "شاحن أو وصلة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يتم استخدامه لتزيين الكيك والحلويات؟",
    "answers": [
      {
        "text": "كريمة",
        "points": 35
      },
      {
        "text": "فراولة / فواكه",
        "points": 25
      },
      {
        "text": "شوكولاتة مبشورة",
        "points": 20
      },
      {
        "text": "مكسرات",
        "points": 10
      },
      {
        "text": "شموع",
        "points": 10
      }
    ]
  },
  {
    "question": "كلمة أو جملة دائماً يقولها المعلم للطلاب في الفصل؟",
    "answers": [
      {
        "text": "الهدوء يا شباب",
        "points": 31
      },
      {
        "text": "افتحوا الكتاب صفحة...",
        "points": 22
      },
      {
        "text": "مين يجاوب؟ / ارفع يدك",
        "points": 17
      },
      {
        "text": "ركزوا معاي",
        "points": 13
      },
      {
        "text": "اللي ورا يجي قدام",
        "points": 10
      },
      {
        "text": "الواجب بكرة",
        "points": 7
      }
    ]
  },
  {
    "question": "موقف محرج يصير لك فجأة وأنت جالس في عزيمة رسمية؟",
    "answers": [
      {
        "text": "تنكب القهوة أو الشاي عليك",
        "points": 31
      },
      {
        "text": "بطنك يطلع صوت",
        "points": 22
      },
      {
        "text": "تنسى اسم الشخص",
        "points": 17
      },
      {
        "text": "تطيح اللقمة من يدك",
        "points": 13
      },
      {
        "text": "يدق جوالك برنة محرجة",
        "points": 10
      },
      {
        "text": "ينشق ثوبك / ينقطع زرارك",
        "points": 7
      }
    ]
  },
  {
    "question": "أداة تنظيف موجودة في كل بيت؟",
    "answers": [
      {
        "text": "مكنسة",
        "points": 40
      },
      {
        "text": "ممسحة",
        "points": 25
      },
      {
        "text": "إسفنجة",
        "points": 15
      },
      {
        "text": "صابون / كلوركس",
        "points": 10
      },
      {
        "text": "فوطة تمسيح",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يسويه السائق وهو واقف ينتظر الإشارة تفتح؟",
    "answers": [
      {
        "text": "يمسك الجوال",
        "points": 40
      },
      {
        "text": "يطالع في السيارات الثانية",
        "points": 25
      },
      {
        "text": "يعدل الشماغ أو الميك أب",
        "points": 15
      },
      {
        "text": "يغير محطة الراديو",
        "points": 10
      },
      {
        "text": "يشرب موية أو قهوة",
        "points": 10
      }
    ]
  },
  {
    "question": "نوع من الخضروات لونه أخضر؟",
    "answers": [
      {
        "text": "خيار",
        "points": 40
      },
      {
        "text": "خس",
        "points": 25
      },
      {
        "text": "فلفل رومي",
        "points": 15
      },
      {
        "text": "جرجير",
        "points": 10
      },
      {
        "text": "كوسة",
        "points": 10
      }
    ]
  },
  {
    "question": "معاملة تجبرك تروح لفرع البنك وماتقدر تخلصها بالتطبيق؟",
    "answers": [
      {
        "text": "استلام بطاقة صراف جديدة",
        "points": 40
      },
      {
        "text": "فتح حساب لأول مرة",
        "points": 25
      },
      {
        "text": "إيداع مبلغ كاش كبير / شيك",
        "points": 15
      },
      {
        "text": "تحديث بيانات الهوية",
        "points": 10
      },
      {
        "text": "أخذ قرض أو تمويل",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تسويه إذا انقطع النت في البيت فجأة؟",
    "answers": [
      {
        "text": "أطفي المودم وأشغله",
        "points": 40
      },
      {
        "text": "أنام",
        "points": 25
      },
      {
        "text": "أفتح بيانات الجوال",
        "points": 15
      },
      {
        "text": "أسولف مع أهلي",
        "points": 10
      },
      {
        "text": "أرتب غرفتي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء تتأكد إنه معك قبل ما تطلع من باب البيت؟",
    "answers": [
      {
        "text": "الجوال",
        "points": 35
      },
      {
        "text": "المفاتيح",
        "points": 30
      },
      {
        "text": "المحفظة / الفلوس",
        "points": 15
      },
      {
        "text": "بطاقة العمل / الهوية",
        "points": 10
      },
      {
        "text": "النظارة الشمسية",
        "points": 10
      }
    ]
  },
  {
    "question": "مادة أو شيء ينكسر بسهولة إذا سقط؟",
    "answers": [
      {
        "text": "الزجاج",
        "points": 40
      },
      {
        "text": "الصحون / الأكواب",
        "points": 25
      },
      {
        "text": "البيض",
        "points": 15
      },
      {
        "text": "شاشة الجوال",
        "points": 10
      },
      {
        "text": "الفخار",
        "points": 10
      }
    ]
  },
  {
    "question": "لون مشهور تتميز فيه سيارات الأجرة التاكسي حول العالم؟",
    "answers": [
      {
        "text": "أصفر",
        "points": 40
      },
      {
        "text": "أبيض",
        "points": 25
      },
      {
        "text": "أخضر",
        "points": 15
      },
      {
        "text": "أسود",
        "points": 10
      },
      {
        "text": "أحمر",
        "points": 10
      }
    ]
  },
  {
    "question": "شخص تلجأ إليه لتستلف منه مبلغاً من المال إذا احتجت؟",
    "answers": [
      {
        "text": "الأب",
        "points": 40
      },
      {
        "text": "الأخ",
        "points": 25
      },
      {
        "text": "الصديق المقرب",
        "points": 15
      },
      {
        "text": "الزوج / الزوجة",
        "points": 10
      },
      {
        "text": "الأم",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يصدر رائحة جميلة ومنعشة؟",
    "answers": [
      {
        "text": "العطر",
        "points": 40
      },
      {
        "text": "البخور / العود",
        "points": 25
      },
      {
        "text": "الورد / الزهور",
        "points": 15
      },
      {
        "text": "الصابون",
        "points": 10
      },
      {
        "text": "الفواحة",
        "points": 10
      }
    ]
  },
  {
    "question": "مكون أساسي تحتاجه لطبخ الكبسة؟",
    "answers": [
      {
        "text": "الأرز",
        "points": 40
      },
      {
        "text": "اللحم أو الدجاج",
        "points": 25
      },
      {
        "text": "البصل",
        "points": 15
      },
      {
        "text": "البهارات",
        "points": 10
      },
      {
        "text": "الطماطم",
        "points": 10
      }
    ]
  },
  {
    "question": "عادة أو عبادة يحرص عليها المسلمون في يوم الجمعة؟",
    "answers": [
      {
        "text": "قراءة سورة الكهف",
        "points": 35
      },
      {
        "text": "صلاة الجمعة بالمسجد",
        "points": 30
      },
      {
        "text": "التبخير والتطيب",
        "points": 15
      },
      {
        "text": "غسل الجمعة",
        "points": 10
      },
      {
        "text": "الإكثار من الصلاة على النبي ﷺ",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء مزعج يصير لك في السينما؟",
    "answers": [
      {
        "text": "ناس تسولف وتتكلم",
        "points": 35
      },
      {
        "text": "جوال يرن أو نوره قوي",
        "points": 25
      },
      {
        "text": "طفل يبكي أو يزعج",
        "points": 20
      },
      {
        "text": "أحد يرفس كرسيك من ورا",
        "points": 10
      },
      {
        "text": "صوت أكل البوب كورن بصوت عالي",
        "points": 10
      }
    ]
  },
  {
    "question": "تصرف تسويه بسرعة إذا اتصل عليك ضيف وقال إنه قريب من البيت؟",
    "answers": [
      {
        "text": "أرتب الصالة والمجلس",
        "points": 35
      },
      {
        "text": "أبخر البيت",
        "points": 25
      },
      {
        "text": "أجهز دلة القهوة",
        "points": 20
      },
      {
        "text": "أغير ملابسي",
        "points": 10
      },
      {
        "text": "أطلب حلا أو معجنات",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يخاف منه الأطفال الصغار عادة؟",
    "answers": [
      {
        "text": "الطبيب / الإبرة",
        "points": 40
      },
      {
        "text": "الظلام",
        "points": 25
      },
      {
        "text": "الكلاب أو الحشرات",
        "points": 15
      },
      {
        "text": "الأصوات العالية",
        "points": 10
      },
      {
        "text": "الغرباء",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء ينساه الناس غالباً عند تجهيز شنطة السفر؟",
    "answers": [
      {
        "text": "فرشاة ومعجون الأسنان",
        "points": 35
      },
      {
        "text": "شاحن الجوال",
        "points": 25
      },
      {
        "text": "النظارة الشمسية",
        "points": 20
      },
      {
        "text": "مزيل العرق أو العطر",
        "points": 10
      },
      {
        "text": "الجوارب / الشرابات",
        "points": 10
      }
    ]
  },
  {
    "question": "أكلة شعبية سعودية يكثر الطلب عليها في فصل الشتاء؟",
    "answers": [
      {
        "text": "الحنيني",
        "points": 35
      },
      {
        "text": "الجريش",
        "points": 30
      },
      {
        "text": "المرقوق",
        "points": 15
      },
      {
        "text": "العصيدة",
        "points": 10
      },
      {
        "text": "المطازيز",
        "points": 10
      }
    ]
  },
  {
    "question": "لون من ألوان قوس قزح؟",
    "answers": [
      {
        "text": "أحمر",
        "points": 40
      },
      {
        "text": "أزرق",
        "points": 25
      },
      {
        "text": "أصفر",
        "points": 15
      },
      {
        "text": "أخضر",
        "points": 10
      },
      {
        "text": "بنفسجي",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء مستحيل تروح السوبر ماركت للتسوق وما تشتريه؟",
    "answers": [
      {
        "text": "خبز / صامولي",
        "points": 31
      },
      {
        "text": "حليب / لبن",
        "points": 22
      },
      {
        "text": "مويه",
        "points": 17
      },
      {
        "text": "بيض",
        "points": 13
      },
      {
        "text": "أجبان / نواشف",
        "points": 10
      },
      {
        "text": "حلويات / شيبس",
        "points": 7
      }
    ]
  },
  {
    "question": "اسم بنت سعودي مشهور ينتهي بالتاء المربوطة؟",
    "answers": [
      {
        "text": "سارة",
        "points": 40
      },
      {
        "text": "نورة",
        "points": 25
      },
      {
        "text": "فاطمة",
        "points": 15
      },
      {
        "text": "حصة",
        "points": 10
      },
      {
        "text": "دانة",
        "points": 10
      }
    ]
  },
  {
    "question": "عبارة شهيرة تقولها لشخص مريض أو طالع من المستشفى؟",
    "answers": [
      {
        "text": "ما تشوف شر",
        "points": 40
      },
      {
        "text": "قدامك العافية",
        "points": 25
      },
      {
        "text": "طهور إن شاء الله",
        "points": 15
      },
      {
        "text": "أجر وعافية",
        "points": 10
      },
      {
        "text": "الحمد لله على السلامة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء ضروري تحتاجه إذا أردت السفر خارج السعودية؟",
    "answers": [
      {
        "text": "جواز السفر",
        "points": 40
      },
      {
        "text": "تذاكر الطيران",
        "points": 25
      },
      {
        "text": "تأشيرة / فيزا",
        "points": 15
      },
      {
        "text": "عملة أجنبية / فلوس",
        "points": 10
      },
      {
        "text": "حقيبة سفر",
        "points": 10
      }
    ]
  },
  {
    "question": "حيوان يصدر صوتاً عالياً ومزعجاً؟",
    "answers": [
      {
        "text": "الأسد",
        "points": 40
      },
      {
        "text": "الكلب",
        "points": 25
      },
      {
        "text": "الديك",
        "points": 15
      },
      {
        "text": "الحمار",
        "points": 10
      },
      {
        "text": "القطط في الليل",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء يعطيك طاقة ونشاطاً لبدء يومك؟",
    "answers": [
      {
        "text": "القهوة",
        "points": 40
      },
      {
        "text": "مشروب الطاقة",
        "points": 25
      },
      {
        "text": "النوم الكافي",
        "points": 15
      },
      {
        "text": "الرياضة",
        "points": 10
      },
      {
        "text": "الفيتامينات",
        "points": 10
      }
    ]
  },
  {
    "question": "كيف تكتشف أن الشخص الذي أمامك يكذب؟",
    "answers": [
      {
        "text": "التلعثم / الارتباك",
        "points": 35
      },
      {
        "text": "التهرب بنظرات العين",
        "points": 25
      },
      {
        "text": "التعرق",
        "points": 15
      },
      {
        "text": "تناقض الكلام",
        "points": 15
      },
      {
        "text": "لغة الجسد",
        "points": 10
      }
    ]
  },
  {
    "question": "غرض يتم بيعه في المكتبة؟",
    "answers": [
      {
        "text": "أقلام",
        "points": 40
      },
      {
        "text": "دفاتر",
        "points": 25
      },
      {
        "text": "كتب",
        "points": 15
      },
      {
        "text": "شنط مدرسية",
        "points": 10
      },
      {
        "text": "ألوان",
        "points": 10
      }
    ]
  },
  {
    "question": "أكمل الفراغ في العبارة التي تقال دائماً في المناسبات: عقبال...",
    "answers": [
      {
        "text": "ما نفرح فيك / بعرسك",
        "points": 31
      },
      {
        "text": "التخرج / الوظيفة",
        "points": 22
      },
      {
        "text": "العيال / الذرية الصالحة",
        "points": 17
      },
      {
        "text": "المية سنة / العمر كله",
        "points": 13
      },
      {
        "text": "أعلى المراتب / المناصب",
        "points": 10
      },
      {
        "text": "ما نردها لك في الأفراح",
        "points": 7
      }
    ]
  },
  {
    "question": "جزء من الزي الرسمي للرجل السعودي؟",
    "answers": [
      {
        "text": "الشماغ / الغترة",
        "points": 40
      },
      {
        "text": "الثوب",
        "points": 30
      },
      {
        "text": "العقال",
        "points": 15
      },
      {
        "text": "الطاقية",
        "points": 10
      },
      {
        "text": "الكبك",
        "points": 5
      }
    ]
  },
  {
    "question": "مدينة سعودية تشتهر بأجوائها الباردة أو المعتدلة بالصيف؟",
    "answers": [
      {
        "text": "أبها",
        "points": 40
      },
      {
        "text": "الطائف",
        "points": 25
      },
      {
        "text": "الباحة",
        "points": 15
      },
      {
        "text": "النماص",
        "points": 10
      },
      {
        "text": "تبوك",
        "points": 10
      }
    ]
  },
  {
    "question": "إضافة أساسية تنحط مع القهوة السعودية؟",
    "answers": [
      {
        "text": "هيل",
        "points": 40
      },
      {
        "text": "زعفران",
        "points": 30
      },
      {
        "text": "مبيض / كوفي ميت",
        "points": 15
      },
      {
        "text": "قرنفل / مسمار",
        "points": 10
      },
      {
        "text": "زنجبيل",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء تشتريه من الصيدلية غير الأدوية؟",
    "answers": [
      {
        "text": "شامبو / صابون",
        "points": 40
      },
      {
        "text": "معجون أسنان",
        "points": 30
      },
      {
        "text": "قطن / مناديل",
        "points": 15
      },
      {
        "text": "مكياج / كريمات",
        "points": 10
      },
      {
        "text": "حلاوة مصاص",
        "points": 5
      }
    ]
  },
  {
    "question": "هدية متعارف عليها تنعطى للمولود الجديد؟",
    "answers": [
      {
        "text": "فلوس / عانية",
        "points": 40
      },
      {
        "text": "طقم ملابس أطفال",
        "points": 25
      },
      {
        "text": "ذهب / تعليقة",
        "points": 15
      },
      {
        "text": "سرير أو عربية طفل",
        "points": 10
      },
      {
        "text": "ألعاب",
        "points": 10
      }
    ]
  },
  {
    "question": "عذر غريب أو مضحك يقوله الطالب للمعلم عشان يطلع من الفصل؟",
    "answers": [
      {
        "text": "بروح الحمام",
        "points": 31
      },
      {
        "text": "بشرب مويه",
        "points": 22
      },
      {
        "text": "بطني يوجعني / بروح للمرشد",
        "points": 17
      },
      {
        "text": "بجيب دفتري من فصل ثاني",
        "points": 13
      },
      {
        "text": "أبوي ينتظرني برا",
        "points": 10
      },
      {
        "text": "بنظف ثوبي / نظارتي",
        "points": 7
      }
    ]
  },
  {
    "question": "مكان تروح له إذا بغيت تروق وتغير جو بعد أسبوع متعب؟",
    "answers": [
      {
        "text": "كوفي شوب",
        "points": 40
      },
      {
        "text": "البحر / الكورنيش",
        "points": 25
      },
      {
        "text": "البر / المخيم",
        "points": 15
      },
      {
        "text": "الشاليه / استراحة",
        "points": 10
      },
      {
        "text": "المطعم",
        "points": 10
      }
    ]
  },
  {
    "question": "اذكر شيئاً يُفتح ويُغلق؟",
    "answers": [
      {
        "text": "الباب",
        "points": 40
      },
      {
        "text": "النافذة / الدريشة",
        "points": 30
      },
      {
        "text": "الثلاجة",
        "points": 15
      },
      {
        "text": "العين",
        "points": 10
      },
      {
        "text": "الكتاب",
        "points": 5
      }
    ]
  },
  {
    "question": "جزء من جسم الإنسان ينمو فيه الشعر؟",
    "answers": [
      {
        "text": "الرأس",
        "points": 40
      },
      {
        "text": "اللحية / الشارب",
        "points": 30
      },
      {
        "text": "اليد",
        "points": 15
      },
      {
        "text": "الساق",
        "points": 10
      },
      {
        "text": "الحاجب",
        "points": 5
      }
    ]
  },
  {
    "question": "شيء يطلبه الأطفال دائماً أول ما يركبون السيارة؟",
    "answers": [
      {
        "text": "شغل أغاني / شيلات",
        "points": 31
      },
      {
        "text": "نبي بقالة / حلاوة",
        "points": 22
      },
      {
        "text": "عطني جوالك",
        "points": 17
      },
      {
        "text": "متى نوصل؟",
        "points": 13
      },
      {
        "text": "شغل المكيف",
        "points": 10
      },
      {
        "text": "أبي أقعد قدام",
        "points": 7
      }
    ]
  },
  {
    "question": "مهنة أو وظيفة تتطلب تركيزاً ودقة عالية جداً؟",
    "answers": [
      {
        "text": "طبيب جراح",
        "points": 40
      },
      {
        "text": "طيار",
        "points": 30
      },
      {
        "text": "مهندس",
        "points": 15
      },
      {
        "text": "مبرمج",
        "points": 10
      },
      {
        "text": "محاسب",
        "points": 5
      }
    ]
  },
  {
    "question": "مقاضي أساسية يكثر شراؤها قبل شهر رمضان بيومين؟",
    "answers": [
      {
        "text": "فيمتو / تانج",
        "points": 40
      },
      {
        "text": "شوفان / شوربة",
        "points": 25
      },
      {
        "text": "عجينة سمبوسة",
        "points": 15
      },
      {
        "text": "تمر",
        "points": 10
      },
      {
        "text": "زيت قلي",
        "points": 10
      }
    ]
  },
  {
    "question": "جهاز كهربائي موجود في كل مطبخ؟",
    "answers": [
      {
        "text": "ثلاجة",
        "points": 40
      },
      {
        "text": "فرن / مايكروويف",
        "points": 25
      },
      {
        "text": "خلاط",
        "points": 15
      },
      {
        "text": "غلاية موية",
        "points": 10
      },
      {
        "text": "عجانة",
        "points": 10
      }
    ]
  },
  {
    "question": "كلمة عامية تستخدمها لمدح شخص شهم أو فزع لك؟",
    "answers": [
      {
        "text": "كفو",
        "points": 40
      },
      {
        "text": "ذيب",
        "points": 25
      },
      {
        "text": "شنب",
        "points": 15
      },
      {
        "text": "بطل",
        "points": 10
      },
      {
        "text": "بيض الله وجهك",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء موجود على الطاولة في كل صالة أو مجلس بيت؟",
    "answers": [
      {
        "text": "دلة القهوة / الترامس",
        "points": 31
      },
      {
        "text": "تمر",
        "points": 22
      },
      {
        "text": "مبخرة / عود",
        "points": 17
      },
      {
        "text": "علبة مناديل",
        "points": 13
      },
      {
        "text": "ريموت التلفزيون",
        "points": 10
      },
      {
        "text": "حلاوة / مكسرات",
        "points": 7
      }
    ]
  },
  {
    "question": "شيء يطير في السماء غير الطائرة؟",
    "answers": [
      {
        "text": "العصفور / الطيور",
        "points": 40
      },
      {
        "text": "الهليكوبتر",
        "points": 25
      },
      {
        "text": "الطائرة الورقية",
        "points": 15
      },
      {
        "text": "المنطاد",
        "points": 10
      },
      {
        "text": "الصاروخ",
        "points": 10
      }
    ]
  },
  {
    "question": "تصريفة مشهورة عشان تقفل المكالمة؟",
    "answers": [
      {
        "text": "الخط يقطع / ما أسمعك",
        "points": 35
      },
      {
        "text": "وراي مشوار / بطلع",
        "points": 30
      },
      {
        "text": "أمي تناديني",
        "points": 15
      },
      {
        "text": "جوالي بيطفي شحن",
        "points": 10
      },
      {
        "text": "بدق عليك بعدين",
        "points": 10
      }
    ]
  },
  {
    "question": "أمنية يتمناها أي موظف في عمله؟",
    "answers": [
      {
        "text": "زيادة الراتب",
        "points": 40
      },
      {
        "text": "ترقية",
        "points": 25
      },
      {
        "text": "إجازة طويلة",
        "points": 15
      },
      {
        "text": "بونص / مكافأة",
        "points": 10
      },
      {
        "text": "مدير متفهم",
        "points": 10
      }
    ]
  },
  {
    "question": "غرض أساسي تأخذه معك في الكشتة أو المخيم؟",
    "answers": [
      {
        "text": "حطب / فحم",
        "points": 35
      },
      {
        "text": "دلال القهوة والشاي",
        "points": 25
      },
      {
        "text": "فرشة / رواق",
        "points": 20
      },
      {
        "text": "عزبة الطبخ",
        "points": 10
      },
      {
        "text": "كشاف / لمبات",
        "points": 10
      }
    ]
  },
  {
    "question": "مناسبة تلبس فيها المرأة ذهب ومجوهرات كثيرة؟",
    "answers": [
      {
        "text": "زواج / شبكة",
        "points": 40
      },
      {
        "text": "يوم العيد",
        "points": 25
      },
      {
        "text": "ليلة الحناء / الغمرة",
        "points": 15
      },
      {
        "text": "استقبال مولود",
        "points": 10
      },
      {
        "text": "عزيمة رسمية / كبيرة",
        "points": 10
      }
    ]
  },
  {
    "question": "شيء صوته مزعج جداً وتسمعه عادة في الصباح؟",
    "answers": [
      {
        "text": "منبه الجوال",
        "points": 31
      },
      {
        "text": "بوري السيارات",
        "points": 22
      },
      {
        "text": "عمال البناء / الحفريات",
        "points": 17
      },
      {
        "text": "دبابات / سيارات مسرعة",
        "points": 13
      },
      {
        "text": "بكاء طفل صغير",
        "points": 10
      },
      {
        "text": "قطط تتهاوش",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئاً يحتاج للغسيل والتنظيف باستمرار؟",
    "answers": [
      {
        "text": "الملابس",
        "points": 40
      },
      {
        "text": "الصحون / المواعين",
        "points": 30
      },
      {
        "text": "اليدين",
        "points": 15
      },
      {
        "text": "السيارة",
        "points": 10
      },
      {
        "text": "الأسنان",
        "points": 5
      }
    ]
  },
  {
    "question": "أول شيء تسويه أول ما تفتح عيونك من النوم؟",
    "answers": [
      {
        "text": "أشيك على الجوال",
        "points": 40
      },
      {
        "text": "أطفي المنبه",
        "points": 30
      },
      {
        "text": "أروح دورة المياه",
        "points": 15
      },
      {
        "text": "أشرب موية",
        "points": 10
      },
      {
        "text": "أتمغط",
        "points": 5
      }
    ]
  },
  {
    "question": "ما الشيء الذي لا تستطيع الاستغناء عنه؟",
    "answers": [
      {
        "text": "الهواء",
        "points": 31
      },
      {
        "text": "الماء",
        "points": 22
      },
      {
        "text": "الأكل",
        "points": 17
      },
      {
        "text": "المال",
        "points": 13
      },
      {
        "text": "الكهرباء",
        "points": 10
      },
      {
        "text": "المسكن",
        "points": 7
      }
    ]
  },
  {
    "question": "ما الأشياء الأساسية التي تأخذها معك في رحلة برية؟",
    "answers": [
      {
        "text": "ماء وأكل",
        "points": 31
      },
      {
        "text": "السيارة",
        "points": 22
      },
      {
        "text": "الفرشة والمراكي",
        "points": 17
      },
      {
        "text": "العزبة",
        "points": 13
      },
      {
        "text": "الحطب",
        "points": 10
      },
      {
        "text": "الإنارة",
        "points": 7
      }
    ]
  },
  {
    "question": "إذا صحيت من النوم وصار كل شيء ببلاش، وين تروح؟",
    "answers": [
      {
        "text": "السوق",
        "points": 31
      },
      {
        "text": "مكتب السفريات / المطار",
        "points": 22
      },
      {
        "text": "معارض السيارات",
        "points": 17
      },
      {
        "text": "العقارات",
        "points": 13
      },
      {
        "text": "البنك",
        "points": 10
      },
      {
        "text": "المطعم",
        "points": 7
      }
    ]
  },
  {
    "question": "لو كسبت جائزة مالية، على ماذا تنفقها؟",
    "answers": [
      {
        "text": "عائلتي",
        "points": 31
      },
      {
        "text": "شراء بيت",
        "points": 22
      },
      {
        "text": "السفر",
        "points": 17
      },
      {
        "text": "الصدقة",
        "points": 13
      },
      {
        "text": "سداد ديوني",
        "points": 10
      },
      {
        "text": "شراء سيارة جديدة",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر قوة خارقة تتمنى أن تحصل عليها؟",
    "answers": [
      {
        "text": "الطيران",
        "points": 31
      },
      {
        "text": "قراءة العقول",
        "points": 22
      },
      {
        "text": "الاختفاء",
        "points": 17
      },
      {
        "text": "القوة البدنية",
        "points": 13
      },
      {
        "text": "السرعة",
        "points": 10
      },
      {
        "text": "تحريك الأشياء دون لمسها",
        "points": 7
      }
    ]
  },
  {
    "question": "ما الشيء الذي يفعله الناس عادةً الساعة السابعة صباحًا؟",
    "answers": [
      {
        "text": "الذهاب إلى العمل",
        "points": 31
      },
      {
        "text": "تناول الفطور",
        "points": 22
      },
      {
        "text": "الاستحمام",
        "points": 17
      },
      {
        "text": "الرياضة / المشي",
        "points": 13
      },
      {
        "text": "تفريش الأسنان",
        "points": 10
      },
      {
        "text": "إطفاء المنبه",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا يحتفظ به الناس في مكان غير ظاهر في المنزل؟",
    "answers": [
      {
        "text": "المال",
        "points": 31
      },
      {
        "text": "المجوهرات",
        "points": 22
      },
      {
        "text": "الأوراق المهمة",
        "points": 17
      },
      {
        "text": "الأسلحة المصرّحة",
        "points": 13
      },
      {
        "text": "الملابس الداخلية",
        "points": 10
      },
      {
        "text": "الأكل",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا لا تود أن يحصل في أول يوم في الوظيفة؟",
    "answers": [
      {
        "text": "التأخير",
        "points": 31
      },
      {
        "text": "الإحراج",
        "points": 22
      },
      {
        "text": "عدم اكتمال المتطلبات",
        "points": 17
      },
      {
        "text": "اتساخ الملابس",
        "points": 13
      },
      {
        "text": "التشاجر",
        "points": 10
      },
      {
        "text": "الاضطرار للخروج",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا من الضروري أن يكون في سيارتك؟",
    "answers": [
      {
        "text": "الاستمارة",
        "points": 31
      },
      {
        "text": "طفاية الحريق",
        "points": 22
      },
      {
        "text": "العفريتة",
        "points": 17
      },
      {
        "text": "الاستبنة",
        "points": 13
      },
      {
        "text": "الماء",
        "points": 10
      },
      {
        "text": "الشاحن",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا تتوقع دائمًا أنك أضعته، وفي النهاية تجده تحتك؟",
    "answers": [
      {
        "text": "الريموت",
        "points": 31
      },
      {
        "text": "الجوال",
        "points": 22
      },
      {
        "text": "المفاتيح",
        "points": 17
      },
      {
        "text": "النظارة",
        "points": 13
      },
      {
        "text": "المحفظة / البوك",
        "points": 10
      },
      {
        "text": "الشاحن",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر نوعين من الحيوانات أو الحشرات المشهورة بعداوتها لبعض؟",
    "answers": [
      {
        "text": "القط والفأر",
        "points": 31
      },
      {
        "text": "الأسد والنمر",
        "points": 22
      },
      {
        "text": "القط والكلب",
        "points": 17
      },
      {
        "text": "الذئب والكلب",
        "points": 13
      },
      {
        "text": "الأسد والضبع",
        "points": 10
      },
      {
        "text": "النحل والدبور",
        "points": 7
      }
    ]
  },
  {
    "question": "ما الأشياء التي تسويها إذا كنت مبسوطًا ومروقًا على الآخر؟",
    "answers": [
      {
        "text": "الأكل والشرب",
        "points": 31
      },
      {
        "text": "الخروج",
        "points": 22
      },
      {
        "text": "الغناء / الرقص",
        "points": 17
      },
      {
        "text": "السوالف",
        "points": 13
      },
      {
        "text": "الضحك",
        "points": 10
      },
      {
        "text": "الطبخ",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا إذا تخلصت منه أصبحت سعيدًا؟",
    "answers": [
      {
        "text": "الدين",
        "points": 31
      },
      {
        "text": "المرض",
        "points": 22
      },
      {
        "text": "المشكلة",
        "points": 17
      },
      {
        "text": "الدوام",
        "points": 13
      },
      {
        "text": "النشبة / العلة",
        "points": 10
      },
      {
        "text": "الاختبار",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا يجعلك تشعر بالندم؟",
    "answers": [
      {
        "text": "الأخطاء",
        "points": 31
      },
      {
        "text": "جرح الآخرين",
        "points": 22
      },
      {
        "text": "الكذب",
        "points": 17
      },
      {
        "text": "التسرع",
        "points": 13
      },
      {
        "text": "العصبية",
        "points": 10
      },
      {
        "text": "الفشل",
        "points": 7
      }
    ]
  },
  {
    "question": "إذا قاد الإنسان السيارة بيد واحدة، ماذا يمكن أن يفعل باليد الثانية؟",
    "answers": [
      {
        "text": "استخدام الجوال",
        "points": 31
      },
      {
        "text": "تبديل القير",
        "points": 22
      },
      {
        "text": "الأكل أو الشرب",
        "points": 17
      },
      {
        "text": "تشغيل المكيف",
        "points": 13
      },
      {
        "text": "تشغيل المسجل",
        "points": 10
      },
      {
        "text": "فتح الزجاج",
        "points": 7
      }
    ]
  },
  {
    "question": "أعطني مثلًا معروفًا عن الصداقة؟",
    "answers": [
      {
        "text": "الصديق وقت الضيق",
        "points": 31
      },
      {
        "text": "الصاحب ساحب",
        "points": 22
      },
      {
        "text": "اختر الصديق قبل الطريق",
        "points": 17
      },
      {
        "text": "احذر عدوك مرة واحذر صديقك ألف مرة",
        "points": 13
      },
      {
        "text": "رُبّ أخٍ لم تلده أمك",
        "points": 10
      },
      {
        "text": "صاحب صديقًا صدوقًا في صدقه",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شيئًا يبذل الإنسان مجهودًا حتى يحافظ عليه؟",
    "answers": [
      {
        "text": "الصحة",
        "points": 31
      },
      {
        "text": "العائلة",
        "points": 22
      },
      {
        "text": "المال",
        "points": 17
      },
      {
        "text": "العمل",
        "points": 13
      },
      {
        "text": "الحب",
        "points": 10
      },
      {
        "text": "الوزن",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر صفة مشتركة بين رجال العرب؟",
    "answers": [
      {
        "text": "الكرم",
        "points": 31
      },
      {
        "text": "الشهامة",
        "points": 22
      },
      {
        "text": "الرجولة",
        "points": 17
      },
      {
        "text": "القوة",
        "points": 13
      },
      {
        "text": "العصبية",
        "points": 10
      },
      {
        "text": "الغيرة",
        "points": 7
      }
    ]
  },
  {
    "question": "ما أكثر شيء مستعد أن تصرف عليه فلوسك؟",
    "answers": [
      {
        "text": "البيت",
        "points": 31
      },
      {
        "text": "السيارة",
        "points": 22
      },
      {
        "text": "الزواج / الزوجة",
        "points": 17
      },
      {
        "text": "الترفيه",
        "points": 13
      },
      {
        "text": "الأكل",
        "points": 10
      },
      {
        "text": "الأجهزة الإلكترونية",
        "points": 7
      }
    ]
  },
  {
    "question": "اذكر شخصًا من الغريب أو غير اللائق أن تمزح معه؟",
    "answers": [
      {
        "text": "المدير",
        "points": 31
      },
      {
        "text": "كبير السن",
        "points": 22
      },
      {
        "text": "الوالدان / الأهل",
        "points": 17
      },
      {
        "text": "شخص غريب",
        "points": 13
      },
      {
        "text": "المريض",
        "points": 10
      },
      {
        "text": "الشرطي",
        "points": 7
      }
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

      const bundle = normalizeIncomingQuestionBundle(body);
      if (bundle) {
        syncQuestionBundleIntoCurrentRound(state, bundle);
      }

      state.game.showQuestion = body.visible;
      return { ok: true };
    }

    case "init":
    case "init_question_bundle": {
      return initializeGameState(state, body);
    }

    case "start_session": {
      return startGameSession(state, body);
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
    case "next_question_bundle":
    case "next_random_question": {
      return applyNextQuestionBundle(state, body);
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
      syncIncomingQuestionBundleIfPresent(state, body);

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
      syncIncomingQuestionBundleIfPresent(state, body);

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
      syncIncomingQuestionBundleIfPresent(state, body);

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
      syncIncomingQuestionBundleIfPresent(state, body);

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
      syncIncomingQuestionBundleIfPresent(state, body);

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
      syncIncomingQuestionBundleIfPresent(state, body);

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

function syncIncomingQuestionBundleIfPresent(state, body = {}) {
  const bundle = normalizeIncomingQuestionBundle(body);

  if (!bundle) {
    return null;
  }

  syncQuestionBundleIntoCurrentRound(state, bundle);
  return bundle;
}

function createShuffledQuestionOrder(totalQuestions, avoidFirstIndex = -1) {
  const total = Math.max(1, normalizeNumber(totalQuestions, QUESTIONS.length));
  const order = Array.from({ length: total }, (_, index) => index);

  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const rawAvoid = Number(avoidFirstIndex);
  const hasAvoid = Number.isInteger(rawAvoid) && rawAvoid >= 0 && rawAvoid < total;
  if (hasAvoid && total > 1 && order[0] === rawAvoid) {
    const swapIndex = 1 + Math.floor(Math.random() * (total - 1));
    [order[0], order[swapIndex]] = [order[swapIndex], order[0]];
  }

  return order;
}

function normalizeQuestionOrder(value, totalQuestions = QUESTIONS.length) {
  const total = Math.max(1, normalizeNumber(totalQuestions, QUESTIONS.length));
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const order = [];

  for (const raw of source) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= total || seen.has(index)) continue;
    seen.add(index);
    order.push(index);
  }

  return order;
}

function ensureQuestionCycleState(game, totalQuestions = QUESTIONS.length) {
  const total = Math.max(1, normalizeNumber(totalQuestions, QUESTIONS.length));
  let order = normalizeQuestionOrder(game.questionOrder, total);
  let cursor = Number.isInteger(Number(game.questionCursor))
    ? Math.floor(Number(game.questionCursor))
    : -1;

  if (!order.length) {
    order = createShuffledQuestionOrder(total);
    cursor = -1;
  }

  const present = new Set(order);
  const missing = [];
  for (let index = 0; index < total; index += 1) {
    if (!present.has(index)) missing.push(index);
  }

  if (missing.length) {
    const shuffledMissing = createShuffledQuestionOrder(missing.length).map((position) => missing[position]);
    order.push(...shuffledMissing);
  }

  cursor = Math.max(-1, Math.min(cursor, order.length - 1));

  game.questionOrder = order;
  game.questionCursor = cursor;
  game.questionCycle = Math.max(1, normalizeNumber(game.questionCycle, 1));
  game.totalQuestions = total;

  return { order, cursor, total };
}

function migrateQuestionCycle(storedGame, currentQuestionIndex, totalQuestions = QUESTIONS.length) {
  const total = Math.max(1, normalizeNumber(totalQuestions, QUESTIONS.length));
  let order = normalizeQuestionOrder(storedGame?.questionOrder, total);
  let cursor = Number.isInteger(Number(storedGame?.questionCursor))
    ? Math.floor(Number(storedGame.questionCursor))
    : -1;

  if (!order.length) {
    const current = normalizeQuestionIndex(currentQuestionIndex, total);
    const remaining = [];
    for (let index = 0; index < total; index += 1) {
      if (index !== current) remaining.push(index);
    }
    const shuffledRemaining = remaining.length
      ? createShuffledQuestionOrder(remaining.length).map((position) => remaining[position])
      : [];
    order = [current, ...shuffledRemaining];
    cursor = 0;
  } else {
    const present = new Set(order);
    const missing = [];
    for (let index = 0; index < total; index += 1) {
      if (!present.has(index)) missing.push(index);
    }
    if (missing.length) {
      const shuffledMissing = createShuffledQuestionOrder(missing.length).map((position) => missing[position]);
      order.push(...shuffledMissing);
    }

    cursor = Math.max(-1, Math.min(cursor, order.length - 1));
    const current = normalizeQuestionIndex(currentQuestionIndex, total);
    const currentPosition = order.indexOf(current);
    if (currentPosition >= 0 && cursor < 0) cursor = currentPosition;
  }

  return {
    order,
    cursor,
    cycle: Math.max(1, normalizeNumber(storedGame?.questionCycle, 1))
  };
}

function takeNextRandomQuestionIndex(state) {
  const cycle = ensureQuestionCycleState(state.game, QUESTIONS.length);
  let nextCursor = cycle.cursor + 1;

  if (nextCursor >= cycle.order.length) {
    state.game.questionOrder = createShuffledQuestionOrder(
      cycle.total,
      state.game.currentQuestionIndex
    );
    state.game.questionCursor = -1;
    state.game.questionCycle = Math.max(1, normalizeNumber(state.game.questionCycle, 1)) + 1;
    nextCursor = 0;
  }

  state.game.questionCursor = nextCursor;
  return state.game.questionOrder[nextCursor];
}

function advanceToNextRandomQuestion(state, options = {}) {
  const nextIndex = takeNextRandomQuestionIndex(state);
  loadQuestionIntoRound(state, nextIndex, options);
  return nextIndex;
}

function markExplicitQuestionAsUsed(state, questionIndex, totalQuestions = QUESTIONS.length) {
  const cycle = ensureQuestionCycleState(state.game, totalQuestions);
  const index = normalizeQuestionIndex(questionIndex, cycle.total);

  if (cycle.cursor >= 0 && cycle.order[cycle.cursor] === index) return;

  const existingPosition = cycle.order.indexOf(index);
  if (existingPosition >= 0) {
    cycle.order.splice(existingPosition, 1);
  }

  const insertAt = Math.min(cycle.cursor + 1, cycle.order.length);
  cycle.order.splice(insertAt, 0, index);
  state.game.questionOrder = cycle.order;
  state.game.questionCursor = insertAt;
}

function startGameSession(state, body = {}) {
  advanceToNextRandomQuestion(state, { preserveScores: false, preserveNames: false });

  state.game.team1Name = normalizeTeamLabel(body.team1Name || state.game.team1Name || "الفريق الأول");
  state.game.team2Name = normalizeTeamLabel(body.team2Name || state.game.team2Name || "الفريق الثاني");
  state.game.team1Score = 0;
  state.game.team2Score = 0;
  state.game.team1Strikes = 0;
  state.game.team2Strikes = 0;
  state.game.displayErrorSeq = 0;
  state.game.displayErrorReason = "";
  state.game.roundClosedAfterSteal = false;
  state.enabled = true;
  state.firstBuzz = null;

  return { ok: true };
}

function applyNextQuestionBundle(state, body = {}) {
  const bundle = normalizeIncomingQuestionBundle(body);

  if (bundle) {
    markExplicitQuestionAsUsed(state, bundle.questionIndex, bundle.totalQuestions);
    loadIncomingQuestionBundleIntoRound(state, bundle, { preserveScores: true, preserveNames: true });
  } else {
    advanceToNextRandomQuestion(state, { preserveScores: true, preserveNames: true });
  }

  state.game.showQuestion = false;
  state.game.displayErrorReason = "";
  state.game.roundClosedAfterSteal = false;
  state.enabled = true;
  state.firstBuzz = null;
  return { ok: true };
}

function initializeGameState(state, body = {}) {
  const bundle = normalizeIncomingQuestionBundle(body);

  if (bundle) {
    markExplicitQuestionAsUsed(state, bundle.questionIndex, bundle.totalQuestions);
    loadIncomingQuestionBundleIntoRound(state, bundle, { preserveScores: false, preserveNames: false });
  } else {
    const questionIndex = normalizeQuestionIndex(body.questionIndex ?? state.game.currentQuestionIndex);
    markExplicitQuestionAsUsed(state, questionIndex, QUESTIONS.length);
    loadQuestionIntoRound(state, questionIndex, { preserveScores: false, preserveNames: false });
  }

  state.game.team1Name = normalizeTeamLabel(body.team1Name || state.game.team1Name || "الفريق الأول");
  state.game.team2Name = normalizeTeamLabel(body.team2Name || state.game.team2Name || "الفريق الثاني");
  state.game.team1Score = 0;
  state.game.team2Score = 0;
  state.game.team1Strikes = 0;
  state.game.team2Strikes = 0;
  state.game.displayErrorSeq = 0;
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

function loadIncomingQuestionBundleIntoRound(state, bundle, options = {}) {
  const preserveScores = !!options.preserveScores;
  const preserveNames = !!options.preserveNames;

  const team1Name = preserveNames ? state.game.team1Name : "الفريق الأول";
  const team2Name = preserveNames ? state.game.team2Name : "الفريق الثاني";
  const team1Score = preserveScores ? state.game.team1Score : 0;
  const team2Score = preserveScores ? state.game.team2Score : 0;

  state.game.currentQuestionIndex = bundle.questionIndex;
  state.game.totalQuestions = bundle.totalQuestions;
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
  state.game.questionText = bundle.questionText;
  state.game.answers = cloneBundleAnswers(bundle.answers, false);
  state.game.roundPoints = 0;
  state.game.roundClosedAfterSteal = false;
  state.game.displayErrorReason = "";

  state.enabled = true;
  state.firstBuzz = null;
}

function syncQuestionBundleIntoCurrentRound(state, bundle) {
  const sameQuestion =
    normalizeNumber(state.game.currentQuestionIndex, 0) === bundle.questionIndex;

  const existingAnswers = Array.isArray(state.game.answers) ? state.game.answers : [];

  state.game.currentQuestionIndex = bundle.questionIndex;
  state.game.totalQuestions = bundle.totalQuestions;
  state.game.questionText = bundle.questionText;
  state.game.answers = bundle.answers.map((answer, index) => ({
    text: answer.text,
    points: answer.points,
    revealed: sameQuestion ? !!existingAnswers[index]?.revealed : false
  }));

  if (!sameQuestion) {
    state.game.phase = "idle";
    state.game.currentTurnTeam = "";
    state.game.confrontationWinner = "";
    state.game.stealingTeam = "";
    state.game.needsDuelChoice = false;
    state.game.team1Strikes = 0;
    state.game.team2Strikes = 0;
    state.game.roundPoints = 0;
    state.game.roundClosedAfterSteal = false;
    state.game.displayErrorReason = "";
    state.enabled = true;
    state.firstBuzz = null;
  }

  updateRoundPoints(state);
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
  const questionOrder = createShuffledQuestionOrder(QUESTIONS.length);

  return {
    currentQuestionIndex: 0,
    totalQuestions: QUESTIONS.length,
    questionOrder,
    questionCursor: -1,
    questionCycle: 1,
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

  const storedTotalQuestions = QUESTIONS.length;
  const currentQuestionIndex = normalizeQuestionIndex(
    stored?.game?.currentQuestionIndex ?? base.game.currentQuestionIndex,
    storedTotalQuestions
  );
  const snapshot = createQuestionSnapshot(currentQuestionIndex);
  const migratedQuestionCycle = migrateQuestionCycle(
    stored?.game,
    currentQuestionIndex,
    storedTotalQuestions
  );

  const game = {
    ...base.game,
    currentQuestionIndex,
    totalQuestions: storedTotalQuestions,
    questionOrder: migratedQuestionCycle.order,
    questionCursor: migratedQuestionCycle.cursor,
    questionCycle: migratedQuestionCycle.cycle,
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
      questionSequenceNumber: Math.max(1, normalizeNumber(state.game.questionCursor, 0) + 1),
      questionCycle: Math.max(1, normalizeNumber(state.game.questionCycle, 1)),
      remainingQuestions: Math.max(
        0,
        normalizeNumber(state.game.totalQuestions, QUESTIONS.length) -
          Math.max(0, normalizeNumber(state.game.questionCursor, -1) + 1)
      ),
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

function normalizeQuestionIndex(value, totalQuestions = QUESTIONS.length) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;

  const total = normalizeTotalQuestions(totalQuestions, QUESTIONS.length);
  if (total <= 0) return 0;
  if (n < 0) return 0;
  if (n >= total) return n % total;
  return n;
}

function normalizeTotalQuestions(value, fallback = QUESTIONS.length) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;

  const f = Number(fallback);
  if (Number.isInteger(f) && f > 0) return f;

  return Math.max(1, QUESTIONS.length || 1);
}

function normalizeIncomingQuestionBundle(body) {
  if (!body || typeof body !== "object") return null;

  const source = body.question && typeof body.question === "object" ? body.question : body;
  const rawQuestionText = source.question ?? source.questionText ?? body.questionText;
  const questionText = normalizeQuestionText(rawQuestionText);
  const rawAnswers = Array.isArray(source.answers)
    ? source.answers
    : Array.isArray(body.answers)
      ? body.answers
      : [];

  if (!questionText || !rawAnswers.length) return null;

  const answers = Array.from({ length: 6 }, (_, index) => {
    const answer = rawAnswers[index] || { text: "", points: 0 };
    return {
      text: normalizeAnswerText(answer.text),
      points: Math.max(0, normalizeNumber(answer.points, 0)),
      revealed: false
    };
  });

  if (!answers.some((answer) => answer.text)) return null;

  const rawIndex = Number(body.questionIndex);
  const fallbackTotal = Number.isInteger(rawIndex) && rawIndex >= 0
    ? Math.max(QUESTIONS.length, rawIndex + 1)
    : QUESTIONS.length;
  const totalQuestions = normalizeTotalQuestions(body.totalQuestions, fallbackTotal);
  const questionIndex = normalizeQuestionIndex(body.questionIndex, totalQuestions);

  return {
    questionIndex,
    totalQuestions,
    questionText,
    answers
  };
}

function cloneBundleAnswers(answers, revealed = false) {
  return Array.from({ length: 6 }, (_, index) => {
    const answer = Array.isArray(answers) ? answers[index] : null;
    return {
      text: normalizeAnswerText(answer?.text),
      points: Math.max(0, normalizeNumber(answer?.points, 0)),
      revealed: !!revealed
    };
  });
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
