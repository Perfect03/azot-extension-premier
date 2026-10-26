import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { HLS, type MediaEntry } from "azot/v2";
import extension from "../main.ts";
import { ROUTES } from "./constants.ts";

const resolveEntry = extension.resolveEntry;
const requestLicense = extension.drm?.requestLicense;
if (!resolveEntry || !requestLicense) throw new Error("Premier playback hooks are missing");

const entry = { id: "video-id", type: "movie", title: "Test movie" } satisfies MediaEntry;
const pageUrl = "https://premier.one/show/test-movie";
const licenseUrl = "https://license.example.test/widevine";
const mediaServer = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nvideo.m3u8\n");
});
let manifestUrl = "";

beforeAll(async () => {
  mediaServer.listen(0, "127.0.0.1");
  await once(mediaServer, "listening");
  const address = mediaServer.address();
  if (!address || typeof address === "string")
    throw new Error("Media fixture server did not start");
  manifestUrl = `http://127.0.0.1:${address.port}/master.m3u8`;
});

afterAll(async () => {
  mediaServer.close();
  mediaServer.closeAllConnections();
  await once(mediaServer, "close");
});

afterEach(() => vi.restoreAllMocks());

test.each(["default", "drm"])("opens the %s source with the real media input", async (kind) => {
  const playback =
    kind === "default"
      ? {
          video_balancer: { default: manifestUrl },
          extended_balancer: {
            dash: { balancer_url: "https://unused.test/manifest.mpd", license_url: licenseUrl },
          },
        }
      : { extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } } };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(playback));
  const signal = new AbortController().signal;
  localStorage.setItem("umaAccessToken", "uma-access-token");

  const resource = await resolveEntry({ url: pageUrl, options: {}, entry, signal });
  try {
    expect(await resource.input.getFormat()).toBe(HLS);
    expect(resource.entry.context?.licenseUrl).toBe(kind === "drm" ? licenseUrl : undefined);
    expect(entry).not.toHaveProperty("context");
    expect(fetchMock).toHaveBeenCalledWith(
      ROUTES.playOptions("video-id"),
      expect.objectContaining({ signal }),
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "JWTBearer uma-access-token",
    );

    if (kind === "drm") {
      const challenge = new Uint8Array([1, 2, 3]);
      const license = new Uint8Array([4, 5, 6]);
      fetchMock.mockResolvedValueOnce(new Response(license));

      expect(
        await requestLicense({
          system: "widevine",
          resource,
          data: challenge,
          options: {},
          signal,
        }),
      ).toEqual(license);
      expect(fetchMock).toHaveBeenLastCalledWith(
        licenseUrl,
        expect.objectContaining({
          method: "POST",
          body: challenge,
          signal,
        }),
      );
    }
  } finally {
    resource.input.dispose();
  }
});

test("reports the service error when playback is unavailable", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      detail: { languages: [{ title: "Требуется подписка" }] },
    }),
  );

  await expect(resolveEntry({ url: pageUrl, options: {}, entry })).rejects.toMatchObject({
    code: "MEDIA_UNAVAILABLE",
    message: "Требуется подписка",
  });
});

test("rejects an unsuccessful license response", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
    }),
  );
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  try {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(
      requestLicense({ system: "widevine", resource, data: new Uint8Array([1]), options: {} }),
    ).rejects.toMatchObject({ code: "DRM_UNAUTHORIZED", operation: "requestLicense" });
  } finally {
    resource.input.dispose();
  }
});

test("decodes the JSON license wrapper handled by the legacy host", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
    }),
  );
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ license: "CAISBAUG" }));

    expect(
      await requestLicense({
        system: "widevine",
        resource,
        data: new Uint8Array([1]),
        options: {},
      }),
    ).toEqual(Uint8Array.fromBase64("CAISBAUG"));
  } finally {
    resource.input.dispose();
  }
});
