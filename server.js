import cron from "node-cron";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5005;

app.set("trust proxy", 1);
app.disable("x-powered-by");

// Response compression (speed). Package install na ho to server
// normal chalta rahega, sirf compression band rahega.
// Install: npm i compression
try {
  const { default: compression } = await import("compression");

  app.use(compression());

  console.log("Response compression active");
} catch {
  console.log("'compression' package not installed (npm i compression)");
}

app.use(express.json({ limit: "1mb" }));

// ==================================================
// ENVIRONMENT VALIDATION
// ==================================================

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "JWT_SECRET",
];

const missingEnv = requiredEnv.filter(
  (key) => !process.env[key]?.trim()
);

if (missingEnv.length) {
  console.error("Missing environment variables:", missingEnv);
  process.exit(1);
}


// ==================================================
// CORS
// ==================================================


const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
  "http://10.156.248.201:3001",

  // Admin panel
  "https://bgmi-admin-panel-9eei.onrender.com",

  // Cloudflare BGMI Admin Panel
  "https://bgmi-admin-panel.aradhyasingh-73728.workers.dev",


 
  // Cloudflare BGMI frontend
"https://bgmi-esports.aradhyasingh-73728.workers.dev",

// New BGMI tournament frontend
"https://bgmi.tournament-esports.workers.dev",

  ...(process.env.EXTRA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
];


app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.error("Blocked CORS origin:", origin);

      const error = new Error("Origin not allowed by CORS.");
      error.statusCode = 403;
      return callback(error);
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: ["Content-Type", "Authorization"],

    optionsSuccessStatus: 204,
  })
);


// ==================================================
// SUPABASE
// ==================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const TABLE = "create_tournament";
const JOIN_TABLE = "tournament_joins";
const RESULT_TABLE = "tournament_results";

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// ==================================================
// SHORT PUBLIC CACHE
// Public lists ko har request par DB se nahi banate.
// Ek hi time par aayi bahut si requests ek hi query share karti hain.
// Admin koi bhi badlav kare to cache turant saaf ho jata hai.
// ==================================================

const PUBLIC_CACHE_MS = 5000;
const HISTORY_CACHE_MS = 10000;

const publicCache = new Map(); // key -> { promise, expiresAt }

function cachedResponse(key, ttlMs, producer) {
  const now = Date.now();
  const hit = publicCache.get(key);

  if (hit && hit.expiresAt > now) {
    return hit.promise;
  }

  const promise = producer().catch((error) => {
    publicCache.delete(key);
    throw error;
  });

  publicCache.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });

  return promise;
}

const clearPublicCache = () => publicCache.clear();

// Admin ka koi bhi POST/PUT/PATCH/DELETE ke baad public cache saaf
app.use("/api/admin", (req, res, next) => {
  if (req.method !== "GET") {
    res.on("finish", clearPublicCache);
  }

  next();
});

function throwDatabaseError(error, message = "Database operation failed.") {
  console.error(message, error);

  const wrapped = new Error(message);
  wrapped.statusCode = 500;

  throw wrapped;
}

// ==================================================
// ADMIN AUTHENTICATION
// ==================================================

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Admin token missing. Please login again.",
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Admin token missing. Please login again.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    if (decoded.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Admin access required.",
      });
    }

    req.admin = decoded;
    next();
    } catch (error) {
    console.error("ADMIN JWT VERIFICATION FAILED:", {
      name: error.name,
      message: error.message,
    });

    return res.status(401).json({
      success: false,
      error: "Invalid or expired admin token.",
    });
  }
}

// ==================================================
// HELPERS
// ==================================================

const cleanText = (value) =>
  typeof value === "string" ? value.trim() : "";

function getIndiaDate() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getTomorrowIndiaDate() {
  const today = getIndiaDate();
  const date = new Date(`${today}T00:00:00.000Z`);

  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString().slice(0, 10);
}

const validStatuses = [
  "Draft",
  "Upcoming",
  "Live",
  "Completed",
  "Cancelled",
];

const editableStatuses = [
  "Draft",
  "Upcoming",
  "Live",
  "Cancelled",
];

const statusMap = {
  draft: "Draft",
  upcoming: "Upcoming",
  live: "Live",
  completed: "Completed",
  cancelled: "Cancelled",
};

function normalizeStatus(value, fallback = "Draft") {
  const key = cleanText(value).toLowerCase();

  return statusMap[key] || fallback;
}

function normalizeTournamentId(value) {
  return cleanText(value).toUpperCase();
}

function normalizeTime(value) {
  const time = cleanText(value);

  if (!time) {
    throw new Error("Tournament time is required.");
  }

  let hours;
  let minutes;
  let seconds = 0;

  if (/^\d{2}:\d{2}$/.test(time)) {
    [hours, minutes] = time.split(":").map(Number);
  } else if (/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    [hours, minutes, seconds] = time.split(":").map(Number);
  } else {
    throw new Error("Invalid time. Use HH:MM format.");
  }

  if (
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    throw new Error("Invalid time value.");
  }

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

function normalizeDate(value) {
  const date = cleanText(value);

  if (!date) {
    throw new Error("Tournament date is required.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid date. Use YYYY-MM-DD format.");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Invalid calendar date.");
  }

  return date;
}

function createMatchKey(tournamentId, date, time) {
  const id = normalizeTournamentId(tournamentId);

  if (!id) {
    throw new Error("Tournament ID is required.");
  }

  return `${id}|${normalizeDate(date)}|${normalizeTime(time)}`;
}

function getTournamentMatchKey(tournament) {
  return createMatchKey(
    tournament.tournament_id,
    tournament.date,
    tournament.time
  );
}

// List banate waqt ek kharab row poori list na tod de
function safeMatchKey(tournament) {
  try {
    return getTournamentMatchKey(tournament);
  } catch {
    return null;
  }
}

function numberValue(value, field, minimum = 0, integer = false) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    throw new Error(`${field} is required.`);
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < minimum ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(
      `${field} must be a valid ${integer ? "whole " : ""}number greater than or equal to ${minimum}.`
    );
  }

  return number;
}

function sendDatabaseError(
  res,
  error,
  message = "Database operation failed."
) {
  console.error(message, error);

  return res.status(500).json({
    success: false,
    error: message,
  });
}

