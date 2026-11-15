import { abortable, ExtensionError, sleep, z } from "azot";
import { EME } from "eme";
import type { KeyRequest } from "azot";

const LICENSE_REQUEST_ATTEMPTS = 5;

const licenseProblemSchema = z.object({
  title: z.string().max(512).optional(),
  detail: z.string().max(512).optional(),
});

const redactLicenseReason = (reason: string) =>
  reason
    .replace(/https?:\/\/\S+|\b(?:Bearer|JWTBearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:token|password|secret|cookie|signature)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]");

/** Retries Premier's transient license-restriction failures and unwraps the legacy host's
 * JSON-wrapped base64 license. `retry` resends the same license request; `response` is the
 * result already produced by the first attempt.
 */
export const resolveLicenseResponse = async (
  response: Response,
  retry: () => Promise<Response>,
  contentId: string | undefined,
): Promise<Uint8Array> => {
  for (let attempt = 1; !response.ok; attempt++) {
    const parsed = licenseProblemSchema.safeParse(await response.json().catch(() => null));
    const problem = parsed.success ? parsed.data : {};
    const isTransient = response.status === 400
      && problem.title === "Failed to get license restrictions"
      && problem.detail === "Remote server is not available or returned error code";
    if (!isTransient || attempt >= LICENSE_REQUEST_ATTEMPTS) {
      throw new ExtensionError({
        code: "KEY_UNAVAILABLE",
        message: `Premier license request failed (${response.status})`,
        // The host includes causes in exported logs, but skips extension-specific details.
        cause: new Error(JSON.stringify({
          contentId,
          status: response.status,
          title: problem.title && redactLicenseReason(problem.title),
          detail: problem.detail && redactLicenseReason(problem.detail),
        })),
      });
    }
    await abortable(sleep(2 ** (attempt - 1) * 1000), Azot.signal);
    response = await retry();
  }

  const license = new Uint8Array(await response.arrayBuffer());
  if (license[0] !== 0x7b) return license;

  // The legacy host also decoded base64 Widevine licenses wrapped in JSON responses.
  const encodedLicense = new TextDecoder()
    .decode(license)
    .match(/"(CAIS[A-Za-z0-9+/=]*)"/)?.[1];
  if (!encodedLicense) {
    throw new ExtensionError({ code: "KEY_UNAVAILABLE", message: "Premier license response is invalid" });
  }
  return Uint8Array.fromBase64(encodedLicense);
};

/** Resolves Widevine keys through the `eme` peer extension, routing the license exchange
 * through resolveLicenseResponse() for Premier's retry/legacy-format handling.
 */
export const resolveWidevineKeys = (licenseUrl: string, contentId: string | undefined) => async ({ psshBoxes }: KeyRequest) => {
  if (!psshBoxes?.length) return [];

  await using eme = new EME();
  let lastRequest: Request | undefined;
  eme.registerRequestFilter((type, request) => {
    if (type === "license") lastRequest = request.clone();
  });
  eme.registerResponseFilter(async (type, response) => {
    if (type !== "license") return;
    const license = await resolveLicenseResponse(
      response,
      () => fetch(lastRequest!.clone()),
      contentId,
    );
    return new Response(license as BodyInit);
  });
  await eme.configure({ servers: { "com.widevine.alpha": licenseUrl } });
  await eme.load(psshBoxes);
  return new Map(Object.entries(await eme.getKeys()));
};
