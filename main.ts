import { abortable, defineExtension, ExtensionError, Input, sleep, UrlSource, utils, type MediaEntry } from "azot/v2";
import { getAuthState, signIn, signOut } from "./lib/auth.ts";
import {
  fetchTitleMetainfo,
  fetchSeasonMetainfo,
  fetchVideoInfo,
  fetchPlayOptions,
} from "./lib/api.ts";
import { parsePremierUrl } from "./lib/helpers.ts";
import { createLicenseError, isTransientLicenseError } from "./lib/license-errors.ts";

const LICENSE_REQUEST_ATTEMPTS = 5;

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
          code: "UNKNOWN",
          message: "Premier license URL is missing",
          operation: "requestLicense",
        });
      }

      let response: Response;
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        response = await fetch(licenseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: data,
          signal,
        });
        if (response.ok) break;
        const error = await createLicenseError({
          message: `Premier license request failed (${response.status})`,
          response,
          contentId: resource.entry.id,
          licenseUrl,
          requestBytes: data.byteLength,
        });
        if (attempt >= LICENSE_REQUEST_ATTEMPTS || !isTransientLicenseError(error)) throw error;
        const delayMs = 2 ** (attempt - 1) * 1000;
        console.debug("Premier license restriction service unavailable; retrying", {
          contentId: resource.entry.id, attempt, delayMs,
        });
        await abortable(sleep(delayMs), signal);
      }
      const license = new Uint8Array(await response.arrayBuffer());
      if (license[0] !== 0x7b) return license;

      // The legacy host also decoded base64 Widevine licenses wrapped in JSON responses.
      const encodedLicense = new TextDecoder()
        .decode(license)
        .match(/"(CAIS[A-Za-z0-9+/=]*)"/)?.[1];
      if (!encodedLicense) {
        throw await createLicenseError({
          message: "Premier license response is invalid",
          response,
          contentId: resource.entry.id,
          licenseUrl,
          requestBytes: data.byteLength,
          body: license,
        });
      }
      return Uint8Array.fromBase64(encodedLicense);
    },
  },
});