function normalizePayload(body = {}, existing = {}) {
  const name = cleanText(
    body.name ??
    body.tournament_name ??
    existing.tournament_name
  );

  if (!name) {
    throw new Error("Tournament name is required.");
  }

  const status = normalizeStatus(
    body.tournament_status ??
    body.status ??
    existing.tournament_status ??
    "Draft"
  );

  if (!validStatuses.includes(status)) {
    throw new Error("Invalid tournament status.");
  }

  const published =
    typeof body.published === "boolean"
      ? body.published
      : typeof existing.published === "boolean"
        ? existing.published
        : false;

  const date = normalizeDate(
    body.date ?? existing.date
  );

  const time = normalizeTime(
    body.time ?? existing.time
  );

  const slots = numberValue(
    body.totalSlots ??
    body.slots ??
    existing.slots ??
    50,
    "Total slots",
    1,
    true
  );

  return {
    tournament_name: name,

    game_mode:
      cleanText(
        body.mode ??
        body.game_mode ??
        existing.game_mode
      ) || "Solo",

    match_type:
      cleanText(
        body.type ??
        body.match_type ??
        existing.match_type
      ) || "Classic",

    map:
      cleanText(body.map ?? existing.map) ||
      "Erangel",

    date,
    time,

    entry_fee: numberValue(
      body.entryFee ??
      body.entry_fee ??
      existing.entry_fee ??
      0,
      "Entry fee"
    ),

    prize_pool: numberValue(
      body.prizePool ??
      body.prize_pool ??
      existing.prize_pool ??
      0,
      "Prize pool"
    ),

    per_kill: numberValue(
      body.perKill ??
      body.per_kill ??
      existing.per_kill ??
      0,
      "Per kill"
    ),

    slots,

    rules: cleanText(
      body.description ??
      body.rules ??
      existing.rules
    ),

    image_url:
      cleanText(
        body.image ??
        body.image_url ??
        existing.image_url
      ) || null,

    published:
      status === "Cancelled" ||
      status === "Completed" ||
      status === "Live"
        ? false
        : published,

    tournament_status: status,

    status:
      status === "Cancelled"
        ? "cancelled"
        : status === "Completed"
          ? "completed"
          : status === "Live"
            ? "published"
            : published
              ? "published"
              : "draft",

    updated_at: new Date().toISOString(),
  };
}

function toClientTournament(row, joinedPlayers = 0) {
  return {
    id: row.tournament_id,
    tournament_id: row.tournament_id,

    name: row.tournament_name,
    tournament_name: row.tournament_name,

    mode: row.game_mode,
    game_mode: row.game_mode,

    type: row.match_type,
    match_type: row.match_type,

    map: row.map,
    date: row.date,
    time: row.time,

    entryFee: Number(row.entry_fee || 0),
    entry_fee: Number(row.entry_fee || 0),

    prizePool: Number(row.prize_pool || 0),
    prize_pool: Number(row.prize_pool || 0),

    perKill: Number(row.per_kill || 0),
    per_kill: Number(row.per_kill || 0),

    totalSlots: Number(row.slots || 50),
    slots: Number(row.slots || 50),

    joinedPlayers,
    registered: joinedPlayers,

    description: row.rules || "",
    rules: row.rules || "",

    image: row.image_url || "",
    image_url: row.image_url || "",

    published: Boolean(row.published),
    is_visible:
      Boolean(row.published) &&
      !Boolean(row.is_hidden),

    is_hidden: Boolean(row.is_hidden),

    status: row.tournament_status || "Draft",
    tournament_status: row.tournament_status || "Draft",

    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ==================================================
// DATABASE HELPERS
// ==================================================

async function getTournament(tournamentId) {
  const id = normalizeTournamentId(tournamentId);

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("tournament_id", id)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function getJoinedCount(tournamentId, matchKey) {
  const { count, error } = await supabase
    .from(JOIN_TABLE)
    .select("id", {
      count: "exact",
      head: true,
    })
    .eq("tournament_id", tournamentId)
    .eq("match_key", matchKey);

  if (error) throw error;

  return count || 0;
}

async function getTournamentPlayers(tournamentId, matchKey) {
  const { data, error } = await supabase
    .from(JOIN_TABLE)
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("match_key", matchKey)
    .order("id", { ascending: true });

  if (error) throw error;

  return data || [];
}

async function getTournamentResults(tournamentId, matchKey) {
  const { data, error } = await supabase
    .from(RESULT_TABLE)
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("match_key", matchKey);

  if (error) throw error;

  return data || [];
}

// --------------------------------------------------
// BATCH HELPERS (ek-ek tournament ke liye alag query nahi)
// --------------------------------------------------

const BATCH_CHUNK = 100;

function chunkArray(items, size = BATCH_CHUNK) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

// Supabase ek query me max ~1000 rows deta hai, isliye pages me padho
async function fetchAllPages(buildQuery, pageSize = 1000) {
  const all = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(
      from,
      from + pageSize - 1
    );

    if (error) throw error;

    all.push(...(data || []));

    if (!data || data.length < pageSize) break;
  }

  return all;
}

async function fetchJoinsForKeys(keys, columns) {
  if (!keys.length) return [];

  const parts = await Promise.all(
    chunkArray(keys).map((keyChunk) =>
      fetchAllPages(() =>
        supabase
          .from(JOIN_TABLE)
          .select(columns)
          .in("match_key", keyChunk)
          .order("id", { ascending: true })
      )
    )
  );

  return parts.flat();
}

async function fetchResultsForKeys(keys, columns) {
  if (!keys.length) return [];

  const parts = await Promise.all(
    chunkArray(keys).map((keyChunk) =>
      fetchAllPages(() =>
        supabase
          .from(RESULT_TABLE)
          .select(columns)
          .in("match_key", keyChunk)
          .order("id", { ascending: true })
      )
    )
  );

  return parts.flat();
}

async function getTournamentsByIds(tournamentIds) {
  const map = new Map();

  if (!tournamentIds.length) return map;

  const parts = await Promise.all(
    chunkArray(tournamentIds).map(async (idChunk) => {
      const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .in("tournament_id", idChunk);

      if (error) throw error;

      return data || [];
    })
  );

  parts.flat().forEach((tournament) => {
    map.set(tournament.tournament_id, tournament);
  });

  return map;
}

let countsRpcWarned = false;

// Saare match_keys ke joined counts ek hi query me.
// SQL function tournament_match_counts use hota hai; na ho to
// fallback me sirf match_key column padh ke count karta hai.
async function getJoinedCountsMap(keys) {
  const counts = new Map();

  if (!keys.length) return counts;

  const { data, error } = await supabase.rpc(
    "tournament_match_counts",
    { p_keys: keys }
  );

  if (!error && Array.isArray(data)) {
    data.forEach((row) => {
      counts.set(row.match_key, Number(row.total || 0));
    });

    return counts;
  }

  if (!countsRpcWarned) {
    countsRpcWarned = true;

    console.warn(
      "tournament_match_counts RPC unavailable, using fallback count:",
      error?.message
    );
  }

  const rows = await fetchJoinsForKeys(keys, "match_key");

  rows.forEach((row) => {
    counts.set(row.match_key, (counts.get(row.match_key) || 0) + 1);
  });

  return counts;
}

async function attachCounts(rows, includePlayers = false) {
  const keyed = rows.map((row) => ({
    row,
    key: safeMatchKey(row),
  }));

  const keys = [
    ...new Set(keyed.map((item) => item.key).filter(Boolean)),
  ];

  // Admin API ke liye joined players ki details (ek hi query me sabki)
  if (includePlayers) {
    const joins = await fetchJoinsForKeys(
      keys,
      "id, tournament_id, match_key, player_name, bgmi_id, profile_id"
    );

    const joinsByKey = new Map();

    joins.forEach((join) => {
      if (!joinsByKey.has(join.match_key)) {
        joinsByKey.set(join.match_key, []);
      }

      joinsByKey.get(join.match_key).push(join);
    });

    return keyed.map(({ row, key }) => {
      const players = (key && joinsByKey.get(key)) || [];

      return {
        ...toClientTournament(row, players.length),

        joinedPlayersList: players.map((player) => ({
          join_id: player.id,
          bgmi_name: player.player_name || "",
          bgmi_id: player.bgmi_id || "",
          profile_id: player.profile_id || "",
        })),
      };
    });
  }

  // Public API: player details nahi bhejni, sirf count
  const counts = await getJoinedCountsMap(keys);

  return keyed.map(({ row, key }) =>
    toClientTournament(row, key ? counts.get(key) || 0 : 0)
  );
}

function makePlayerResult(join, result = null) {
  return {
    join_id: join.id,
    tournament_id: join.tournament_id,

    player_name: join.player_name || "",
    bgmi_id: join.bgmi_id || "",
    profile_name: join.profile_name || "",
    profile_id: join.profile_id || "",

    kills: Number(result?.kills || 0),
    rank_position: result?.rank_position ?? null,
    points: Number(result?.points || 0),

    is_winner: Boolean(result?.is_winner),
    winner_prize: Number(result?.winner_prize || 0),

    per_kill: Number(result?.per_kill || 0),
    kill_amount: Number(result?.kill_amount || 0),
    total_winning: Number(result?.total_winning || 0),

    status: result?.status || "not_saved",
    paid_at: result?.paid_at || null,
  };
}

function ensureEditableTournament(tournament) {
  if (
    tournament.tournament_status === "Completed" ||
    tournament.tournament_status === "Cancelled"
  ) {
    const error = new Error(
      "This tournament can no longer be modified."
    );

    error.statusCode = 409;
    throw error;
  }
}

function ensureResultIdentity(player, result) {
  return Boolean(
    player &&
    result &&
    result.profile_id &&
    result.profile_id === player.profile_id &&
    result.tournament_id === player.tournament_id &&
    result.match_key
  );
}

function sortLeaderboard(players) {
  return [...players].sort((a, b) => {
    const rankA = a.rank_position ?? 999999;
    const rankB = b.rank_position ?? 999999;

    if (rankA !== rankB) {
      return rankA - rankB;
    }

    return b.kills - a.kills;
  });
}

function groupBy(items, keyFn) {
  const map = new Map();

  items.forEach((item) => {
    const key = keyFn(item);

    if (!map.has(key)) map.set(key, []);

    map.get(key).push(item);
  });

  return map;
}

// ==================================================
// HEALTH
// ==================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "BGMI Tournament Management Server running",
    port: PORT,
  });
});

