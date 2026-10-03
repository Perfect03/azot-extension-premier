import type { ContentMetadata } from "azot";
import { defineExtension, utils } from "azot";
import { HOSTNAME } from "./lib/constants";
import { checkAuth } from "./lib/auth";
import { fetchTitleMetainfo, fetchSeasonMetainfo, fetchVideoInfo, fetchPlayOptions } from "./lib/api";
import { parsePremierUrl } from "./lib/helpers";

const init = async () => {
  await checkAuth();
};

export default defineExtension({
  init,

  canHandle: (url) => new URL(url).hostname.includes(HOSTNAME),

  fetchContentMetadata: async (url, args) => {
    const { title, season, episode } = parsePremierUrl(url);

    const results = [] as ContentMetadata[];

    if (title) {
      const content = (await fetchTitleMetainfo(title));
      if (content?.id) {
        if (content.seasons_count) {
          // if series
          const eps = utils.extendEpisodes(args.episodes);
          const seasonsMetadata =
            ((await fetchSeasonMetainfo(title)) ?? [])
            .filter(el => !season || el.number == season)
            .filter(el => !eps.items.size || eps.has(undefined, el.number))
          const seasonNumbers = new Set(seasonsMetadata.map(el => el.number));

          for (const seasonNumber of seasonNumbers) {
            const episodesMetadata = 
              (await fetchVideoInfo(title, 'series', seasonNumber))
              .filter(el => !episode || el.episode == episode)
              .filter(el => !eps.items.size || eps.has(el.episode, el.season))

            for (const episode of episodesMetadata) {
              results.push({
                id: episode.id,
                title: content.name,
                episodeNumber: episode.episode,
                seasonNumber: episode.season,
                episodeTitle: episode.title,
              });
            }
          }
        } else {
          // else - movie
          const movieMetadata = (await fetchVideoInfo(title, 'movie', 0))?.[0]

          results.push({
            id: movieMetadata.id,
            title: movieMetadata.title,
          });
        }
      }
    }
    return results;
  },

  fetchContentSource: async (contentId) => {
    const data = await fetchPlayOptions(contentId)
    const url = data?.video_balancer?.default
    if (url) return {url}
    else {
      const dash = Object.values(data?.extended_balancer ?? {})[0]
      if (dash) return {
        url: dash.balancer_url,
        drm: {
          server: dash.license_url
        }
      }
      else {
        const error = data?.detail?.languages?.[0]?.title ?? 'Неизвестная ошибка'
        throw new Error(error)
      }
    }
  }
});
