// @ts-check
/// <reference path="./kino.d.ts" />
// Movies: films and series from TMDB; video from PrimeSrc's server list, opened in Kino's hidden browser.
//
// Refs:  m:<tmdb>   s:<tmdb>   e:<tmdb>:<season>:<episode>
//        browse:<list>[:movie|tv]   browse:genre:<movie|tv>:<genreId>
// TMDB is called straight through kino.fetch with a key sealed in the manifest (secret TMDB_KEY), never with the app's own token.
//
// Read top to bottom: 1. texts  2. settings  3. TMDB  4. mapping  5. home/browse/categories/search/details/episodes
//                     6. sources  7. resolve  8. settings form

// ---- 1. texts ----

const T = {
  es: {
    noStreams: "No hay fuentes disponibles para este título ahora.",
    tmdbDown: "No se pudo consultar el catálogo. Revisa tu conexión e inténtalo de nuevo.",
    notFound: "No encontramos ese título.",
    trendingMovies: "Películas en tendencia",
    trendingSeries: "Series en tendencia",
    nowPlaying: "En cines",
    popularMovies: "Películas populares",
    popularSeries: "Series populares",
    topMovies: "Películas mejor valoradas",
    topSeries: "Series mejor valoradas",
    upcoming: "Próximos estrenos",
    airingToday: "Series al aire hoy",
    movieGenre: "Películas de",
    seriesGenre: "Series de",
    movies: "Películas",
    series: "Series",
    seasonN: "Temporada",
    needBrowser: "Movies necesita permiso para abrir páginas ocultas. Apruébalo en sus ajustes.",
    cacheCleared: "Caché limpiada.",
    connected: "conectado",
    unreachable: "sin respuesta",
    accessible: "accesible",
  },
  en: {
    noStreams: "No streams available for this title right now.",
    tmdbDown: "Could not load the catalog. Check your connection and try again.",
    notFound: "We could not find that title.",
    trendingMovies: "Trending movies",
    trendingSeries: "Trending series",
    nowPlaying: "In theaters",
    popularMovies: "Popular movies",
    popularSeries: "Popular series",
    topMovies: "Top rated movies",
    topSeries: "Top rated series",
    upcoming: "Upcoming releases",
    airingToday: "Series airing today",
    movieGenre: "Movies:",
    seriesGenre: "Series:",
    movies: "Movies",
    series: "Series",
    seasonN: "Season",
    needBrowser: "Movies needs permission to open hidden pages. Approve it in its settings.",
    cacheCleared: "Cache cleared.",
    connected: "connected",
    unreachable: "unreachable",
    accessible: "accessible",
  },
};

const isEs = () => kino.language !== "en";
function t(key) {
  return (isEs() ? T.es : T.en)[key] || T.es[key] || key;
}

// ---- 2. settings ----

function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === null || v === undefined || v === "" ? fallback : v;
  } catch { return fallback; }
}
const srcEnabled = (key) => cfg(key, true) !== false && cfg(key, true) !== "false";
const region = () => String(cfg("region", "US"));
const rowLimit = () => Math.max(2, Math.min(10, parseInt(String(cfg("homeRows", "6")), 10) || 6));

// ---- 3. TMDB (direct, sealed key) ----

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

