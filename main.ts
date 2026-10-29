import { defineExtension, ExtensionError, Input, UrlSource, utils, type MediaEntry } from "azot/v2";
import { getAuthState, signIn, signOut } from "./lib/auth.ts";
import {
  fetchTitleMetainfo,
  fetchSeasonMetainfo,
  fetchVideoInfo,
  fetchPlayOptions,
} from "./lib/api.ts";
import { parsePremierUrl } from "./lib/helpers.ts";

type PremierContext = {
  licenseUrl?: string;
};

export default defineExtension<PremierContext>({
  async getEntries({ url, options, signal }) {
    const { title, season, episode } = parsePremierUrl(url);
    if (!title) return [];

    const content = await fetchTitleMetainfo(title, signal);
    const entries: MediaEntry<PremierContext>[] = [];

    if (content.seasons_count) {
      const episodes = utils.extendEpisodes(options.episodes);
      const seasons = (await fetchSeasonMetainfo(title, signal))
        .filter((item) => season === null || item.number === season)
        .filter((item) => !episodes.items.size || episodes.has(undefined, item.number));
      const seasonNumbers = new Set(seasons.map((item) => item.number));

      for (const seasonNumber of seasonNumbers) {
        const videos = await fetchVideoInfo(title, "series", seasonNumber, signal);
        for (const video of videos) {
          if (episode !== null && video.episode !== episode) continue;
          if (episodes.items.size && !episodes.has(video.episode, video.season)) continue;

          entries.push({
            id: video.id,
            type: "episode",
            title: content.name,
            episodeNumber: video.episode,
            seasonNumber: video.season,
            episodeTitle: video.title,
            url,
          });
        }
      }
    } else {
      const movie = (await fetchVideoInfo(title, "movie", 0, signal))[0];
      if (movie) {
        entries.push({ id: movie.id, type: "movie", title: movie.title, url });
      }
    }

    return entries;
  },

  async resolveEntry({ entry, signal }) {
    if (!entry.id) {
      throw new ExtensionError({
        code: "MEDIA_UNAVAILABLE",
        message: "Premier content ID is missing",
      });
    }

    const playback = await fetchPlayOptions(entry.id, signal);
    const defaultUrl = playback.video_balancer?.default;
    const dash = Object.values(playback.extended_balancer ?? {})[0];
    const url = defaultUrl || dash?.balancer_url;
    if (!url) {
      throw new ExtensionError({
        code: "MEDIA_UNAVAILABLE",
        message: playback.detail?.languages?.[0]?.title || "Premier media is unavailable",
      });
    }

    return {
      entry: { ...entry, context: { licenseUrl: defaultUrl ? undefined : dash?.license_url } },
      input: new Input({ source: new UrlSource(url) }),
    };
  },

  auth: {
    getState: getAuthState,
    login: signIn,
    logout: signOut,
  },

  drm: {
    async requestLicense({ system, resource, data, signal }) {
      if (system !== "widevine") throw new Error(`Unsupported DRM system: ${system}`);
      const licenseUrl = resource.entry.context?.licenseUrl;
      if (!licenseUrl) {
        throw new ExtensionError({
          code: "DRM_UNAUTHORIZED",
          message: "Premier license URL is missing",
        });
      }

      const response = await fetch(licenseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
        signal,
      });
      if (!response.ok) {
        throw new ExtensionError({
          code: "DRM_UNAUTHORIZED",
          message: `Premier license request failed (${response.status})`,
          operation: "requestLicense",
        });
      }
      const license = new Uint8Array(await response.arrayBuffer());
      if (license[0] !== 0x7b) return license;

      // The legacy host also decoded base64 Widevine licenses wrapped in JSON responses.
      const encodedLicense = new TextDecoder()
        .decode(license)
        .match(/"(CAIS[A-Za-z0-9+/=]*)"/)?.[1];
      if (!encodedLicense) {
        throw new ExtensionError({
          code: "DRM_UNAUTHORIZED",
          message: "Premier license response is invalid",
        });
      }
      return Uint8Array.fromBase64(encodedLicense);
    },
  },
});
