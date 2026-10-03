import { afterEach, expect, test, vi } from 'vitest';
import extension from './main';
import { ROUTES } from './lib/constants';

// Premier returns both the main show and its related catalog under season 4.
const seasons = [
  {
    number: 4,
    url: 'https://premier.one/api/metainfo/tv/comedy-club/video/?season=4&show_all=1',
    episode_count: 51,
  },
  {
    number: 4,
    url: 'https://premier.one/api/metainfo/tv/comedy-club-klassika/video/?season=4&show_all=1',
    episode_count: 0,
  },
  { number: 5, episode_count: 1 },
];

const videos = [
  { id: '0330d2a838cc4fd607322f401a12d1af', title: '46 выпуск', season: 4, episode: 46 },
  { id: '8f2d50cef578a447022169b59adaf5ff', title: '50 выпуск', season: 4, episode: 50 },
  { id: 's5e1', title: '1 выпуск', season: 5, episode: 1 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  {
    name: 'explicit S04E46, S04E50 selection',
    url: 'https://premier.one/show/comedy-club/season/4',
    options: { episodes: new Map([[4, new Set([46, 50])]]) },
    expectedVideos: videos.slice(0, 2),
    expectedSeasons: [4],
  },
  {
    name: 'whole season URL',
    url: 'https://premier.one/show/comedy-club/season/4',
    options: {},
    expectedVideos: videos.slice(0, 2),
    expectedSeasons: [4],
  },
  {
    name: 'single episode URL',
    url: 'https://premier.one/show/comedy-club/season/4/episode/46',
    options: {},
    expectedVideos: videos.slice(0, 1),
    expectedSeasons: [4],
  },
  {
    name: 'whole show URL with distinct seasons',
    url: 'https://premier.one/show/comedy-club',
    options: {},
    expectedVideos: videos,
    expectedSeasons: [4, 5],
  },
])('fetches each season once for $name', async ({ url, options, expectedVideos, expectedSeasons }) => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (requestUrl.pathname === new URL(ROUTES.metainfo('comedy-club')).pathname) {
      return Response.json({ id: 1, name: 'Comedy Club', seasons_count: 2 });
    }
    if (requestUrl.pathname === new URL(ROUTES.season('comedy-club')).pathname) {
      return Response.json(seasons);
    }
    if (requestUrl.pathname === new URL(ROUTES.videoinfo('comedy-club')).pathname) {
      const seasonNumber = Number(requestUrl.searchParams.get('season'));
      return Response.json({
        results: videos.filter((video) => video.season === seasonNumber),
        has_next: false,
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  });
  const entries = await extension.fetchContentMetadata(url, options);

  expect(entries).toEqual(expectedVideos.map((video) => ({
    id: video.id,
    title: 'Comedy Club',
    episodeNumber: video.episode,
    seasonNumber: video.season,
    episodeTitle: video.title,
  })));
  const fetchedSeasons = fetchMock.mock.calls
    .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
    .filter((requestUrl) => requestUrl.pathname === new URL(ROUTES.videoinfo('comedy-club')).pathname)
    .map((requestUrl) => Number(requestUrl.searchParams.get('season')));
  expect(fetchedSeasons).toEqual(expectedSeasons);
});