app.get(
  "/api/test-supabase",
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from(TABLE)
      .select("tournament_id")
      .limit(1);

    if (error) {
      return sendDatabaseError(res, error);
    }

    res.json({
      success: true,
      message: "Supabase connected successfully",
      table: TABLE,
    });
  })
);

// ==================================================
// ADMIN: GET ALL TOURNAMENTS
// ?players=0  => joinedPlayersList nahi bhejta (bahut tez + chhota response)
// ==================================================

app.get(
  "/api/admin/tournaments",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const includePlayers = req.query.players !== "0";

    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return sendDatabaseError(res, error);
    }

    res.json({
      success: true,
      tournaments: await attachCounts(data || [], includePlayers),
    });
  })
);

// ==================================================
// ADMIN: GET DAILY REPEAT STATUS
// ==================================================

app.get(
  "/api/admin/daily-repeat",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("daily_tournament_rules")
      .select("source_tournament_id, active, next_run_date")
      .order("created_at", { ascending: false });

    if (error) {
      return sendDatabaseError(
        res,
        error,
        "Daily repeat status load failed."
      );
    }

    res.json({
      success: true,
      rules: data || [],
    });
  })
);

// ==================================================
// ADMIN: GET SINGLE TOURNAMENT
// ==================================================

app.get(
  "/api/admin/tournaments/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    const count = await getJoinedCount(
      tournament.tournament_id,
      matchKey
    );

    res.json({
      success: true,
      tournament: toClientTournament(tournament, count),
    });
  })
);

// ==================================================
// ADMIN: CREATE TOURNAMENT
// ==================================================

app.post(
  "/api/admin/tournaments",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = normalizeTournamentId(
      req.body.id ?? req.body.tournament_id
    );

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Tournament ID is required.",
      });
    }

    let payload;

    try {
      payload = normalizePayload(req.body);
      createMatchKey(id, payload.date, payload.time);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        tournament_id: id,
        ...payload,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          error: "This tournament ID already exists.",
        });
      }

      return sendDatabaseError(res, error);
    }

    res.status(201).json({
      success: true,
      message: "Tournament created successfully.",
      tournament: toClientTournament(data, 0),
    });
  })
);

// ==================================================
// ADMIN: ENABLE / DISABLE DAILY REPEAT
// ==================================================

