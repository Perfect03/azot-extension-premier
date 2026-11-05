import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { HLS, type MediaEntry } from "azot/v2";
import * as Azot from "azot/v2";
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

test.each([400, 401, 403, 429, 500])("reports Premier license HTTP %i without an Azot account error", async (status) => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
    }),
  );
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  try {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));

    await expect(
      requestLicense({ system: "widevine", resource, data: new Uint8Array([1]), options: {} }),
    ).rejects.toMatchObject({
      code: "UNKNOWN",
      message: `Premier license request failed (${status})`,
      operation: "requestLicense",
      details: { contentId: "video-id", status, requestBytes: 1, responseBody: "" },
      cause: expect.any(Error),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    resource.input.dispose();
  }
});

const restrictionFailure = () => Response.json({
  status: 400,
  title: "Failed to get license restrictions",
  detail: "Remote server is not available or returned error code",
}, { status: 400 });

test("retries Premier's transient restriction lookup using the same license URL and challenge", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
  }));
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  const sleep = vi.spyOn(Azot, "sleep").mockResolvedValue();
  const challenge = new Uint8Array([1, 2, 3]);
  const license = new Uint8Array([4, 5, 6]);
  fetchMock.mockResolvedValueOnce(restrictionFailure())
    .mockResolvedValueOnce(restrictionFailure())
    .mockResolvedValueOnce(new Response(license));
  try {
    expect(await requestLicense({ system: "widevine", resource, data: challenge, options: {} }))
      .toEqual(license);
    expect(fetchMock.mock.calls.slice(1)).toEqual(Array.from({ length: 3 }, () => [
      licenseUrl, expect.objectContaining({ method: "POST", body: challenge }),
    ]));
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  } finally {
    resource.input.dispose();
  }
});

test("keeps the last provider diagnostics after five failed restriction lookups", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
  }));
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  const sleep = vi.spyOn(Azot, "sleep").mockResolvedValue();
  fetchMock.mockImplementation(async () => restrictionFailure());
  try {
    await expect(requestLicense({ system: "widevine", resource, data: new Uint8Array([1]), options: {} }))
      .rejects.toMatchObject({
        code: "UNKNOWN", message: "Premier license request failed (400)",
        details: { responseBody: { title: "Failed to get license restrictions" } },
      });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls).toEqual([[1000], [2000], [4000], [8000]]);
  } finally {
    resource.input.dispose();
  }
});

test("does not retry a restriction response with a different provider reason", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
  }));
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  const sleep = vi.spyOn(Azot, "sleep");
  fetchMock.mockResolvedValueOnce(Response.json({
    title: "Failed to get license restrictions", detail: "Access denied",
  }, { status: 400 }));
  try {
    await expect(requestLicense({ system: "widevine", resource, data: new Uint8Array([1]), options: {} }))
      .rejects.toMatchObject({ code: "UNKNOWN", message: "Premier license request failed (400)" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  } finally {
    resource.input.dispose();
  }
});

test("cancels a license retry during backoff", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
  }));
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  const controller = new AbortController();
  const delayStarted = Promise.withResolvers<void>();
  vi.spyOn(Azot, "sleep").mockImplementation(() => {
    delayStarted.resolve();
    return new Promise(() => {});
  });
  fetchMock.mockResolvedValueOnce(restrictionFailure());
  try {
    const request = requestLicense({
      system: "widevine", resource, data: new Uint8Array([1]), options: {}, signal: controller.signal,
    });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await delayStarted.promise;
    controller.abort();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    resource.input.dispose();
  }
});

test.each([
  { licenseUrl: undefined, message: "Premier license URL is missing" },
  { licenseUrl, message: "Premier license response is invalid" },
])("reports $message without an Azot account error", async ({ licenseUrl, message }) => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: manifestUrl, license_url: licenseUrl } },
    }),
  );
  const resource = await resolveEntry({ url: pageUrl, options: {}, entry });
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Invalid license" }));

    await expect(
      requestLicense({ system: "widevine", resource, data: new Uint8Array([1]), options: {} }),
    ).rejects.toMatchObject({
      code: "UNKNOWN", message, operation: "requestLicense",
      ...(licenseUrl ? {
        details: { contentId: "video-id", status: 200, responseBody: { error: "Invalid license" } },
        cause: expect.any(Error),
      } : {}),
    });
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
