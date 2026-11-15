import { defineExtension, defineProvider, ExtensionError, utils } from "azot";
import type { Entry } from "azot";
import { getAuthState, signIn, signOut } from "./lib/auth.ts";
import { fetchTitleMetainfo, fetchSeasonMetainfo, fetchVideoInfo, fetchPlayOptions } from "./lib/api.ts";
import { parsePremierUrl } from "./lib/helpers.ts";
import { resolveWidevineKeys } from "./lib/drm.ts";
import { HOSTNAME } from "./lib/constants.ts";

type EntryData = { contentId: string };

export default defineExtension({
  title: "Premier",
  icon: "icon.webp",
  premier: defineProvider<EntryData>()({
    matches: [`https://*.${HOSTNAME}/*`],
    async list({ url, options }) {
      const { title, season, episode } = parsePremierUrl(url);
      if (!title) return [];

      const content = await fetchTitleMetainfo(title);
      const results: Entry<EntryData>[] = [];

      if (content.seasons_count) {
        const selected = utils.extendEpisodes(options.episodes);
        const seasons = (await fetchSeasonMetainfo(title))
          .filter((item) => season === null || item.number === season)
          .filter((item) => !selected.items.size || selected.has(undefined, item.number));
        const seasonNumbers = new Set(seasons.map((item) => item.number));

        for (const seasonNumber of seasonNumbers) {
          const videos = await fetchVideoInfo(title, "series", seasonNumber);
          for (const video of videos) {
            if (episode !== null && video.episode !== episode) continue;
            if (selected.items.size && !selected.has(video.episode, video.season)) continue;

            results.push({
              id: video.id,
              title: content.name,
              episodeNumber: video.episode,
              seasonNumber: video.season,
              episodeTitle: video.title,
              data: { contentId: video.id }
            });
          }
        }
      } else {
        const movie = (await fetchVideoInfo(title, "movie", 0))[0];
        if (movie) results.push({ id: movie.id, title: movie.title, data: { contentId: movie.id } });
      }

      return results;
    },
    async resolve({ entry }) {
      const playback = await fetchPlayOptions(entry.data.contentId);
      const defaultUrl = playback.video_balancer?.default;
      const dash = Object.values(playback.extended_balancer ?? {})[0];
      const url = defaultUrl || dash?.balancer_url;
      if (!url)
        throw new ExtensionError({
          code: "MEDIA_UNAVAILABLE",
          message: playback.detail?.languages?.[0]?.title || "Premier media is unavailable"
        });

      const licenseUrl = defaultUrl ? undefined : dash?.license_url;
      if (!licenseUrl) return { source: { url } };

      return { source: { url }, resolveKeys: resolveWidevineKeys(licenseUrl, entry.data.contentId) };
    },
    auth: {
      getState: getAuthState,
      login: signIn,
      logout: signOut
    }
  })
});
