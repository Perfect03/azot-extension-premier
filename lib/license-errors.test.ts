import { afterEach, expect, test, vi } from "vitest";
import { createLicenseError } from "./license-errors.ts";

const licenseUrl = "https://license.example.test/widevine?data=signed-data&sign=secret-signature";
const createError = (response: Response) => createLicenseError({
  message: `Premier license request failed (${response.status})`,
  response,
  contentId: "episode-1",
  licenseUrl,
  requestBytes: 2196,
});

afterEach(() => vi.restoreAllMocks());

test("preserves provider errors and request IDs in the exported error cause", async () => {
  const error = await createError(Response.json({
    code: "INVALID_SIGNATURE",
    message: "License signature has expired",
  }, { status: 400, headers: { "x-request-id": "provider-request-123" } }));

  expect(error.details).toMatchObject({
    contentId: "episode-1",
    licenseOrigin: "https://license.example.test",
    licenseSystem: "widevine",
    status: 400,
    requestBytes: 2196,
    headers: { "x-request-id": "provider-request-123" },
    responseBody: { code: "INVALID_SIGNATURE", message: "License signature has expired" },
    responseTruncated: false,
    responseReadFailed: false,
  });
  expect(error.cause).toBeInstanceOf(Error);
  expect(String(error.cause)).toContain(JSON.stringify(error.details));
  expect(error.message).toBe("Premier license request failed (400)");
});

test("redacts nested credentials, signed URLs and stored tokens", async () => {
  localStorage.setItem("umaAccessToken", "stored-access-token");
  const error = await createError(Response.json({
    code: "BAD_REQUEST",
    message: `Rejected stored-access-token at ${licenseUrl}`,
    extra: [{ authorization: "Bearer bearer-secret", refresh_token: "refresh-secret" }],
    license: "CAIS-sensitive-license",
    challenge: "sensitive-challenge",
    url: "https://other.test/widevine?token=url-secret",
  }, { status: 400, headers: { "set-cookie": "session=cookie-secret" } }));

  const output = JSON.stringify(error.details) + String(error.cause);
  for (const secret of [
    "stored-access-token", "signed-data", "secret-signature", "bearer-secret",
    "refresh-secret", "CAIS-sensitive-license", "sensitive-challenge", "url-secret", "cookie-secret",
  ]) expect(output).not.toContain(secret);
  expect(output).toContain("BAD_REQUEST");
  expect(output).toContain("[redacted]");
});

test.each([
  'Rejected: token=plain-secret; Authorization: Bearer auth-secret',
  '<html>Denied https://license.test/?sign=plain-secret cookie="cookie-secret"</html>',
  '{"message":"Denied", "access_token":"plain-secret',
])("sanitizes plain text, HTML and incomplete JSON: %s", async (body) => {
  const error = await createError(new Response(body, { status: 400 }));
  const output = JSON.stringify(error.details) + String(error.cause);
  for (const secret of ["plain-secret", "auth-secret", "cookie-secret"]) {
    expect(output).not.toContain(secret);
  }
  expect(output).toMatch(/Rejected|Denied/);
});

test("bounds response reads and cancels the remaining stream", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Upstream failure. ".repeat(1000)));
    },
    cancel,
  });
  const error = await createError(new Response(body, { status: 502 }));

  expect(error.details).toMatchObject({ responseTruncated: true, responseReadFailed: false });
  expect(JSON.stringify(error.details).length).toBeLessThan(9000);
  expect(cancel).toHaveBeenCalledOnce();
});

test("keeps the HTTP error when its response stream fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("upstream connection reset"));
    },
  });
  const error = await createError(new Response(body, { status: 400 }));
  expect(error.message).toBe("Premier license request failed (400)");
  expect(error.details).toMatchObject({ status: 400, responseReadFailed: true });
});
