import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "azot/vitest";
import * as Azot from "azot";
import extension from "../main.ts";
import { resolveLicenseResponse } from "./drm.ts";
import { ROUTES } from "./constants.ts";

const { resolve } = extension.premier;

const entry = { id: "video-id", title: "Test movie", data: { contentId: "video-id" } };
const licenseUrl = "https://license.example.test/widevine";

afterEach(() => vi.restoreAllMocks());

test("resolves the default source without a license", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      video_balancer: { default: "https://cdn.example.test/master.m3u8" },
      extended_balancer: {
        dash: { balancer_url: "https://unused.test/manifest.mpd", license_url: licenseUrl },
      },
    }),
  );
  localStorage.setItem("umaAccessToken", "uma-access-token");

  const resource = await invoke(() => resolve({ entry, options: {} }));

  expect(resource.source).toEqual({ url: "https://cdn.example.test/master.m3u8" });
  expect(resource.resolveKeys).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith(ROUTES.playOptions("video-id"), expect.any(Object));
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
    "JWTBearer uma-access-token",
  );
});

test("resolves the DASH source with a key resolver when no default source exists", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: "https://cdn.example.test/manifest.mpd", license_url: licenseUrl } },
    }),
  );

  const resource = await invoke(() => resolve({ entry, options: {} }));

  expect(resource.source).toEqual({ url: "https://cdn.example.test/manifest.mpd" });
  expect(resource.resolveKeys).toBeTypeOf("function");
});

test("skips key resolution when the manifest has no PSSH boxes", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      extended_balancer: { dash: { balancer_url: "https://cdn.example.test/manifest.mpd", license_url: licenseUrl } },
    }),
  );
  const resource = await invoke(() => resolve({ entry, options: {} }));

  expect(await resource.resolveKeys!({ keyIds: [] })).toEqual([]);
});

test("reports the service error when playback is unavailable", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ detail: { languages: [{ title: "Требуется подписка" }] } }),
  );

  await expect(invoke(() => resolve({ entry, options: {} }))).rejects.toMatchObject({
    code: "MEDIA_UNAVAILABLE",
    message: "Требуется подписка",
  });
});

const restrictionFailure = () =>
  Response.json(
    {
      status: 400,
      title: "Failed to get license restrictions",
      detail: "Remote server is not available or returned error code",
    },
    { status: 400 },
  );

test("retries Premier's transient restriction lookup using the same license URL and challenge", async () => {
  const sleep = vi.spyOn(Azot, "sleep").mockResolvedValue();
  const license = new Uint8Array([4, 5, 6]);
  const retry = vi
    .fn()
    .mockResolvedValueOnce(restrictionFailure())
    .mockResolvedValueOnce(new Response(license));

  const result = await invoke(() => resolveLicenseResponse(restrictionFailure(), retry, "video-id"));

  expect(result).toEqual(license);
  expect(retry).toHaveBeenCalledTimes(2);
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
});

test("keeps the last provider diagnostics after five failed restriction lookups", async () => {
  const sleep = vi.spyOn(Azot, "sleep").mockResolvedValue();
  const retry = vi.fn().mockImplementation(async () => restrictionFailure());

  await expect(
    invoke(() => resolveLicenseResponse(restrictionFailure(), retry, "video-id")),
  ).rejects.toMatchObject({
    code: "KEY_UNAVAILABLE",
    message: "Premier license request failed (400)",
    cause: new Error(
      JSON.stringify({
        contentId: "video-id",
        status: 400,
        title: "Failed to get license restrictions",
        detail: "Remote server is not available or returned error code",
      }),
    ),
  });
  expect(retry).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls).toEqual([[1000], [2000], [4000], [8000]]);
});

test("does not retry a restriction response with a different provider reason", async () => {
  const sleep = vi.spyOn(Azot, "sleep");
  const retry = vi.fn();
  const response = Response.json(
    { title: "Failed to get license restrictions", detail: "Access denied" },
    { status: 400 },
  );

  await expect(
    invoke(() => resolveLicenseResponse(response, retry, "video-id")),
  ).rejects.toMatchObject({ code: "KEY_UNAVAILABLE", message: "Premier license request failed (400)" });
  expect(retry).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});

test("cancels a license retry during backoff", async () => {
  const controller = new AbortController();
  const delayStarted = Promise.withResolvers<void>();
  vi.spyOn(Azot, "sleep").mockImplementation(() => {
    delayStarted.resolve();
    return new Promise(() => {});
  });
  const retry = vi.fn();

  const result = invoke(
    () => resolveLicenseResponse(restrictionFailure(), retry, "video-id"),
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await delayStarted.promise;
  controller.abort();
  await rejected;
  expect(retry).not.toHaveBeenCalled();
});

test("logs only redacted provider reasons and content ID", async () => {
  const response = Response.json(
    {
      title: "Access denied",
      detail: "Rejected https://license.test/?sign=secret-signature Bearer secret-token",
      token: "private-token",
      license: "private-license",
    },
    { status: 403 },
  );

  await expect(
    invoke(() => resolveLicenseResponse(response, vi.fn(), "video-id")),
  ).rejects.toMatchObject({
    code: "KEY_UNAVAILABLE",
    cause: new Error(
      JSON.stringify({
        contentId: "video-id",
        status: 403,
        title: "Access denied",
        detail: "Rejected [redacted] [redacted]",
      }),
    ),
  });
});

test("decodes the JSON license wrapper handled by the legacy host", async () => {
  const response = Response.json({ license: "CAISBAUG" });

  expect(await invoke(() => resolveLicenseResponse(response, vi.fn(), "video-id"))).toEqual(
    Uint8Array.fromBase64("CAISBAUG"),
  );
});

test.each([400, 401, 403, 429, 500])(
  "reports Premier license HTTP %i without an Azot account error",
  async (status) => {
    const response = new Response(null, { status });

    await expect(
      invoke(() => resolveLicenseResponse(response, vi.fn(), "video-id")),
    ).rejects.toMatchObject({
      code: "KEY_UNAVAILABLE",
      message: `Premier license request failed (${status})`,
      cause: expect.any(Error),
    });
  },
);