/** Tiny storage cache with TTL; storage may be full or unavailable, so it never throws. */
function cacheGet(key) {
  try { const v = kino.storage.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function cacheSet(key, value, ttlMs) {
  try {
    const text = JSON.stringify(value);
    if (text.length < 40000) kino.storage.set(key, text, { ttlMs });
  } catch { /* full storage: no copy */ }
}

const tmdbLang = () => (isEs() ? "es-MX" : "en-US");

/** One TMDB call. [ttlMs] caches the answer (per language). Throws a Kino error the person can read. */
async function tmdb(path, query = {}, { ttlMs = 0 } = {}) {
  const params = { language: tmdbLang(), ...query };
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const ckey = ttlMs ? "c:" + path + "?" + qs : "";
  if (ckey) { const hit = cacheGet(ckey); if (hit) return hit; }
  const url = `${TMDB}${path}?api_key=${kino.secret("TMDB_KEY")}&${qs}`;
  let res;
  try {
    res = await kino.fetch(url, { timeoutMs: 12000 });
  } catch (e) {
    throw kino.error("network", "tmdb " + path, { userMessage: t("tmdbDown") });
  }
  if (res.status === 404) throw kino.error("not_found", "tmdb 404 " + path, { userMessage: t("notFound") });
  if (!res.ok) throw kino.error("unavailable", "tmdb " + res.status + " " + path, { userMessage: t("tmdbDown") });
  const json = res.json();
  if (ckey) cacheSet(ckey, json, ttlMs);
  return json;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** TMDB genre names by id for one media type ("movie" | "tv"), cached a week. */
async function genreMap(mt) {
  try {
    const data = await tmdb(`/genre/${mt}/list`, {}, { ttlMs: 7 * DAY });
    const map = {};
    for (const g of data.genres || []) map[g.id] = g.name;
    return map;
  } catch { return {}; }
}

// ---- 4. mapping ----

const year = (d) => (typeof d === "string" && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);
const img = (size, p) => (p ? IMG + size + p : undefined);

function mapTitle(m, mt, genres) {
  const tv = mt === "tv";
  const names = (m.genre_ids || []).map((id) => genres[id]).filter(Boolean).slice(0, 3);
  return {
    id: (tv ? "s" : "m") + m.id,
    ref: (tv ? "s:" : "m:") + m.id,
    title: (tv ? m.name || m.original_name : m.title || m.original_title) || "",
    kind: tv ? "series" : "movie",
    year: year(tv ? m.first_air_date : m.release_date),
    poster: img("w342", m.poster_path),
    backdrop: img("w780", m.backdrop_path),
    overview: m.overview || undefined,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : undefined,
    genres: names.length ? names : undefined,
    ids: { tmdb: m.id },
  };
}

/** Results with a title and a poster; a card without art is not worth a slot. */
function mapResults(list, mt, genres) {
  return (list || []).filter((m) => m && m.poster_path).map((m) => mapTitle(m, mt, genres));
}

// ---- 5. home / browse / categories / search / details / episodes ----

// List definitions. [path] gets the page; [mt] is the media type; [days] marks a list that ignores the region.
const LISTS = {
  tm: { path: "/trending/movie/week", mt: "movie", titleKey: "trendingMovies", genre: "peliculas" },
  ts: { path: "/trending/tv/week", mt: "tv", titleKey: "trendingSeries", genre: "series" },
  np: { path: "/movie/now_playing", mt: "movie", titleKey: "nowPlaying", genre: "peliculas", regional: true },
  pm: { path: "/movie/popular", mt: "movie", titleKey: "popularMovies", genre: "peliculas", regional: true },
  ps: { path: "/tv/popular", mt: "tv", titleKey: "popularSeries", genre: "series" },
  rm: { path: "/movie/top_rated", mt: "movie", titleKey: "topMovies", genre: "peliculas", regional: true },
  rs: { path: "/tv/top_rated", mt: "tv", titleKey: "topSeries", genre: "series" },
  up: { path: "/movie/upcoming", mt: "movie", titleKey: "upcoming", genre: "peliculas", regional: true },
  at: { path: "/tv/airing_today", mt: "tv", titleKey: "airingToday", genre: "series" },
};
const HOME_ORDER = ["tm", "ts", "np", "pm", "ps", "rm", "rs", "up", "at"];

function listQuery(def, page) {
  const q = { page };
  if (def.regional) q.region = region();
  return q;
}

export async function home() {
  const ids = HOME_ORDER.slice(0, rowLimit());
  const [gm, gt] = await Promise.all([genreMap("movie"), genreMap("tv")]);
  const settled = await Promise.allSettled(ids.map((id) => tmdb(LISTS[id].path, listQuery(LISTS[id], 1), { ttlMs: HOUR })));
  const rows = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const def = LISTS[ids[i]];
    const items = mapResults(r.value.results, def.mt, def.mt === "tv" ? gt : gm).slice(0, 20);
    if (items.length) rows.push({ id: ids[i], title: t(def.titleKey), ref: "browse:" + ids[i], items, genre: def.genre });
  });
  if (!rows.length) {
    const failed = settled.find((r) => r.status === "rejected");
    throw failed ? failed.reason : kino.error("unavailable", "empty home", { userMessage: t("tmdbDown") });
  }
  return rows;
}

/** The plugin's own section: the same rows as Home, with a hero from the first trending title. */
export async function section() {
  const rows = await home();
  const first = rows[0] && rows[0].items.find((i) => i.backdrop);
  return {
    rows,
    ...(first ? { hero: { title: first.title, image: first.backdrop, text: (first.overview || "").slice(0, 300) || undefined } } : {}),
  };
}

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor || "1", 10) || 1);
  const parts = String(ref).split(":");
  let path, query, mt;
  if (parts[0] === "browse" && parts[1] === "genre" && /^(movie|tv)$/.test(parts[2] || "") && /^\d+$/.test(parts[3] || "")) {
    mt = parts[2];
    path = `/discover/${mt}`;
    query = { page, with_genres: parts[3], sort_by: "popularity.desc", "vote_count.gte": 30 };
  } else if (parts[0] === "browse" && LISTS[parts[1]]) {
    const def = LISTS[parts[1]];
    mt = def.mt;
    path = def.path;
    query = listQuery(def, page);
  } else {
    throw kino.error("not_found", "unknown browse ref: " + ref, { userMessage: t("notFound") });
  }
  const [data, genres] = await Promise.all([tmdb(path, query, { ttlMs: HOUR }), genreMap(mt)]);
  const items = mapResults(data.results, mt, genres);
  const total = Math.min(data.total_pages || 1, 500);
  return { items, next: page < total ? String(page + 1) : undefined };
}

