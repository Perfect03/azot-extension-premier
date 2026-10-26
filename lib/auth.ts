import { abortable, confirm, ExtensionError, z, type AuthRequest } from "azot/v2";
import { request } from "./api.ts";
import { ROUTES, DEVICE } from "./constants.ts";

const registrationSchema = z.object({ result: z.object({ activationCode: z.string().min(1) }) });
const activationSchema = z.object({
  result: z.discriminatedUnion("isActivated", [
    z.object({ isActivated: z.literal(false) }),
    z.object({
      isActivated: z.literal(true),
      device: z.object({
        accessTokenExpiredAt: z.string(),
        accessToken: z.string().min(1),
        refreshToken: z.string(),
        umaTokens: z.object({ accessToken: z.string().min(1), refreshToken: z.string() }),
        id: z.union([z.string(), z.number()]),
      }),
      user: z.object({ username: z.string().optional() }).optional(),
    }),
  ]),
});

export const getAuthState = () => ({
  authenticated: Boolean(
    localStorage.getItem("accessToken") &&
    localStorage.getItem("umaAccessToken") &&
    Date.parse(localStorage.getItem("expiresAt") ?? "") > Date.now(),
  ),
  user: localStorage.getItem("username") ?? undefined,
});

export const signOut = () => {
  for (const key of [
    "expiresAt",
    "accessToken",
    "refreshToken",
    "umaAccessToken",
    "umaRefreshToken",
    "deviceId",
    "username",
  ]) {
    localStorage.removeItem(key);
  }
};

/** Pairs a TV device only when the host explicitly requests interactive login. */
export const signIn = async ({ method, signal }: AuthRequest) => {
  signal?.throwIfAborted();
  if (method !== "interactive") {
    throw new Error("Premier supports interactive device login only");
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const registration = await request(ROUTES.smartRegister, registrationSchema, {
      method: "POST",
      body: JSON.stringify(DEVICE),
      signal,
    });
    const code = registration.result.activationCode;
    const confirmed = await abortable(
      confirm(`Введите код ${code} на https://premier.one/profile/tv`, {
        title: "Вход в Premier",
        primaryAction: { title: "Устройство подключено" },
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (!confirmed) throw new DOMException("Premier sign-in was cancelled", "AbortError");

    const { result } = await request(ROUTES.smartCheck(code), activationSchema, { signal });
    signal?.throwIfAborted();
    if (!result.isActivated) continue;

    const values = {
      expiresAt: result.device.accessTokenExpiredAt,
      accessToken: result.device.accessToken,
      refreshToken: result.device.refreshToken,
      umaAccessToken: result.device.umaTokens.accessToken,
      umaRefreshToken: result.device.umaTokens.refreshToken,
      deviceId: String(result.device.id),
    };
    signOut();
    for (const item of Object.entries(values)) localStorage.setItem(item[0], item[1]);
    if (result.user?.username) localStorage.setItem("username", result.user.username);
    return;
  }

  throw new ExtensionError({
    code: "AUTH_REQUIRED",
    message: "Не удалось активировать устройство Premier после 10 попыток",
  });
};
