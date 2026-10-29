import { afterEach, expect, test, vi } from "vitest";
import extension from "./main.ts";
import { ROUTES } from "./lib/constants.ts";

// Premier returns both the main show and its related catalog under season 4.
const seasons = [
  {
    number: 4,
    url: "https://premier.one/api/metainfo/tv/comedy-club/video/?season=4&show_all=1",
    episode_count: 51,
  },
  {
    number: 4,
    url: "https://premier.one/api/metainfo/tv/comedy-club-klassika/video/?season=4&show_all=1",
    episode_count: 0,
  },
  { number: 5, episode_count: 1 },
];

const videos = [
  { id: "0330d2a838cc4fd607322f401a12d1af", title: "46 выпуск", season: 4, episode: 46 },
  { id: "8f2d50cef578a447022169b59adaf5ff", title: "50 выпуск", season: 4, episode: 50 },
  { id: "s5e1", title: "1 выпуск", season: 5, episode: 1 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  {
    name: "explicit S04E46, S04E50 selection",
    url: "https://premier.one/show/comedy-club/season/4",
    options: { episodes: new Map([[4, new Set([46, 50])]]) },
    expectedVideos: videos.slice(0, 2),
    expectedSeasons: [4],
  },
  {
    name: "whole season URL",
    url: "https://premier.one/show/comedy-club/season/4",
    options: {},
    expectedVideos: videos.slice(0, 2),
    expectedSeasons: [4],
  },
  {
    name: "single episode URL",
    url: "https://premier.one/show/comedy-club/season/4/episode/46",
    options: {},
    expectedVideos: videos.slice(0, 1),
    expectedSeasons: [4],
  },
  {
    name: "whole show URL with distinct seasons",
    url: "https://premier.one/show/comedy-club",
    options: {},
    expectedVideos: videos,
    expectedSeasons: [4, 5],
  },
])(
  "fetches each season once for $name",
  async ({ url, options, expectedVideos, expectedSeasons }) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.pathname === new URL(ROUTES.metainfo("comedy-club")).pathname) {
        return Response.json({ id: 1, name: "Comedy Club", seasons_count: 2 });
      }
      if (requestUrl.pathname === new URL(ROUTES.season("comedy-club")).pathname) {
        return Response.json(seasons);
      }
      if (requestUrl.pathname === new URL(ROUTES.videoinfo("comedy-club")).pathname) {
        const seasonNumber = Number(requestUrl.searchParams.get("season"));
        return Response.json({
          results: videos.filter((video) => video.season === seasonNumber),
          has_next: false,
        });
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    });
    const entries = await extension.getEntries({ url, options });

    expect(entries).toEqual(
      expectedVideos.map((video) => ({
        id: video.id,
        type: "episode",
        title: "Comedy Club",
        episodeNumber: video.episode,
        seasonNumber: video.season,
        episodeTitle: video.title,
        url,
      })),
    );
    const fetchedSeasons = fetchMock.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
      .filter(
        (requestUrl) => requestUrl.pathname === new URL(ROUTES.videoinfo("comedy-club")).pathname,
      )
      .map((requestUrl) => Number(requestUrl.searchParams.get("season")));
    expect(fetchedSeasons).toEqual(expectedSeasons);
  },
);

test("lists movie entries without resolving playback", async () => {
  const url = "https://premier.one/show/test-movie";
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ name: "Test movie", seasons_count: 0 }))
    .mockResolvedValueOnce(Response.json({ results: [{ id: "movie-id", title: "Test movie" }] }));

  expect(await extension.getEntries({ url, options: {} })).toEqual([
    { id: "movie-id", type: "movie", title: "Test movie", url },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("collects every page of a selected season", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ name: "Comedy Club", seasons_count: 1 }))
    .mockResolvedValueOnce(Response.json([{ number: 4 }]))
    .mockResolvedValueOnce(Response.json({ results: [videos[0]], has_next: true }))
    .mockResolvedValueOnce(Response.json({ results: [videos[1]], has_next: false }));
  const signal = new AbortController().signal;

  const entries = await extension.getEntries({
    url: "https://premier.one/show/comedy-club/season/4",
    options: {},
    signal,
  });

  expect(entries.map((entry) => entry.id)).toEqual(videos.slice(0, 2).map((video) => video.id));
  expect(
    fetchMock.mock.calls.slice(2).map((call) => new URL(String(call[0])).searchParams.get("page")),
  ).toEqual(["1", "2"]);
  expect(fetchMock.mock.calls.every((call) => call[1]?.signal === signal)).toBe(true);
});

test("returns no entries when a movie has no videos", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ name: "Unavailable movie", seasons_count: 0 }))
    .mockResolvedValueOnce(Response.json({ results: [] }));

  expect(
    await extension.getEntries({ url: "https://premier.one/show/test-movie", options: {} }),
  ).toEqual([]);
});

test("reports rejected authentication without prompting or retrying", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 401 }));

  await expect(
    extension.getEntries({ url: "https://premier.one/show/test-movie", options: {} }),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