/** Genre tiles for Categorías: films first, then series. TMDB's own genre ids. */
export async function categories() {
  const [gm, gt] = await Promise.all([genreMap("movie"), genreMap("tv")]);
  const tiles = [];
  for (const [id, name] of Object.entries(gm).slice(0, 12)) {
    tiles.push({ id: "gm" + id, title: `${t("movies")} · ${name}`.slice(0, 40), ref: `browse:genre:movie:${id}` });
  }
  for (const [id, name] of Object.entries(gt).slice(0, 12)) {
    tiles.push({ id: "gt" + id, title: `${t("series")} · ${name}`.slice(0, 40), ref: `browse:genre:tv:${id}` });
  }
  return tiles.slice(0, 24);
}

export async function search(query) {
  const q = (typeof query === "string" ? query : (query && query.q) || "").trim();
  if (!q) return [];
  const lean = query && typeof query === "object" ? query.type : null;
  const [gm, gt] = await Promise.all([genreMap("movie"), genreMap("tv")]);
  const [movies, series] = await Promise.allSettled([
    tmdb("/search/movie", { query: q, include_adult: false, ...(query && query.year ? { year: query.year } : {}) }),
    tmdb("/search/tv", { query: q, include_adult: false }),
  ]);
  if (movies.status === "rejected" && series.status === "rejected") throw movies.reason;
  const mv = movies.status === "fulfilled" ? (movies.value.results || []) : [];
  const sv = series.status === "fulfilled" ? (series.value.results || []) : [];
  // Rank by popularity (TMDB's own relevance signal) over both kinds; the kind Kino leans to goes first.
  const all = [
    ...mv.map((m) => ({ m, mt: "movie", pop: m.popularity || 0 })),
    ...sv.map((m) => ({ m, mt: "tv", pop: m.popularity || 0 })),
  ].sort((a, b) => b.pop - a.pop);
  let items = all.filter((x) => x.m.poster_path).map((x) => mapTitle(x.m, x.mt, x.mt === "tv" ? gt : gm));
  if (lean === "movie" || lean === "series") {
    items = [...items.filter((i) => i.kind === lean), ...items.filter((i) => i.kind !== lean)];
  }
  return items.slice(0, 40);
}

/** details(ref): the title page of a film (also answers a series: its overview, genres and ids). */
export async function details(ref) {
  const m = /^([ms]):(\d+)$/.exec(String(ref || ""));
  if (!m) return null;
  const tv = m[1] === "s";
  const d = await tmdb(`/${tv ? "tv" : "movie"}/${m[2]}`, { append_to_response: "external_ids" }, { ttlMs: 6 * HOUR });
  const imdb = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id;
  return {
    title: tv ? d.name : d.title,
    poster: img("w500", d.poster_path),
    backdrop: img("w1280", d.backdrop_path),
    overview: d.overview || undefined,
    genres: (d.genres || []).map((g) => g.name).slice(0, 5),
    year: year(tv ? d.first_air_date : d.release_date),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : undefined,
    runtimeMinutes: !tv && d.runtime > 0 ? d.runtime : undefined,
    ids: { tmdb: d.id, ...(/^tt\d{5,10}$/.test(imdb || "") ? { imdb } : {}) },
  };
}