app.post(
  "/api/admin/tournaments/:id/repeat-daily",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = normalizeTournamentId(req.params.id);

    const tournament = await getTournament(id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (typeof req.body.enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "Send enabled as true or false.",
      });
    }

    // DAILY REPEAT OFF
    if (req.body.enabled === false) {
      const { data, error } = await supabase
        .from("daily_tournament_rules")
        .update({
          active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("source_tournament_id", id)
        .select("id");

      if (error) {
        return sendDatabaseError(
          res,
          error,
          "Disabling daily repeat failed."
        );
      }

      return res.json({
        success: true,
        message: data?.length
          ? "Daily repeat disabled successfully."
          : "Daily repeat was not enabled.",
      });
    }

    // DAILY REPEAT ON
    const { data: existingRule, error: findError } =
      await supabase
        .from("daily_tournament_rules")
        .select("id, next_run_date")
        .eq("source_tournament_id", id)
        .maybeSingle();

    if (findError) {
      return sendDatabaseError(
        res,
        findError,
        "Checking daily repeat rule failed."
      );
    }

    let ruleData;
    let saveError;

   const templateData = {
  tournament_name: tournament.tournament_name,
  game_mode: tournament.game_mode,
  match_type: tournament.match_type,
  map: tournament.map,
  time: tournament.time,
  entry_fee: tournament.entry_fee,
  prize_pool: tournament.prize_pool,
  per_kill: tournament.per_kill,
  slots: tournament.slots,
  rules: tournament.rules,
  image_url: tournament.image_url,

  // Daily Repeat ki har nayi copy automatically publish hogi.
  published: true,
};

    if (existingRule) {
      // Existing rule: update template but preserve next_run_date.
      const result = await supabase
        .from("daily_tournament_rules")
        .update({
          template_data: templateData,
          active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("source_tournament_id", id)
        .select("*")
        .single();

      ruleData = result.data;
      saveError = result.error;
    } else {
      // First time: schedule from tomorrow.
      const result = await supabase
        .from("daily_tournament_rules")
        .insert({
          source_tournament_id: id,
          template_data: templateData,
          active: true,
          next_run_date: getTomorrowIndiaDate(),
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      ruleData = result.data;
      saveError = result.error;
    }

    if (saveError) {
      return sendDatabaseError(
        res,
        saveError,
        "Enabling daily repeat failed."
      );
    }

    return res.json({
      success: true,
      message: "Daily repeat enabled successfully.",
      source_tournament_id: id,
      next_run_date: ruleData.next_run_date,
    });
  })
);

// ==================================================
// ADMIN: UPDATE TOURNAMENT
// ==================================================

app.put(
  "/api/admin/tournaments/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = normalizeTournamentId(req.params.id);
    const existing = await getTournament(id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (
      existing.tournament_status === "Completed" ||
      existing.tournament_status === "Cancelled"
    ) {
      return res.status(409).json({
        success: false,
        error: "Completed or cancelled tournaments cannot be edited.",
      });
    }

    const oldMatchKey = getTournamentMatchKey(existing);

    const oldJoinCount = await getJoinedCount(
      existing.tournament_id,
      oldMatchKey
    );

    let payload;

    try {
      payload = normalizePayload(req.body, existing);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    const newMatchKey = createMatchKey(
      existing.tournament_id,
      payload.date,
      payload.time
    );

    if (
      oldJoinCount > 0 &&
      oldMatchKey !== newMatchKey
    ) {
      return res.status(409).json({
        success: false,
        error: "Date/time cannot be changed after players have joined.",
      });
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(payload)
      .eq("tournament_id", id)
      .select("*")
      .single();

    if (error) {
      return sendDatabaseError(res, error);
    }

    const count = await getJoinedCount(
      data.tournament_id,
      getTournamentMatchKey(data)
    );

    res.json({
      success: true,
      message: "Tournament updated successfully.",
      tournament: toClientTournament(data, count),
    });
  })
);

// ==================================================
// ADMIN: VISIBILITY
// ==================================================

app.patch(
  "/api/admin/tournaments/:id/visibility",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = normalizeTournamentId(req.params.id);
    const tournament = await getTournament(id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    let hidden;
    let updateData;

    if (typeof req.body.hidden === "boolean") {
      hidden = req.body.hidden;

      if (
        !hidden &&
        ["Cancelled", "Completed", "Live"].includes(
          tournament.tournament_status
        )
      ) {
        return res.status(409).json({
          success: false,
          error: "This tournament cannot be published in its current status.",
        });
      }

      updateData = {
        is_hidden: hidden,
        updated_at: new Date().toISOString(),
      };

      // Unhide also publishes a valid Upcoming tournament.
      if (!hidden) {
        updateData.published = true;
        updateData.status = "published";
      }
    } else if (typeof req.body.published === "boolean") {
      hidden = !req.body.published;

      if (
        !hidden &&
        ["Cancelled", "Completed", "Live"].includes(
          tournament.tournament_status
        )
      ) {
        return res.status(409).json({
          success: false,
          error: "This tournament cannot be published in its current status.",
        });
      }

      updateData = {
        is_hidden: hidden,
        updated_at: new Date().toISOString(),
      };

      if (!hidden) {
        updateData.published = true;
        updateData.status = "published";
      }
    } else {
      return res.status(400).json({
        success: false,
        error: "Send hidden or published as true/false.",
      });
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(updateData)
      .eq("tournament_id", id)
      .select("*")
      .single();

    if (error) {
      return sendDatabaseError(res, error);
    }

    res.json({
      success: true,
      message: hidden
        ? "Tournament hidden successfully."
        : "Tournament published and visible successfully.",
      tournament: toClientTournament(data),
    });
  })
);

// ==================================================
// ADMIN: STATUS
// ==================================================

app.patch(
  "/api/admin/tournaments/:id/status",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = normalizeTournamentId(req.params.id);

    const status = normalizeStatus(
      req.body.status ?? req.body.tournament_status,
      ""
    );

    if (!editableStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status. Completed must use the complete endpoint.",
        allowed: editableStatuses,
      });
    }

    const tournament = await getTournament(id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (
      tournament.tournament_status === "Completed" ||
      tournament.tournament_status === "Cancelled"
    ) {
      return res.status(409).json({
        success: false,
        error: "Completed or cancelled tournament cannot change status.",
      });
    }

    const published =
      status === "Live" || status === "Cancelled"
        ? false
        : Boolean(tournament.published);

    const updateData = {
      tournament_status: status,
      published,
      status:
        status === "Cancelled"
          ? "cancelled"
          : status === "Live"
            ? "published"
            : published
              ? "published"
              : "draft",
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from(TABLE)
      .update(updateData)
      .eq("tournament_id", id)
      .select("*")
      .single();

    if (error) {
      return sendDatabaseError(res, error);
    }

    res.json({
      success: true,
      message:
        status === "Live"
          ? "Match is now Live."
          : `Tournament status changed to ${status}.`,
      tournament: toClientTournament(data),
    });
  })
);

// ==================================================
// ADMIN: SHARE ROOM ID AND PASSWORD + NOTIFICATIONS
// ==================================================

app.post(
  "/api/admin/tournaments/:id/share-room",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    ensureEditableTournament(tournament);

    const roomId = cleanText(req.body.room_id);
    const roomPassword = cleanText(req.body.room_password);

    if (!roomId || !roomPassword) {
      return res.status(400).json({
        success: false,
        error: "Room ID and Room Password are required.",
      });
    }

    if (roomId.length > 100 || roomPassword.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Room ID or password is too long.",
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    // 1. Tournament ke joined players fetch karo
    const players = await getTournamentPlayers(
      tournament.tournament_id,
      matchKey
    );

    if (players.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No players have joined this match.",
      });
    }

    // 2. Sabhi joined players ke records mein room details update karo
    const { data, error } = await supabase
      .from(JOIN_TABLE)
      .update({
        room_id: roomId,
        room_password: roomPassword,
      })
      .eq("tournament_id", tournament.tournament_id)
      .eq("match_key", matchKey)
      .select("id, profile_id");

    if (error) {
      return sendDatabaseError(res, error);
    }

    // 3. Notification records prepare karo
    const notificationsToInsert = [
      ...new Map(
        (data || [])
          .filter((player) => cleanText(player.profile_id))
          .map((player) => [
            player.profile_id,
            {
              profile_id: player.profile_id,
              tournament_id: tournament.tournament_id,
              title: `🎮 Room Details Out: ${tournament.tournament_name}`,
              message: "Room ID and Password are out! Join the match now.",
              room_id: roomId,
              room_password: roomPassword,
              is_read: false,
            },
          ])
      ).values(),
    ];

    // 4. Notifications database mein save karo
    let notificationCount = 0;
    let notificationError = null;

    if (notificationsToInsert.length > 0) {
      const { data: notificationData, error: notifError } =
        await supabase
          .from("notifications")
          .insert(notificationsToInsert)
          .select("id");

      if (notifError) {
        notificationError = notifError.message;

        console.error(
          "Failed to save player notifications:",
          notifError
        );
      } else {
        notificationCount = notificationData?.length || 0;
      }
    }

    // 5. Final response
    res.json({
      success: true,
      message: "Room details shared with joined players.",
      sharedWith: data?.length || 0,
      notificationsSent: notificationCount,
      notificationError,
      match_key: matchKey,
    });
  })
);

