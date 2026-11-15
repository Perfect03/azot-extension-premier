import { ExtensionError, z } from "azot";
import { DEFAULT_HEADERS, ROUTES } from "./constants.ts";
import {
  contentMetadataSchema,
  seasonMetadataSchema,
  videoInfoResponseSchema,
  playOptionsSchema,
} from "./types.ts";

const errorResponseSchema = z.object({ success: z.literal(false), message: z.string().optional() });

/** Validates Premier responses without prompting or terminating the host on failure.
 * Cancellation is ambient: the injected fetch already honors Azot.signal.
 */
export const request = async <TSchema extends z.ZodType>(
  url: string | URL,
  schema: TSchema,
  init: Pick<RequestInit, "method" | "body"> = {},
): Promise<z.output<TSchema>> => {
  const headers = new Headers(DEFAULT_HEADERS);
  const token = localStorage.getItem("umaAccessToken");
  if (token) headers.set("Authorization", `JWTBearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    throw new ExtensionError({
      code: "AUTH_REQUIRED",
      message: "Требуется вход в аккаунт Premier",
    });
  }
  if (!response.ok) {
    throw new ExtensionError({
      code: response.status === 429 ? "RATE_LIMITED" : "MEDIA_UNAVAILABLE",
      message: `Premier request failed (${response.status})`,
    });
  }

  const data: unknown = await response.json();
  const errorResponse = errorResponseSchema.safeParse(data);
  if (errorResponse.success) {
    throw new ExtensionError({
      code: "MEDIA_UNAVAILABLE",
      message: errorResponse.data.message || "Premier request failed",
    });
  }
  return schema.parse(data);
};

export const fetchTitleMetainfo = (slug: string) => request(ROUTES.metainfo(slug), contentMetadataSchema);

export const fetchSeasonMetainfo = (slug: string) => request(ROUTES.season(slug), seasonMetadataSchema);

export const fetchVideoInfo = async (slug: string, type: "movie" | "series", season: number) => {
  if (type === "movie") {
    return (await request(ROUTES.videoinfo(slug), videoInfoResponseSchema)).results;
  }

  let page = 1;
  const results: z.output<typeof videoInfoResponseSchema>["results"] = [];
  while (true) {
    const url = new URL(ROUTES.videoinfo(slug));
    url.search = new URLSearchParams({
      page: String(page),
      limit: "100",
      season: String(season),
    }).toString();
    const response = await request(url, videoInfoResponseSchema);
    results.push(...response.results);
    if (!response.has_next) return results;
    page++;
  }
};

export const fetchPlayOptions = (contentId: string) => request(ROUTES.playOptions(contentId), playOptionsSchema);