export async function episodes(ref) {
  const m = /^s:(\d+)$/.exec(String(ref || ""));
  if (!m) throw kino.error("not_found", "not a series ref", { userMessage: t("notFound") });
  const id = m[1];
  const show = await tmdb(`/tv/${id}`, { append_to_response: "external_ids" }, { ttlMs: 6 * HOUR });
  const seasons = (show.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0);

  // append_to_response takes up to 20 sub-requests per call: fetch the seasons in groups of 20, all groups at once.
  const groups = [];
  for (let i = 0; i < seasons.length; i += 20) groups.push(seasons.slice(i, i + 20));
  const answers = await Promise.allSettled(groups.map((g) =>
    tmdb(`/tv/${id}`, { append_to_response: g.map((s) => "season/" + s.season_number).join(",") }, { ttlMs: 6 * HOUR })));

  const out = [];
  for (const a of answers) {
    if (a.status !== "fulfilled") continue;
    for (const s of seasons) {
      const sd = a.value["season/" + s.season_number];
      if (!sd) continue;
      for (const ep of sd.episodes || []) {
        out.push({
          season: s.season_number,
          number: ep.episode_number,
          ref: `e:${id}:${s.season_number}:${ep.episode_number}`,
          title: ep.name || undefined,
          still: img("w300", ep.still_path),
          overview: ep.overview || undefined,
          airDate: /^\d{4}-\d{2}-\d{2}$/.test(ep.air_date || "") ? ep.air_date : undefined,
          runtimeMinutes: ep.runtime > 0 && ep.runtime <= 1000 ? ep.runtime : undefined,
        });
      }
    }
  }
  if (!out.length) throw kino.error("not_found", "no episodes", { userMessage: t("notFound") });
  out.sort((x, y) => x.season - y.season || x.number - y.number);
  const imdb = show.external_ids && show.external_ids.imdb_id;
  return {
    series: {
      title: show.name,
      poster: img("w500", show.poster_path),
      backdrop: img("w1280", show.backdrop_path),
      overview: show.overview || undefined,
      genres: (show.genres || []).map((g) => g.name).slice(0, 5),
      year: year(show.first_air_date),
      rating: show.vote_average ? Math.round(show.vote_average * 10) / 10 : undefined,
      ids: { tmdb: show.id, ...(/^tt\d{5,10}$/.test(imdb || "") ? { imdb } : {}) },
    },
    episodes: out,
  };
}

// ---- 6. sources: PrimeSrc ----
// PrimeSrc lists, per TMDB title, the file hosts that carry it (Filemoon, Voe, Streamtape, Dood...).
//   GET /api/v1/s?tmdb=<id>&type=movie|tv[&season=&episode=]  -> { servers: [{ name, key, file_name, audio_language, ... }] }  (open JSON)
//   GET /api/v1/l?key=<key>                                   -> the host's embed link (behind Cloudflare's browser check)
// The link call is read with kino.browser.page (the hidden browser passes the check); the embed is then opened with
// kino.browser.capture, which answers the video request the host's own player makes.

const PRIME = "https://primesrc.me";
/** Hosts in the order they usually capture best; any other host goes after these. */
const HOST_ORDER = ["voe", "filemoon", "streamtape", "dood", "streamwish", "vidhide", "mixdrop"];

const isHttp = (u) => typeof u === "string" && /^https?:\/\//.test(u);

async function primeServers(p) {
  const q = `tmdb=${p.tmdbId}&type=${p.tv ? "tv" : "movie"}` + (p.tv ? `&season=${p.season}&episode=${p.episode}` : "");
  const res = await kino.fetch(`${PRIME}/api/v1/s?${q}`, { headers: { Referer: PRIME + "/" }, timeoutMs: 10000 });
  if (!res.ok) throw new Error("primesrc " + res.status);
  const json = res.json();
  return Array.isArray(json && json.servers) ? json.servers : [];
}

const qualityOf = (name) => {
  const m = /(2160|1080|720|480)p?/i.exec(String(name || ""));
  return m ? Number(m[1]) : 0;
};

/** One server per host, its best quality first; hosts ordered by HOST_ORDER. */
function rankServers(servers) {
  const wanted = String(cfg("audio", "any"));
  const byHost = new Map();
  for (const s of servers) {
    if (!s || !s.key || !s.name) continue;
    if (wanted !== "any" && s.audio_language && s.audio_language !== wanted) continue;
    const host = String(s.name).toLowerCase();
    const cur = byHost.get(host);
    if (!cur || qualityOf(s.file_name) > qualityOf(cur.file_name)) byHost.set(host, s);
  }
  const pos = (n) => { const i = HOST_ORDER.indexOf(String(n).toLowerCase()); return i < 0 ? 99 : i; };
  return [...byHost.values()].sort((a, b) => pos(a.name) - pos(b.name));
}

const labelOf = (s) => {
  const q = qualityOf(s.file_name);
  return `PrimeSrc · ${s.name}${q ? " · " + q + "p" : ""}`.slice(0, 48);
};