// ==================================================
// ADMIN: DUPLICATE TOURNAMENT
// ==================================================

app.post(
  "/api/admin/tournaments/:id/duplicate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const original = await getTournament(req.params.id);

    if (!original) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    const newId = normalizeTournamentId(req.body.newId);

    if (!newId) {
      return res.status(400).json({
        success: false,
        error: "New tournament ID is required.",
      });
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        tournament_id: newId,
        tournament_name: `${original.tournament_name} Copy`,
        game_mode: original.game_mode,
        match_type: original.match_type,
        map: original.map,
        date: original.date,
        time: original.time,
        entry_fee: original.entry_fee,
        prize_pool: original.prize_pool,
        per_kill: original.per_kill,
        slots: original.slots,
        rules: original.rules,
        image_url: original.image_url,
        published: false,
        is_hidden: false,
        tournament_status: "Draft",
        status: "draft",
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          error: "This tournament ID already exists.",
        });
      }

      return sendDatabaseError(res, error);
    }

    res.status(201).json({
      success: true,
      message: "Tournament duplicated as draft.",
      tournament: toClientTournament(data, 0),
    });
  })
);

// ==================================================
// ADMIN: DELETE + REFUND
// ==================================================

app.delete(
  "/api/admin/tournaments/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournamentId = normalizeTournamentId(req.params.id);

    if (!tournamentId) {
      return res.status(400).json({
        success: false,
        error: "Tournament ID is required.",
      });
    }

    const tournament = await getTournament(tournamentId);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    const { data, error } = await supabase.rpc(
      "admin_refund_and_delete_tournament",
      {
        p_tournament_id: tournamentId,
      }
    );

    if (error) {
      console.error("Tournament refund/delete failed:", error);

      return res.status(500).json({
        success: false,
        error: error.message || "Tournament deletion and refund failed.",
      });
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (!result || typeof result !== "object") {
      return res.status(500).json({
        success: false,
        error: "Invalid response received from refund function.",
      });
    }

    console.log("Tournament deleted with refunds:", {
      tournamentId,
      result,
    });

    res.json({
      success: true,
      message: "Tournament deleted and player entry fees refunded successfully.",
      result: {
        ...result,
        // SQL function 'players_refunded' bhejta hai
        refunded_players: Number(
          result.players_refunded ??
          result.refunded_players ??
          result.refunds_count ??
          result.refund_count ??
          result.refunded_count ??
          0
        ),
        total_refunded: Number(
          result.total_refunded ??
          result.totalRefunded ??
          0
        ),
      },
    });
  })
);

// ==================================================
// ADMIN: GET PLAYERS AND RESULTS
// ==================================================

app.get(
  "/api/admin/tournaments/:id/players",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    const [players, results] = await Promise.all([
      getTournamentPlayers(tournament.tournament_id, matchKey),
      getTournamentResults(tournament.tournament_id, matchKey),
    ]);

    const resultMap = new Map(
      results.map((result) => [
        String(result.join_id),
        result,
      ])
    );

    const formattedPlayers = players.map((player) =>
      makePlayerResult(
        player,
        resultMap.get(String(player.id)) || null
      )
    );

    res.json({
      success: true,
      match_key: matchKey,
      tournament: toClientTournament(tournament, players.length),
      players: formattedPlayers,
      totalPlayers: formattedPlayers.length,
    });
  })
);

// ==================================================
// ADMIN: SAVE RESULTS
// ==================================================

