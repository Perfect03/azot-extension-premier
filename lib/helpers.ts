export function parsePremierUrl(urlStr: string) {
  const url = new URL(urlStr);
  const parts = url.pathname.split("/").filter(Boolean);

  const showIndex = parts.indexOf("show");
  const title = showIndex !== -1 ? parts[showIndex + 1] : parts[0] ?? null;

  const seasonIndex = parts.indexOf("season");
  const season =
    seasonIndex !== -1 && seasonIndex + 1 < parts.length
      ? parseInt(parts[seasonIndex + 1], 10)
      : null;

  const episodeIndex = parts.indexOf("episode");
  const episode =
    episodeIndex !== -1 && episodeIndex + 1 < parts.length
      ? parseInt(parts[episodeIndex + 1], 10)
      : null;

  return { title, season, episode };
}