/** The embed link for a server key, read through the hidden browser (Cloudflare's check). */
async function embedLink(key) {
  const cached = cacheGet("l:" + key);
  if (cached) return cached;
  const page = await kino.browser.page(`${PRIME}/api/v1/l?key=${encodeURIComponent(key)}`, { timeoutMs: 12000 });
  const body = page.html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const m = /"(?:link|url)"\s*:\s*"(https?:\/\/[^"]+)"/.exec(body) || /(https?:\/\/(?!primesrc\.me)[^\s"'<>]+)/.exec(body);
  if (!m || !isHttp(m[1])) throw new Error("no link");
  cacheSet("l:" + key, m[1], 10 * 60 * 1000);
  return m[1];
}

/** One server -> a stream, or throws. */
async function playServer(server) {
  const link = await embedLink(server.key);
  const cap = await kino.browser.capture(link, { timeoutMs: 16000, headers: { Referer: PRIME + "/" } });
  const media = cap.media && cap.media[0];
  if (!media || !isHttp(media.url)) throw new Error("no video");
  return {
    url: media.url,
    mime: media.mime,
    headers: media.headers || {},
    label: labelOf(server),
    subtitles: (cap.subtitles || []).filter((s) => isHttp(s.url)).slice(0, 10).map((s) => ({ lang: s.lang || "und", url: s.url })),
  };
}

// ---- 7. resolve ----

/** "m:<id>" | "e:<id>:<s>:<e>" | "l:<key>:<name>" (a lazy copy) -> what the sources need, or null. */
function parseRef(ref) {
  const s = String(ref || "");
  let m = /^m:(\d+)$/.exec(s);
  if (m) return { tv: false, tmdbId: Number(m[1]) };
  m = /^e:(\d+):(\d+):(\d+)$/.exec(s);
  if (m) return { tv: true, tmdbId: Number(m[1]), season: Number(m[2]), episode: Number(m[3]) };
  m = /^l:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9]{1,24})$/.exec(s);
  if (m) return { lazy: { key: m[1], name: m[2] } };
  return null;
}

export async function resolve(ref) {
  const p = parseRef(ref);
  if (!p) throw kino.error("not_found", "unknown ref: " + ref, { userMessage: t("notFound") });

  // A lazy copy: one server, chosen by the person or by Kino's fallback.
  if (p.lazy) {
    try {
      return await playServer({ key: p.lazy.key, name: p.lazy.name, file_name: "" });
    } catch {
      throw kino.error("unavailable", "lazy copy failed", { userMessage: t("noStreams") });
    }
  }

  let servers;
  try { servers = rankServers(await primeServers(p)); } catch { servers = []; }
  if (!servers.length) throw kino.error("unavailable", "no servers", { userMessage: t("noStreams") });

  // Try the servers in order until one gives a video; the ones after it go out as lazy copies (opened only if needed).
  for (let i = 0; i < Math.min(servers.length, 3); i++) {
    let stream;
    try {
      stream = await playServer(servers[i]);
    } catch (e) {
      if (e && (e.code === "not_allowed" || e.code === "browser_unavailable")) {
        throw kino.error("unavailable", "browser " + e.code, { userMessage: t("needBrowser") });
      }
      continue;
    }
    const rest = servers.slice(i + 1, i + 9);
    return {
      ...stream,
      alternatives: rest.map((s) => ({ label: labelOf(s), ref: `l:${s.key}:${String(s.name).replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "x"}` })),
    };
  }
  throw kino.error("unavailable", "no stream captured", { userMessage: t("noStreams") });
}

// ---- 8. settings form ----

async function probe(url, method) {
  try {
    const r = await kino.fetch(url, { method, timeoutMs: 8000 });
    return r.ok || r.status < 500;
  } catch { return false; }
}

export async function settingsStatus(key) {
  if (key !== "serverStatus") return { text: "?", textEn: "?" };
  const [prime, tm] = await Promise.all([
    probe(`${PRIME}/api/v1/s?tmdb=603&type=movie`, "GET"),
    tmdb("/configuration", {}).then(() => true, () => false),
  ]);
  const line = (name, ok) => ({
    es: `${name}: ${ok ? "✓ " + T.es.connected : "✗ " + T.es.unreachable}`,
    en: `${name}: ${ok ? "✓ " + T.en.connected : "✗ " + T.en.unreachable}`,
  });
  const lines = [line("TMDB", tm), line("PrimeSrc", prime)];
  return { text: lines.map((l) => l.es).join("\n"), textEn: lines.map((l) => l.en).join("\n") };
}

export async function action(key) {
  if (key === "checkServers") return settingsStatus("serverStatus");
  if (key === "clearCache") {
    try { for (const k of kino.storage.keys()) kino.storage.remove(k); } catch { /* nothing to clear */ }
    return { text: T.es.cacheCleared, textEn: T.en.cacheCleared };
  }
  return { text: "OK", textEn: "OK" };
}