app.put(
  "/api/admin/tournaments/:id/results",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (
      tournament.tournament_status === "Completed" ||
      tournament.tournament_status === "Cancelled"
    ) {
      return res.status(409).json({
        success: false,
        error: "Results cannot be changed for completed or cancelled tournaments.",
      });
    }

    if (!Array.isArray(req.body.players)) {
      return res.status(400).json({
        success: false,
        error: "players must be an array.",
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    const registeredPlayers = await getTournamentPlayers(
      tournament.tournament_id,
      matchKey
    );

    if (registeredPlayers.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No registered players found.",
      });
    }

    if (req.body.players.length !== registeredPlayers.length) {
      return res.status(400).json({
        success: false,
        error: "Submit results for every registered player.",
        registeredPlayers: registeredPlayers.length,
        submittedPlayers: req.body.players.length,
      });
    }

    const existingResults = await getTournamentResults(
      tournament.tournament_id,
      matchKey
    );

    if (existingResults.some((result) => result.status === "paid")) {
      return res.status(409).json({
        success: false,
        error: "Results are already paid. Editing is locked.",
      });
    }

    const registeredMap = new Map(
      registeredPlayers.map((player) => [
        String(player.id),
        player,
      ])
    );

    const submittedIds = new Set();
    const rowsToSave = [];

    try {
      for (const submitted of req.body.players) {
        const joinId = String(submitted.join_id ?? "");

        if (!joinId || submittedIds.has(joinId)) {
          return res.status(400).json({
            success: false,
            error: "Missing or duplicate join_id.",
          });
        }

        submittedIds.add(joinId);

        const player = registeredMap.get(joinId);

        if (!player) {
          return res.status(400).json({
            success: false,
            error: `Invalid join_id: ${joinId}`,
          });
        }

        if (!cleanText(player.profile_id)) {
          return res.status(400).json({
            success: false,
            error: `Missing profile ID for ${player.player_name}.`,
          });
        }

        const kills = numberValue(
          submitted.kills,
          "Kills",
          0,
          true
        );

        const rankPosition =
          submitted.rank_position === null ||
          submitted.rank_position === "" ||
          submitted.rank_position === undefined
            ? null
            : numberValue(
                submitted.rank_position,
                "Rank position",
                1,
                true
              );

        const points = numberValue(
          submitted.points,
          "Points"
        );

        const isWinner = submitted.is_winner === true;

        const winnerPrize = isWinner
          ? numberValue(
              submitted.winner_prize,
              "Winner prize"
            )
          : 0;

        const perKill = Number(tournament.per_kill || 0);
        const killAmount = kills * perKill;
        const totalWinning = killAmount + winnerPrize;

        rowsToSave.push({
          tournament_id: tournament.tournament_id,
          match_key: matchKey,
          join_id: player.id,

          bgmi_id: player.bgmi_id || "",
          profile_id: player.profile_id,
          player_name: player.player_name || "",

          kills,
          rank_position: rankPosition,
          points,

          is_winner: isWinner,

          per_kill: perKill,
          kill_amount: killAmount,
          winner_prize: winnerPrize,
          total_winning: totalWinning,

          status: "draft",
          paid_at: null,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    if (submittedIds.size !== registeredPlayers.length) {
      return res.status(400).json({
        success: false,
        error: "Results missing for one or more registered players.",
      });
    }

    const { data, error } = await supabase
      .from(RESULT_TABLE)
      .upsert(rowsToSave, {
        onConflict: "tournament_id,join_id",
      })
      .select("*");

    if (error) {
      return sendDatabaseError(
        res,
        error,
        "Saving result drafts failed."
      );
    }

    res.json({
      success: true,
      message: "All player results saved successfully.",
      savedCount: data?.length || rowsToSave.length,
      results: data || [],
    });
  })
);

// ==================================================
// ADMIN: PUBLISH RESULTS + PAYOUT
// ==================================================

app.post(
  "/api/admin/tournaments/:id/publish-results",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (
      tournament.tournament_status === "Completed" ||
      tournament.tournament_status === "Cancelled"
    ) {
      return res.status(409).json({
        success: false,
        error: "This tournament cannot publish results.",
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    const [players, results] = await Promise.all([
      getTournamentPlayers(tournament.tournament_id, matchKey),
      getTournamentResults(tournament.tournament_id, matchKey),
    ]);

    if (players.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No registered players found.",
      });
    }

    if (results.length !== players.length) {
      return res.status(400).json({
        success: false,
        error: "Save results for every registered player first.",
        registeredPlayers: players.length,
        savedResults: results.length,
      });
    }

    const joinMap = new Map(
      players.map((player) => [
        String(player.id),
        player,
      ])
    );

    const resultJoinIds = new Set();

    for (const result of results) {
      const joinId = String(result.join_id);
      const player = joinMap.get(joinId);

      if (!player || resultJoinIds.has(joinId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid or duplicate player result.",
        });
      }

      resultJoinIds.add(joinId);

      if (
        result.profile_id !== player.profile_id ||
        result.tournament_id !== tournament.tournament_id ||
        result.match_key !== matchKey
      ) {
        return res.status(400).json({
          success: false,
          error: `Player identity or match mismatch for ${player.player_name}.`,
        });
      }

      if (
        result.status !== "draft" &&
        result.status !== "paid"
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid result payment status.",
        });
      }
    }

    if (resultJoinIds.size !== players.length) {
      return res.status(400).json({
        success: false,
        error: "Results are missing for one or more players.",
      });
    }

    const allAlreadyPaid = results.every(
      (result) =>
        result.status === "paid" &&
        Boolean(result.paid_at)
    );

    if (allAlreadyPaid) {
      return res.json({
        success: true,
        alreadyPaid: true,
        message: "All results have already been paid.",
        paidCount: results.length,
        totalAmount: results.reduce(
          (sum, result) =>
            sum + Number(result.total_winning || 0),
          0
        ),
      });
    }

    // The SQL RPC must perform payment atomically and prevent
    // duplicate wallet credits under concurrent requests.
    const { data, error } = await supabase.rpc(
      "publish_tournament_payouts",
      {
        p_tournament_id: tournament.tournament_id,
        p_match_key: matchKey,
      }
    );

    if (error) {
      return sendDatabaseError(
        res,
        error,
        "Tournament wallet payout failed."
      );
    }

    const payout = Array.isArray(data) ? data[0] : data;

    if (!payout || typeof payout !== "object") {
      return res.status(500).json({
        success: false,
        error: "Invalid payout response from database.",
      });
    }

    res.json({
      success: true,
      message: "Results published and winnings credited.",
      paidCount: Number(payout.paid_count || 0),
      totalAmount: Number(payout.total_amount || 0),
      payout,
    });
  })
);

// ==================================================
// ADMIN: COMPLETE TOURNAMENT
// ==================================================

app.post(
  "/api/admin/tournaments/:id/complete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tournament = await getTournament(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: "Tournament not found.",
      });
    }

    if (tournament.tournament_status === "Cancelled") {
      return res.status(409).json({
        success: false,
        error: "Cancelled tournaments cannot be completed.",
      });
    }

    if (tournament.tournament_status === "Completed") {
      return res.json({
        success: true,
        alreadyCompleted: true,
        message: "Tournament is already completed.",
        tournament: toClientTournament(tournament),
      });
    }

    const matchKey = getTournamentMatchKey(tournament);

    const [players, results] = await Promise.all([
      getTournamentPlayers(tournament.tournament_id, matchKey),
      getTournamentResults(tournament.tournament_id, matchKey),
    ]);

    if (players.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No registered players found.",
      });
    }

    if (results.length !== players.length) {
      return res.status(409).json({
        success: false,
        error: "Cannot complete. Results are missing.",
        registeredPlayers: players.length,
        savedResults: results.length,
      });
    }

    const joinMap = new Map(
      players.map((player) => [
        String(player.id),
        player,
      ])
    );

    const resultIds = new Set();

    for (const result of results) {
      const joinId = String(result.join_id);
      const player = joinMap.get(joinId);

      if (
        !player ||
        resultIds.has(joinId) ||
        result.profile_id !== player.profile_id ||
        result.match_key !== matchKey ||
        result.tournament_id !== tournament.tournament_id
      ) {
        return res.status(409).json({
          success: false,
          error: "Player result validation failed.",
        });
      }

      resultIds.add(joinId);

      if (
        result.status !== "paid" ||
        !result.paid_at
      ) {
        return res.status(409).json({
          success: false,
          error: "All player winnings must be paid before completion.",
        });
      }
    }

    if (resultIds.size !== players.length) {
      return res.status(409).json({
        success: false,
        error: "One or more player results are missing.",
      });
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update({
        tournament_status: "Completed",
        published: false,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("tournament_id", tournament.tournament_id)
      .neq("tournament_status", "Completed")
      .select("*")
      .maybeSingle();

    if (error) {
      return sendDatabaseError(res, error);
    }

    if (!data) {
      const latest = await getTournament(
        tournament.tournament_id
      );

      if (latest?.tournament_status !== "Completed") {
        return res.status(409).json({
          success: false,
          error: "Tournament completion could not be saved.",
        });
      }

      return res.json({
        success: true,
        alreadyCompleted: true,
        message: "Tournament is already completed.",
        tournament: toClientTournament(latest, players.length),
      });
    }

    res.json({
      success: true,
      sessionCompleted: true,
      message: "Tournament completed successfully. All winnings are verified.",
      match_key: matchKey,
      tournament: toClientTournament(data, players.length),
    });
  })
);

// ==================================================
// PLAYER: LIVE MATCHES
// NOTE: This endpoint still requires player JWT protection.
// ==================================================

