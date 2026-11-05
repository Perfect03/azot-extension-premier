import { ExtensionError, z, type JsonValue } from "azot/v2";

const MAX_RESPONSE_BYTES = 8_192;
const SENSITIVE_FIELD =
  /authorization|cookie|token|secret|password|signature|license|challenge|pssh|key|credential|session/i;
const jsonSchema = z.json();
const transientRestrictionErrorSchema = z.object({
  status: z.literal(400),
  responseBody: z.object({
    title: z.literal("Failed to get license restrictions"),
    detail: z.literal("Remote server is not available or returned error code"),
  }),
});

/** Premier reports this upstream outage as HTTP 400; replaying the same challenge can succeed. */
export const isTransientLicenseError = (error: ExtensionError) =>
  transientRestrictionErrorSchema.safeParse(error.details).success;

const sanitizeText = (text: string, secrets: string[]) => {
  for (const secret of secrets) {
    text = text.replaceAll(secret, "[redacted]");
    text = text.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return text
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|JWTBearer|Basic)\s+[^\s"'<>]+/gi, "[redacted authorization]")
    .replace(/\b[\w-]*(?:token|secret|password|cookie|signature|license|challenge|pssh|key|credential|session)[\w-]*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;<>]+)/gi, "[redacted field]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[redacted JWT]")
    .replace(/[A-Za-z0-9+/_=-]{80,}/g, "[redacted data]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
};

const sanitizeJson = (value: JsonValue, secrets: string[], depth = 0): JsonValue => {
  if (depth > 8) return "[nested data omitted]";
  if (typeof value === "string") return sanitizeText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeText(key, secrets),
        SENSITIVE_FIELD.test(key) ? "[redacted]" : sanitizeJson(item, secrets, depth + 1),
      ]),
    );
  }
  return value;
};

const sanitizeBody = (text: string, secrets: string[]) => {
  try {
    const parsed: unknown = JSON.parse(text);
    const result = jsonSchema.safeParse(parsed);
    if (result.success) return sanitizeJson(result.data, secrets);
  } catch {
    // Non-JSON and truncated responses still contain useful error messages.
  }
  return sanitizeText(text, secrets);
};

/** Reads only a small sample, cancelling the rest of an upstream error page. */
const readResponseSample = async (response: Response) => {
  const reader = response.body?.getReader();
  const sample = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  let readFailed = false;
  try {
    while (reader && size < sample.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, sample.length - size);
      sample.set(chunk, size);
      size += chunk.length;
    }
  } catch {
    readFailed = true;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return { bytes: sample.subarray(0, size), truncated: size === MAX_RESPONSE_BYTES, readFailed };
};

/** Keeps provider diagnostics in the cause, which the host includes in exported DRM logs. */
export const createLicenseError = async ({
  message,
  response,
  contentId,
  licenseUrl,
  requestBytes,
  body,
}: {
  message: string;
  response: Response;
  contentId: string | undefined;
  licenseUrl: string;
  requestBytes: number;
  body?: Uint8Array;
}) => {
  const secrets = [
    licenseUrl,
    ...["accessToken", "refreshToken", "umaAccessToken", "umaRefreshToken"].flatMap((key) => {
      const value = localStorage.getItem(key);
      return value ? [value] : [];
    }),
  ];
  const sample = body
    ? {
        bytes: body.subarray(0, MAX_RESPONSE_BYTES),
        truncated: body.length > MAX_RESPONSE_BYTES,
        readFailed: false,
      }
    : await readResponseSample(response);
  const headers = Object.fromEntries([
    "content-type", "x-request-id", "request-id", "x-correlation-id", "cf-ray", "retry-after",
  ].flatMap((name) => {
    const value = response.headers.get(name);
    return value ? [[name, sanitizeText(value.slice(0, 256), secrets)]] : [];
  }));
  const endpoint = new URL(licenseUrl);
  const details = {
    contentId: contentId ?? null,
    licenseOrigin: endpoint.origin,
    licenseSystem: ["widevine", "playready", "fairplay"].find((system) =>
      endpoint.pathname.toLowerCase().includes(system)) ?? "unknown",
    status: response.status,
    requestBytes,
    headers,
    responseBody: sanitizeBody(new TextDecoder().decode(sample.bytes), secrets),
    responseTruncated: sample.truncated,
    responseReadFailed: sample.readFailed,
  };
  return new ExtensionError({
    code: "UNKNOWN",
    message,
    operation: "requestLicense",
    details,
    cause: new Error(`Premier license diagnostics: ${JSON.stringify(details)}`),
  });
};