app.get(
  "/api/player/live-matches",
  asyncHandler(async (req, res) => {
    const profileId = cleanText(req.query.profileId);

    if (!profileId) {
      return res.status(400).json({
        success: false,
        error: "Player profile ID is required.",
      });
    }

    const { data: joins, error: joinError } = await supabase
      .from(JOIN_TABLE)
      .select("*")
      .eq("profile_id", profileId);

    if (joinError) {
      return sendDatabaseError(res, joinError);
    }

    const joinList = joins || [];

    // Sabhi tournaments ek hi query me
    const tournamentMap = await getTournamentsByIds([
      ...new Set(joinList.map((join) => join.tournament_id)),
    ]);

    const liveJoins = joinList.filter((join) => {
      const tournament = tournamentMap.get(join.tournament_id);

      return (
        tournament &&
        tournament.tournament_status === "Live" &&
        join.match_key &&
        join.match_key === safeMatchKey(tournament)
      );
    });

    // Sabhi counts ek hi query me
    const counts = await getJoinedCountsMap([
      ...new Set(liveJoins.map((join) => join.match_key)),
    ]);

    const matches = liveJoins.map((join) => {
      const tournament = tournamentMap.get(join.tournament_id);

      return {
        id: join.id,
        match_key: join.match_key,

        tournament_id: tournament.tournament_id,
        name: tournament.tournament_name,
        tournament_name: tournament.tournament_name,

        mode: tournament.game_mode,
        game_mode: tournament.game_mode,
        type: tournament.match_type,

        map: tournament.map,
        date: tournament.date,
        time: tournament.time,

        entry_fee: Number(tournament.entry_fee || 0),
        prize_pool: Number(tournament.prize_pool || 0),

        joined_players: counts.get(join.match_key) || 0,

        total_slots: Number(tournament.slots || 50),
        slots: Number(tournament.slots || 50),

        room_id: join.room_id || "",
        room_password: join.room_password || "",
      };
    });

    res.json({
      success: true,
      matches,
      totalMatches: matches.length,
    });
  })
);

// ==================================================
// PLAYER: MATCH HISTORY
// NOTE: This endpoint still requires player JWT protection.
// ==================================================

app.get(
  "/api/player/match-history",
  asyncHandler(async (req, res) => {
    const profileId = cleanText(req.query.profileId);

    if (!profileId) {
      return res.status(400).json({
        success: false,
        error: "Player profile ID is required.",
      });
    }

    const { data: joins, error: joinError } = await supabase
      .from(JOIN_TABLE)
      .select("*")
      .eq("profile_id", profileId);

    if (joinError) {
      return sendDatabaseError(res, joinError);
    }

    const joinList = joins || [];

    // Sabhi tournaments ek hi query me
    const tournamentMap = await getTournamentsByIds([
      ...new Set(joinList.map((join) => join.tournament_id)),
    ]);

    const completedJoins = joinList.filter((join) => {
      const tournament = tournamentMap.get(join.tournament_id);

      return (
        tournament &&
        tournament.tournament_status === "Completed" &&
        join.match_key
      );
    });

    const keys = [
      ...new Set(completedJoins.map((join) => join.match_key)),
    ];

    // Sabhi players aur results ek-ek batch query me
    const [allPlayers, allResults] = await Promise.all([
      fetchJoinsForKeys(
        keys,
        "id, tournament_id, match_key, player_name, bgmi_id, profile_name, profile_id"
      ),
      fetchResultsForKeys(
        keys,
        "join_id, match_key, kills, rank_position, points, is_winner, winner_prize, per_kill, kill_amount, total_winning, status, paid_at"
      ),
    ]);

    const playersByKey = groupBy(allPlayers, (player) => player.match_key);
    const resultsByKey = groupBy(allResults, (result) => result.match_key);

    const matches = completedJoins.map((join) => {
      const tournament = tournamentMap.get(join.tournament_id);
      const players = playersByKey.get(join.match_key) || [];

      const resultMap = new Map(
        (resultsByKey.get(join.match_key) || []).map((result) => [
          String(result.join_id),
          result,
        ])
      );

      const leaderboard = sortLeaderboard(
        players.map((player) =>
          makePlayerResult(
            player,
            resultMap.get(String(player.id)) || null
          )
        )
      );

      return {
        id: join.id,
        match_key: join.match_key,

        tournament_id: tournament.tournament_id,
        name: tournament.tournament_name,
        tournament_name: tournament.tournament_name,

        mode: tournament.game_mode,
        game_mode: tournament.game_mode,

        map: tournament.map,
        date: tournament.date,
        time: tournament.time,

        entry_fee: Number(tournament.entry_fee || 0),
        prize_pool: Number(tournament.prize_pool || 0),

        total_players: players.length,
        results: leaderboard,
      };
    });

    matches.sort((a, b) => {
      const dateA = new Date(`${a.date}T${a.time}`);
      const dateB = new Date(`${b.date}T${b.time}`);

      return dateB - dateA;
    });

    res.json({
      success: true,
      matches,
      totalMatches: matches.length,
    });
  })
);

// ==================================================
// PUBLIC: UPCOMING TOURNAMENTS
// ==================================================

app.get(
  "/api/tournaments",
  asyncHandler(async (req, res) => {
    const payload = await cachedResponse(
      "public-upcoming",
      PUBLIC_CACHE_MS,
      async () => {
        const { data, error } = await supabase
          .from(TABLE)
          .select(
            "tournament_id,tournament_name,game_mode,match_type,map,date,time,entry_fee,prize_pool,per_kill,slots,rules,image_url,published,is_hidden,tournament_status,created_at,updated_at"
          )
          .eq("published", true)
          .eq("is_hidden", false)
          .eq("tournament_status", "Upcoming")
          .gte("date", getIndiaDate())
          .order("date", { ascending: true })
          .order("time", { ascending: true });

        if (error) throwDatabaseError(error);

        return {
          success: true,
          tournaments: await attachCounts(data || []),
        };
      }
    );

    res.json(payload);
  })
);

// ==================================================
// PUBLIC: LIVE TOURNAMENTS
// ==================================================

app.get(
  "/api/live-tournaments",
  asyncHandler(async (req, res) => {
    const payload = await cachedResponse(
      "public-live",
      PUBLIC_CACHE_MS,
      async () => {
        const { data, error } = await supabase
          .from(TABLE)
          .select(
            "tournament_id,tournament_name,game_mode,match_type,map,date,time,entry_fee,prize_pool,per_kill,slots,rules,image_url,published,is_hidden,tournament_status,created_at,updated_at"
          )
          .eq("tournament_status", "Live")
          .eq("is_hidden", false)
          .order("date", { ascending: true })
          .order("time", { ascending: true });

        if (error) throwDatabaseError(error);

        return {
          success: true,
          tournaments: await attachCounts(data || []),
        };
      }
    );

    res.json(payload);
  })
);

// ==================================================
// PUBLIC: COMPLETED TOURNAMENT HISTORY
// ==================================================

app.get(
  "/api/tournament-history",
  asyncHandler(async (req, res) => {
    const payload = await cachedResponse(
      "public-history",
      HISTORY_CACHE_MS,
      async () => {
        const { data: tournaments, error } = await supabase
          .from(TABLE)
          .select(
            "tournament_id,tournament_name,game_mode,match_type,map,date,time,entry_fee,prize_pool,per_kill,slots,published,is_hidden,tournament_status,created_at,updated_at"
          )
          .eq("tournament_status", "Completed")
          .eq("is_hidden", false)
          .order("date", { ascending: false })
          .order("time", { ascending: false });

        if (error) throwDatabaseError(error);

        const keyed = (tournaments || []).map((tournament) => ({
          tournament,
          key: safeMatchKey(tournament),
        }));

        const keys = [
          ...new Set(keyed.map((item) => item.key).filter(Boolean)),
        ];

        // Saare tournaments ke players aur results ek-ek batch query me
        const [allPlayers, allResults] = await Promise.all([
          fetchJoinsForKeys(
            keys,
            "id, tournament_id, match_key, player_name, bgmi_id, profile_name, profile_id"
          ),
          fetchResultsForKeys(
            keys,
            "join_id, match_key, kills, rank_position, points, is_winner, winner_prize, per_kill, kill_amount, total_winning, status, paid_at"
          ),
        ]);

        const playersByKey = groupBy(
          allPlayers,
          (player) => player.match_key
        );

        const resultsByKey = groupBy(
          allResults,
          (result) => result.match_key
        );

        const history = keyed.map(({ tournament, key }) => {
          const players = (key && playersByKey.get(key)) || [];

          const resultMap = new Map(
            ((key && resultsByKey.get(key)) || []).map((result) => [
              String(result.join_id),
              result,
            ])
          );

          const leaderboard = sortLeaderboard(
            players.map((player) =>
              makePlayerResult(
                player,
                resultMap.get(String(player.id)) || null
              )
            )
          );

          return {
            ...toClientTournament(tournament, players.length),
            match_key: key,
            players: leaderboard,
          };
        });

        return {
          success: true,
          history,
        };
      }
    );

    res.json(payload);
  })
);

// ==================================================
// PLAYER: MY WINNING HISTORY
// ==================================================

app.get(
  "/api/my-winning-history",
  asyncHandler(async (req, res) => {
    const profileId = cleanText(req.query.profileId);

    if (!profileId) {
      return res.status(400).json({
        success: false,
        error: "Player profile ID is required.",
      });
    }

    // Sirf us player ke paid (published) results
    const { data: results, error } = await supabase
      .from(RESULT_TABLE)
      .select("*")
      .eq("profile_id", profileId)
      .eq("status", "paid")
      .order("paid_at", { ascending: false });

    if (error) {
      return sendDatabaseError(res, error, "Winning history load failed.");
    }

    const tournamentIds = [
      ...new Set((results || []).map((r) => r.tournament_id)),
    ];

    let tournamentMap = new Map();

    if (tournamentIds.length > 0) {
      const { data: tournaments, error: tError } = await supabase
        .from(TABLE)
        .select("tournament_id, tournament_name, game_mode, match_type, map")
        .in("tournament_id", tournamentIds);

      if (tError) {
        return sendDatabaseError(res, tError, "Tournament details load failed.");
      }

      tournamentMap = new Map(
        (tournaments || []).map((t) => [t.tournament_id, t])
      );
    }

    const history = (results || []).map((r) => {
      const t = tournamentMap.get(r.tournament_id) || {};

      return {
        id: r.id,
        tournament_id: r.tournament_id,
        tournament_name: t.tournament_name || "Tournament",
        mode: t.game_mode || "",
        type: t.match_type || "",
        map: t.map || "",
        // match_key format: ID|YYYY-MM-DD|HH:MM:SS
        tournament_date: r.match_key?.split("|")[1] || r.paid_at,
        kills: Number(r.kills || 0),
        rank_position: r.rank_position,
        winner_prize: Number(r.winner_prize || 0),
        kill_amount: Number(r.kill_amount || 0),
        total_winning: Number(r.total_winning || 0),
        payout_status: r.status,
        paid_at: r.paid_at,
      };
    });

    res.json({
      success: true,
      history,
      totalRecords: history.length,
      totalWinning: history.reduce((s, h) => s + h.total_winning, 0),
    });
  })
);

// ==================================================
// 404 ROUTE
// ==================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "API route not found.",
    path: req.originalUrl,
  });
});

// ==================================================
// GLOBAL ERROR HANDLER
// ==================================================

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.statusCode || 500).json({
    success: false,
    error:
      err.statusCode === 403
        ? "Request origin is not allowed."
        : err.message || "Internal server error.",
  });
});

// ==================================================
// DAILY TOURNAMENT SCHEDULER
// ==================================================

async function processDailyTournaments() {
  const today = getIndiaDate();

  const { data: rules, error } = await supabase
    .from("daily_tournament_rules")
    .select("source_tournament_id, next_run_date")
    .eq("active", true)
    .lte("next_run_date", today)
    .order("next_run_date", { ascending: true });

  if (error) {
    console.error(
      "Daily repeat rules fetch failed:",
      error
    );
    return;
  }

  // Koi rule due nahi hai to chupchap wapas (har minute log nahi)
  if (!rules || rules.length === 0) return;

  console.log("DAILY SCHEDULER: due rules:", rules.length, "date:", today);

  for (const rule of rules) {
    try {
      // Use next_run_date so missed dates are also generated.
      const { data, error } = await supabase.rpc(
        "create_daily_tournament",
        {
          p_source_tournament_id: rule.source_tournament_id,
          p_run_date: rule.next_run_date,
        }
      );

      if (error) {
        console.error(
          "Daily tournament creation failed:",
          rule.source_tournament_id,
          error
        );
        continue;
      }

      console.log(
        "Daily tournament scheduler:",
        rule.source_tournament_id,
        data
      );
    } catch (error) {
      console.error(
        "Daily scheduler error:",
        rule.source_tournament_id,
        error
      );
    }
  }

  // Naye tournaments bane hain, public lists fresh dikhni chahiye
  clearPublicCache();
}

// Every minute check whether a daily tournament is due.
cron.schedule(
  "* * * * *",
  () => {
    processDailyTournaments().catch((error) => {
      console.error("Daily scheduler failed:", error);
    });
  },
  {
    timezone: "Asia/Kolkata",
  }
);

// Check once immediately when server starts.
processDailyTournaments().catch((error) => {
  console.error("Initial daily scheduler check failed:", error);
});

// ==================================================
// START SERVER
// ==================================================

app.listen(PORT, () => {
  console.log("-------------------------------------");
  console.log("BGMI TOURNAMENT MANAGEMENT SERVER");
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Supabase test: http://localhost:${PORT}/api/test-supabase`);
  console.log("Allowed frontend origins:", allowedOrigins);
  console.log("-------------------------------------");
});